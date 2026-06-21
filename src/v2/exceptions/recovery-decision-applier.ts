import type { SouthstarDb } from "../db/postgres.ts";
import {
  appendHistoryEventPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  type RuntimeResourceRecord,
} from "../stores/postgres-runtime-store.ts";
import { resolveRuntimeExceptionPg } from "./postgres-runtime-exceptions.ts";
import {
  completeRecoveryExecutionPg,
  recoveryExecutionResourceKey,
  startRecoveryExecutionPg,
} from "./recovery-executions.ts";
import {
  RECOVERY_DECISION_RESOURCE_TYPE,
  RUNTIME_EXCEPTION_RESOURCE_TYPE,
  type RecoveryDecisionPayload,
  type RecoveryDecisionStatus,
  type RecoveryExecutionProviderAction,
  type RecoveryExecutionStateChange,
  type RuntimeRecoveryDecisionRecord,
} from "./types.ts";

export type RecoveryDecisionApplyResult = {
  status: "applied" | "skipped" | "blocked" | "failed" | "superseded";
  executionResourceKey?: string;
  reason: string;
};

type RuntimeResourceRow = {
  id: string;
  resource_type: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  scope: string;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
  metrics_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
};

type RequeueMutationResult = {
  stateChanges: RecoveryExecutionStateChange[];
  providerActions: RecoveryExecutionProviderAction[];
  exceptionResourceKey: string;
};

export function createRecoveryDecisionApplier(deps: { db: SouthstarDb }): {
  applyNext(input?: { runId?: string; now?: string }): Promise<RecoveryDecisionApplyResult | null>;
  applyDecision(input: { decisionResourceKey: string; now?: string }): Promise<RecoveryDecisionApplyResult>;
} {
  return {
    async applyNext(input = {}) {
      const row = await deps.db.maybeOne<{ resource_key: string }>(
        `select resource_key
           from southstar.runtime_resources
          where resource_type = $1
            and status in ('recorded', 'approved', 'applying')
            and ($2::text is null or run_id = $2)
          order by created_at, resource_key
          limit 1`,
        [RECOVERY_DECISION_RESOURCE_TYPE, input.runId ?? null],
      );
      if (!row) return null;
      return await this.applyDecision({ decisionResourceKey: row.resource_key, now: input.now });
    },
    async applyDecision(input) {
      const now = input.now ?? new Date().toISOString();
      const decision = requireRecoveryDecision(
        await getResourceByKeyPg(deps.db, RECOVERY_DECISION_RESOURCE_TYPE, input.decisionResourceKey),
      );
      const executionResourceKey = recoveryExecutionResourceKey(decision.decisionId);

      if (decision.status === "applied") {
        return { status: "applied", executionResourceKey, reason: "decision already applied" };
      }
      if (decision.status === "waiting_operator_approval") {
        return { status: "skipped", reason: "decision waiting for operator approval" };
      }
      if (decision.status === "blocked" || decision.status === "failed" || decision.status === "superseded") {
        return { status: decision.status, reason: `decision already ${decision.status}` };
      }

      await claimRecoveryDecisionApplyingPg(deps.db, { decision, now });
      const applyingDecision: RuntimeRecoveryDecisionRecord = { ...decision, status: "applying" };

      const started = await startRecoveryExecutionPg(deps.db, {
        decisionId: decision.decisionId,
        exceptionId: decision.payload.exceptionId,
        runId: decision.payload.runId,
        taskId: decision.payload.taskId,
        path: decision.payload.path,
        now,
      });

      if (decision.payload.path !== "requeue-hand-execution") {
        await blockDecision(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          reason: `unsupported recovery path ${decision.payload.path}`,
        });
        return { status: "blocked", executionResourceKey: started.resourceKey, reason: `unsupported recovery path ${decision.payload.path}` };
      }

      if (!decision.payload.taskId) {
        await blockDecision(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          reason: "requeue-hand-execution decision missing taskId",
        });
        return { status: "blocked", executionResourceKey: started.resourceKey, reason: "requeue-hand-execution decision missing taskId" };
      }

      if (!decision.payload.handExecutionId) {
        await blockDecision(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          reason: "requeue-hand-execution decision missing handExecutionId",
        });
        return { status: "blocked", executionResourceKey: started.resourceKey, reason: "requeue-hand-execution decision missing handExecutionId" };
      }

      if (started.status !== "started") {
        if (started.status === "succeeded") {
          await finalizeRecoveryDecisionAppliedPg(deps.db, { decision: applyingDecision, executionResourceKey: started.resourceKey, now });
          return { status: "applied", executionResourceKey: started.resourceKey, reason: "requeue-hand-execution applied" };
        }
        return { status: started.status, executionResourceKey: started.resourceKey, reason: `recovery execution already ${started.status}` };
      }

      let mutation: RequeueMutationResult;
      try {
        mutation = await applyRequeueMutation(deps.db, { decision: applyingDecision, now });
      } catch (error) {
        if (error instanceof Error && error.message === `hand execution ${decision.payload.handExecutionId} not found`) {
          await blockDecision(deps.db, {
            decision: applyingDecision,
            executionResourceKey: started.resourceKey,
            now,
            reason: error.message,
          });
          return { status: "blocked", executionResourceKey: started.resourceKey, reason: error.message };
        }
        throw error;
      }
      await resolveRuntimeExceptionPg(deps.db, {
        runId: decision.payload.runId,
        resourceKey: mutation.exceptionResourceKey,
        resolvedAt: now,
        reason: "requeue-hand-execution applied",
      });
      mutation.stateChanges.push({
        resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
        resourceKey: mutation.exceptionResourceKey,
        fromStatus: "observed",
        toStatus: "resolved",
        reason: "requeue-hand-execution applied",
      });

      await completeRecoveryExecutionPg(deps.db, {
        runId: decision.payload.runId,
        executionResourceKey: started.resourceKey,
        status: "succeeded",
        completedAt: now,
        stateChanges: mutation.stateChanges,
        providerActions: mutation.providerActions,
      });
      await finalizeRecoveryDecisionAppliedPg(deps.db, { decision, executionResourceKey: started.resourceKey, now });

      return { status: "applied", executionResourceKey: started.resourceKey, reason: "requeue-hand-execution applied" };
    },
  };
}

async function applyRequeueMutation(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; now: string },
): Promise<RequeueMutationResult> {
  return await db.tx(async (tx) => {
    const { decision, now } = input;
    const taskId = requireString(decision.payload.taskId, "taskId");
    const handExecutionId = requireString(decision.payload.handExecutionId, "handExecutionId");

    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [decision.payload.runId]);
    const task = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [decision.payload.runId, taskId],
    );
    if (!task) throw new Error(`workflow task ${taskId} does not belong to run ${decision.payload.runId}`);

    const hand = mapRuntimeResourceRow(await tx.maybeOne<RuntimeResourceRow>(
      `select * from southstar.runtime_resources
        where resource_type = 'hand_execution'
          and resource_key = $1
        for update`,
      [handExecutionId],
    ));
    if (!hand) {
      throw new Error(`hand execution ${handExecutionId} not found`);
    }

    const exception = mapRuntimeResourceRow(await tx.maybeOne<RuntimeResourceRow>(
      `select * from southstar.runtime_resources
        where resource_type = $1
          and run_id = $2
          and payload_json->>'exceptionId' = $3
        for update`,
      [RUNTIME_EXCEPTION_RESOURCE_TYPE, decision.payload.runId, decision.payload.exceptionId],
    ));
    if (!exception) throw new Error(`runtime exception ${decision.payload.exceptionId} not found`);

    const handPayload = hand.payload as Record<string, unknown>;
    const providerId = typeof handPayload.providerId === "string" ? handPayload.providerId : "tork";
    await upsertRuntimeResourcePg(tx, {
      id: hand.id,
      resourceType: "hand_execution",
      resourceKey: hand.resourceKey,
      runId: hand.runId,
      taskId: hand.taskId,
      sessionId: hand.sessionId,
      scope: hand.scope,
      status: "lost",
      title: hand.title,
      payload: {
        ...handPayload,
        status: "lost",
        terminalAt: now,
        lostReason: "requeue-hand-execution",
        recoveryDecisionId: decision.decisionId,
      },
      summary: hand.summary,
      metrics: hand.metrics,
      expiresAt: hand.expiresAt,
    });

    await tx.query(
      "update southstar.workflow_tasks set status = 'pending', completed_at = null, updated_at = now() where run_id = $1 and id = $2",
      [decision.payload.runId, taskId],
    );

    return {
      exceptionResourceKey: exception.resourceKey,
      providerActions: [
        {
          providerId,
          action: "cancel",
          status: "succeeded",
          evidenceRef: hand.resourceKey,
          attemptedAt: now,
          succeededAt: now,
        },
      ],
      stateChanges: [
        {
          resourceType: "hand_execution",
          resourceKey: hand.resourceKey,
          fromStatus: hand.status,
          toStatus: "lost",
          reason: "requeue-hand-execution",
        },
        {
          resourceType: "workflow_task",
          resourceKey: `${decision.payload.runId}:${taskId}`,
          fromStatus: task.status,
          toStatus: "pending",
          reason: "requeue-hand-execution",
        },
        {
          resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
          resourceKey: decision.resourceKey,
          fromStatus: "applying",
          toStatus: "applied",
          reason: "requeue-hand-execution applied",
        },
      ],
    };
  });
}

async function claimRecoveryDecisionApplyingPg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; now: string },
): Promise<void> {
  if (input.decision.status === "applying") return;
  const payload = {
    ...input.decision.payload,
    applyingAt: input.now,
    statusReason: "requeue-hand-execution applying",
  };
  await upsertRuntimeResourcePg(db, {
    id: input.decision.decisionId,
    resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
    resourceKey: input.decision.resourceKey,
    runId: input.decision.payload.runId,
    taskId: input.decision.payload.taskId,
    scope: "recovery",
    status: "applying",
    title: `Runtime recovery decision: ${input.decision.payload.path}`,
    payload,
    summary: {
      exceptionId: input.decision.payload.exceptionId,
      path: input.decision.payload.path,
      applyingAt: input.now,
    },
  });
}

async function finalizeRecoveryDecisionAppliedPg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; executionResourceKey: string; now: string },
): Promise<void> {
  await db.tx(async (tx) => {
    await appendRecoveryDecisionAppliedHistoryOncePg(tx, input);
    const payload = {
      ...input.decision.payload,
      appliedAt: input.now,
      statusReason: "requeue-hand-execution applied",
    };
    await upsertRuntimeResourcePg(tx, {
      id: input.decision.decisionId,
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: input.decision.resourceKey,
      runId: input.decision.payload.runId,
      taskId: input.decision.payload.taskId,
      scope: "recovery",
      status: "applied",
      title: `Runtime recovery decision: ${input.decision.payload.path}`,
      payload,
      summary: {
        exceptionId: input.decision.payload.exceptionId,
        path: input.decision.payload.path,
        appliedAt: input.now,
      },
    });
  });
}

async function blockDecision(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
    reason: string;
  },
): Promise<void> {
  await db.tx(async (tx) => {
    const payload = {
      ...input.decision.payload,
      blockedAt: input.now,
      statusReason: input.reason,
    };
    await upsertRuntimeResourcePg(tx, {
      id: input.decision.decisionId,
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: input.decision.resourceKey,
      runId: input.decision.payload.runId,
      taskId: input.decision.payload.taskId,
      scope: "recovery",
      status: "blocked",
      title: `Runtime recovery decision: ${input.decision.payload.path}`,
      payload,
      summary: {
        exceptionId: input.decision.payload.exceptionId,
        path: input.decision.payload.path,
        reason: input.reason,
      },
    });
  });

  await completeRecoveryExecutionPg(db, {
    runId: input.decision.payload.runId,
    executionResourceKey: input.executionResourceKey,
    status: "blocked",
    completedAt: input.now,
    stateChanges: [
      {
        resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
        resourceKey: input.decision.resourceKey,
        fromStatus: input.decision.status,
        toStatus: "blocked",
        reason: input.reason,
      },
    ],
    providerActions: [],
  });
}

async function appendRecoveryDecisionAppliedHistoryOncePg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; executionResourceKey: string; now: string },
): Promise<void> {
  const idempotencyKey = `${input.decision.resourceKey}:applied`;
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.decision.payload.runId, idempotencyKey],
  );
  if (existing) return;

  await appendHistoryEventPg(db, {
    runId: input.decision.payload.runId,
    taskId: input.decision.payload.taskId,
    eventType: "recovery_decision.applied",
    actorType: "orchestrator",
    idempotencyKey,
    payload: {
      recoveryDecisionId: input.decision.decisionId,
      runId: input.decision.payload.runId,
      taskId: input.decision.payload.taskId,
      path: input.decision.payload.path,
      executionResourceKey: input.executionResourceKey,
      result: "applied",
      status: "applied",
      appliedAt: input.now,
    },
  });
}

function requireRecoveryDecision(resource: RuntimeResourceRecord | null): RuntimeRecoveryDecisionRecord {
  if (!resource) throw new Error("recovery decision not found");
  const payload = resource.payload as Partial<RecoveryDecisionPayload>;
  if (
    resource.resourceType !== RECOVERY_DECISION_RESOURCE_TYPE ||
    typeof payload.decisionId !== "string" ||
    typeof payload.exceptionId !== "string" ||
    typeof payload.runId !== "string" ||
    typeof payload.path !== "string"
  ) {
    throw new Error("invalid recovery decision resource");
  }
  return {
    decisionId: payload.decisionId,
    resourceKey: resource.resourceKey,
    status: resource.status as RecoveryDecisionStatus,
    payload: payload as RecoveryDecisionPayload,
  };
}

function mapRuntimeResourceRow(row: RuntimeResourceRow | null): RuntimeResourceRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    runId: row.run_id ?? undefined,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    scope: row.scope,
    status: row.status,
    title: row.title ?? undefined,
    payload: row.payload_json,
    summary: row.summary_json,
    metrics: row.metrics_json,
    expiresAt: row.expires_at ? dateString(row.expires_at) : undefined,
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
  };
}

function requireString(value: string | undefined, label: string): string {
  if (!value) throw new Error(`requeue-hand-execution decision missing ${label}`);
  return value;
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
