import { randomUUID } from "node:crypto";
import type { BrainProvider } from "../brain/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { HandProvider } from "../hands/types.ts";
import { persistBrainBindingPg, persistHandBindingPg } from "../meta-harness/postgres-bindings.ts";
import type { SessionStore } from "../session/types.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

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
      const recoveryDecisionId = `recovery-decision-${randomUUID()}`;
      await upsertRuntimeResourcePg(deps.db, {
        id: recoveryDecisionId,
        resourceType: "recovery_decision",
        resourceKey: recoveryDecisionId,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        scope: "recovery",
        status: "recorded",
        title: `Recovery decision: ${input.strategy}`,
        payload: {
          schemaVersion: "southstar.managed-recovery-decision.v1",
          recoveryDecisionId,
          runId: input.runId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          strategy: input.strategy,
          reason: input.reason,
        },
        summary: { strategy: input.strategy, reason: input.reason },
      });

      const decisionEvent = await deps.sessionStore.emitEvent({
        eventType: "recovery.decision_recorded",
        actorType: "orchestrator",
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        payload: { recoveryDecisionId, strategy: input.strategy, reason: input.reason },
      });

      const toSequence = await maxSessionSequence(deps.db, input.runId, input.sessionId, decisionEvent.sequence);
      const checkpoint = await deps.sessionStore.createCheckpoint({
        id: `checkpoint-${input.runId}-${input.taskId}-before-recovery-${randomUUID()}`,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        checkpointType: "before-recovery",
        summary: `Before recovery ${input.strategy}: ${input.reason}`,
        eventRange: { fromSequence: toSequence > 0 ? 1 : 0, toSequence },
        refs: {
          recoveryDecisionIds: [recoveryDecisionId],
          ...(input.contextPacketId ? { contextPacketIds: [input.contextPacketId] } : {}),
        },
        metrics: { strategy: input.strategy },
      });

      const brainBindingId = isBrainStrategy(input.strategy)
        ? await wakeAndPersistBrain(deps, input, checkpoint.id)
        : undefined;
      const handBindingId = isHandStrategy(input.strategy)
        ? await provisionAndPersistHand(deps, input)
        : undefined;

      const executionEvent = await deps.sessionStore.emitEvent({
        eventType: "recovery.execution_submitted",
        actorType: "orchestrator",
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        payload: {
          recoveryDecisionId,
          beforeRecoveryCheckpointId: checkpoint.id,
          strategy: input.strategy,
          brainBindingId,
          handBindingId,
        },
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

async function maxSessionSequence(db: SouthstarDb, runId: string, sessionId: string, fallback: number): Promise<number> {
  const row = await db.maybeOne<{ max_sequence: number | string | null }>(
    "select max(sequence) as max_sequence from southstar.workflow_history where run_id = $1 and session_id = $2",
    [runId, sessionId],
  );
  const value = Number(row?.max_sequence ?? fallback);
  return Number.isFinite(value) ? Math.max(value, fallback) : fallback;
}
