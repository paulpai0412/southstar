import { createHash } from "node:crypto";
import type { BrainProvider } from "../brain/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { HandProvider } from "../hands/types.ts";
import { persistBrainBindingPg, persistHandBindingPg } from "../meta-harness/postgres-bindings.ts";
import type { SessionStore } from "../session/types.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export type ManagedRecoveryStrategy =
  | "retry-same-brain"
  | "wake-new-brain"
  | "fork-brain-from-checkpoint"
  | "reset-from-checkpoint"
  | "reprovision-hand"
  | "rollback-hand-snapshot"
  | "host-native-rewind";

export type ManagedRecoveryInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  strategy: ManagedRecoveryStrategy;
  reason: string;
  contextPacketId?: string;
  handName?: string;
  handResources?: Record<string, unknown>;
  effortPolicy?: {
    complexity: "simple" | "standard" | "broad" | "deep";
    maxToolCallsPerTask: number;
  };
};

export type ManagedRecoveryResult = {
  strategy: ManagedRecoveryStrategy;
  recoveryDecisionId: string;
  beforeRecoveryCheckpointId: string;
  brainBindingId?: string;
  handBindingId?: string;
  executionEventId: string;
};

export type PostgresRecoveryControllerDeps = {
  db: SouthstarDb;
  sessionStore: SessionStore;
  brainProvider: BrainProvider;
  handProvider: HandProvider;
};

export function createPostgresRecoveryController(deps: PostgresRecoveryControllerDeps): {
  recover(input: ManagedRecoveryInput): Promise<ManagedRecoveryResult>;
} {
  return {
    async recover(input) {
      if (input.strategy === "host-native-rewind") {
        throw new Error("unsupported managed recovery strategy: host-native-rewind");
      }

      const recoveryKey = recoveryIdempotencyKey(input);
      const recoveryDecisionId = `recovery-decision-${stableHash(recoveryKey).slice(0, 24)}`;
      const existing = await getResourceByKeyPg(deps.db, "recovery_decision", recoveryKey);
      const existingResult = resultFromDecisionPayload(existing?.payload);
      if (existingResult) return existingResult;
      if (existing?.status === "failed") {
        const payload = asRecord(existing.payload);
        throw new Error(typeof payload.error === "string" ? payload.error : `managed recovery failed: ${recoveryKey}`);
      }

      const sequenceBeforeDecision = await maxSessionSequence(deps.db, input.runId, input.sessionId, 0);
      await upsertRuntimeResourcePg(deps.db, {
        id: recoveryDecisionId,
        resourceType: "recovery_decision",
        resourceKey: recoveryKey,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        scope: "recovery",
        status: "recorded",
        title: `Recovery decision: ${input.strategy}`,
        payload: {
          schemaVersion: "southstar.managed-recovery-decision.v1",
          recoveryDecisionId,
          recoveryKey,
          runId: input.runId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          strategy: input.strategy,
          reason: input.reason,
        },
        summary: { strategy: input.strategy, reason: input.reason },
      });

      await deps.sessionStore.emitEvent({
        eventType: "recovery.decision_recorded",
        actorType: "orchestrator",
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        idempotencyKey: `${recoveryKey}:decision-recorded`,
        payload: { recoveryDecisionId, recoveryKey, strategy: input.strategy, reason: input.reason, status: "recorded" },
      });

      const checkpoint = await deps.sessionStore.createCheckpoint({
        id: `checkpoint-${stableHash(`${recoveryKey}:before-recovery`).slice(0, 24)}`,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        resourceKey: `${recoveryKey}:before-recovery`,
        checkpointType: "before-recovery",
        summary: `Before recovery ${input.strategy}: ${input.reason}`,
        eventRange: { fromSequence: sequenceBeforeDecision > 0 ? 1 : 0, toSequence: sequenceBeforeDecision },
        refs: {
          recoveryDecisionIds: [recoveryDecisionId],
          ...(input.contextPacketId ? { contextPacketIds: [input.contextPacketId] } : {}),
        },
        metrics: { strategy: input.strategy },
      });

      let brainBindingId: string | undefined;
      let handBindingId: string | undefined;
      try {
        brainBindingId = isBrainStrategy(input.strategy)
          ? await wakeAndPersistBrain(deps, input, checkpoint.id)
          : undefined;
        handBindingId = isHandStrategy(input.strategy)
          ? await provisionAndPersistHand(deps, input)
          : undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordRecoveryFailure(deps, input, {
          recoveryDecisionId,
          recoveryKey,
          checkpointId: checkpoint.id,
          error: message,
        });
        throw error;
      }

      const executionEvent = await deps.sessionStore.emitEvent({
        eventType: "recovery.execution_submitted",
        actorType: "orchestrator",
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        idempotencyKey: `${recoveryKey}:execution-submitted`,
        payload: {
          recoveryDecisionId,
          recoveryKey,
          beforeRecoveryCheckpointId: checkpoint.id,
          strategy: input.strategy,
          brainBindingId,
          handBindingId,
        },
      });

      await upsertRuntimeResourcePg(deps.db, {
        id: recoveryDecisionId,
        resourceType: "recovery_decision",
        resourceKey: recoveryKey,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        scope: "recovery",
        status: "recorded",
        title: `Recovery decision: ${input.strategy}`,
        payload: {
          schemaVersion: "southstar.managed-recovery-decision.v1",
          recoveryDecisionId,
          recoveryKey,
          runId: input.runId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          strategy: input.strategy,
          reason: input.reason,
          beforeRecoveryCheckpointId: checkpoint.id,
          brainBindingId,
          handBindingId,
          executionEventId: executionEvent.id,
        },
        summary: { strategy: input.strategy, reason: input.reason, brainBindingId, handBindingId },
      });

      return {
        strategy: input.strategy,
        recoveryDecisionId,
        beforeRecoveryCheckpointId: checkpoint.id,
        brainBindingId,
        handBindingId,
        executionEventId: executionEvent.id,
      };
    },
  };
}

function isBrainStrategy(strategy: ManagedRecoveryStrategy): boolean {
  return strategy === "wake-new-brain"
    || strategy === "retry-same-brain"
    || strategy === "fork-brain-from-checkpoint"
    || strategy === "reset-from-checkpoint";
}

function isHandStrategy(strategy: ManagedRecoveryStrategy): boolean {
  return strategy === "reprovision-hand" || strategy === "rollback-hand-snapshot";
}

async function wakeAndPersistBrain(
  deps: PostgresRecoveryControllerDeps,
  input: ManagedRecoveryInput,
  checkpointId: string,
): Promise<string> {
  const binding = await deps.brainProvider.wake({
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    contextPacketId: input.contextPacketId ?? checkpointId,
    effortPolicy: input.effortPolicy ?? { complexity: "standard", maxToolCallsPerTask: 100 },
  });
  await persistBrainBindingPg(deps.db, binding);
  return binding.id;
}

async function provisionAndPersistHand(
  deps: PostgresRecoveryControllerDeps,
  input: ManagedRecoveryInput,
): Promise<string> {
  const binding = await deps.handProvider.provision({
    runId: input.runId,
    taskId: input.taskId,
    handName: input.handName ?? "workspace",
    resources: input.handResources ?? {},
  });
  await persistHandBindingPg(deps.db, binding);
  return binding.id;
}

async function recordRecoveryFailure(
  deps: PostgresRecoveryControllerDeps,
  input: ManagedRecoveryInput,
  failure: { recoveryDecisionId: string; recoveryKey: string; checkpointId: string; error: string },
): Promise<void> {
  await upsertRuntimeResourcePg(deps.db, {
    id: failure.recoveryDecisionId,
    resourceType: "recovery_decision",
    resourceKey: failure.recoveryKey,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "recovery",
    status: "failed",
    title: `Recovery decision failed: ${input.strategy}`,
    payload: {
      schemaVersion: "southstar.managed-recovery-decision.v1",
      recoveryDecisionId: failure.recoveryDecisionId,
      recoveryKey: failure.recoveryKey,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      strategy: input.strategy,
      reason: input.reason,
      beforeRecoveryCheckpointId: failure.checkpointId,
      error: failure.error,
    },
    summary: { strategy: input.strategy, reason: input.reason, error: failure.error },
  });
  await deps.sessionStore.emitEvent({
    eventType: "recovery.decision_recorded",
    actorType: "orchestrator",
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    idempotencyKey: `${failure.recoveryKey}:decision-failed`,
    payload: {
      recoveryDecisionId: failure.recoveryDecisionId,
      recoveryKey: failure.recoveryKey,
      strategy: input.strategy,
      reason: input.reason,
      status: "failed",
      error: failure.error,
    },
  });
}

async function maxSessionSequence(db: SouthstarDb, runId: string, sessionId: string, fallback: number): Promise<number> {
  const row = await db.maybeOne<{ max_sequence: number | string | null }>(
    "select max(sequence) as max_sequence from southstar.workflow_history where run_id = $1 and session_id = $2",
    [runId, sessionId],
  );
  const value = Number(row?.max_sequence ?? fallback);
  return Number.isFinite(value) ? Math.max(value, fallback) : fallback;
}

function recoveryIdempotencyKey(input: ManagedRecoveryInput): string {
  return [
    "managed-recovery",
    input.runId,
    input.taskId,
    input.sessionId,
    input.strategy,
    stableHash({
      reason: input.reason,
      contextPacketId: input.contextPacketId ?? null,
      handName: input.handName ?? null,
      handResources: input.handResources ?? null,
      effortPolicy: input.effortPolicy ?? null,
    }),
  ].join(":");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function resultFromDecisionPayload(value: unknown): ManagedRecoveryResult | null {
  const payload = asRecord(value);
  if (
    typeof payload.strategy !== "string"
    || typeof payload.recoveryDecisionId !== "string"
    || typeof payload.beforeRecoveryCheckpointId !== "string"
    || typeof payload.executionEventId !== "string"
  ) {
    return null;
  }
  return {
    strategy: payload.strategy as ManagedRecoveryStrategy,
    recoveryDecisionId: payload.recoveryDecisionId,
    beforeRecoveryCheckpointId: payload.beforeRecoveryCheckpointId,
    brainBindingId: typeof payload.brainBindingId === "string" ? payload.brainBindingId : undefined,
    handBindingId: typeof payload.handBindingId === "string" ? payload.handBindingId : undefined,
    executionEventId: payload.executionEventId,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
