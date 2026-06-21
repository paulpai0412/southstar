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
  RECOVERY_EXECUTION_RESOURCE_TYPE,
  RECOVERY_DECISION_RESOURCE_TYPE,
  RUNTIME_EXCEPTION_RESOURCE_TYPE,
  type RecoveryDecisionPayload,
  type RecoveryDecisionStatus,
  type RecoveryExecutionPayload,
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

type RecoveryExecutionEvidence = Pick<RequeueMutationResult, "stateChanges" | "providerActions">;

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
        const repairedExecutionResourceKey = await repairTerminalRecoveryExecutionPg(deps.db, {
          decision,
          executionResourceKey,
          now,
        });
        return {
          status: decision.status,
          ...(repairedExecutionResourceKey ? { executionResourceKey: repairedExecutionResourceKey } : {}),
          reason: terminalDecisionReason(decision),
        };
      }

      const claimedDecision = await claimRecoveryDecisionApplyingPg(deps.db, { decision, now });
      if (claimedDecision.status === "applied") {
        return { status: "applied", executionResourceKey, reason: "decision already applied" };
      }
      if (claimedDecision.status === "waiting_operator_approval") {
        return { status: "skipped", reason: "decision waiting for operator approval" };
      }
      if (claimedDecision.status === "blocked" || claimedDecision.status === "failed" || claimedDecision.status === "superseded") {
        const repairedExecutionResourceKey = await repairTerminalRecoveryExecutionPg(deps.db, {
          decision: claimedDecision,
          executionResourceKey,
          now,
        });
        return {
          status: claimedDecision.status,
          ...(repairedExecutionResourceKey ? { executionResourceKey: repairedExecutionResourceKey } : {}),
          reason: terminalDecisionReason(claimedDecision),
        };
      }
      const applyingDecision: RuntimeRecoveryDecisionRecord = { ...claimedDecision, status: "applying" };

      const started = await startRecoveryExecutionPg(deps.db, {
        decisionId: applyingDecision.decisionId,
        exceptionId: applyingDecision.payload.exceptionId,
        runId: applyingDecision.payload.runId,
        taskId: applyingDecision.payload.taskId,
        path: applyingDecision.payload.path,
        now,
      });

      if (applyingDecision.payload.path !== "requeue-hand-execution") {
        await blockDecision(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          reason: `unsupported recovery path ${applyingDecision.payload.path}`,
        });
        return { status: "blocked", executionResourceKey: started.resourceKey, reason: `unsupported recovery path ${applyingDecision.payload.path}` };
      }

      if (!applyingDecision.payload.taskId) {
        await blockDecision(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          reason: "requeue-hand-execution decision missing taskId",
        });
        return { status: "blocked", executionResourceKey: started.resourceKey, reason: "requeue-hand-execution decision missing taskId" };
      }

      if (!applyingDecision.payload.handExecutionId) {
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
        const stagedEvidence = stagedRecoveryExecutionEvidence(started.payload);
        mutation = await applyRequeueMutation(deps.db, {
          decision: applyingDecision,
          executionResourceKey: started.resourceKey,
          now,
          stagedEvidence,
        });
      } catch (error) {
        if (error instanceof Error && error.message === `hand execution ${applyingDecision.payload.handExecutionId} not found`) {
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
        runId: applyingDecision.payload.runId,
        resourceKey: mutation.exceptionResourceKey,
        resolvedAt: now,
        reason: "requeue-hand-execution applied",
      });

      await completeRecoveryExecutionPg(deps.db, {
        runId: applyingDecision.payload.runId,
        executionResourceKey: started.resourceKey,
        status: "succeeded",
        completedAt: requeueTerminalAt(mutation.providerActions) ?? now,
        stateChanges: mutation.stateChanges,
        providerActions: mutation.providerActions,
      });
      await finalizeRecoveryDecisionAppliedPg(deps.db, { decision: applyingDecision, executionResourceKey: started.resourceKey, now });

      return { status: "applied", executionResourceKey: started.resourceKey, reason: "requeue-hand-execution applied" };
    },
  };
}

async function applyRequeueMutation(
  db: SouthstarDb,
  input: {
    decision: RuntimeRecoveryDecisionRecord;
    executionResourceKey: string;
    now: string;
    stagedEvidence: RecoveryExecutionEvidence | null;
  },
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
    const recomputedEvidence: RecoveryExecutionEvidence = {
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
        {
          resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
          resourceKey: exception.resourceKey,
          fromStatus: exception.status,
          toStatus: "resolved",
          reason: "requeue-hand-execution applied",
        },
      ],
    };
    const evidence =
      input.stagedEvidence ??
      (await stageRecoveryExecutionEvidencePg(tx, {
        executionResourceKey: input.executionResourceKey,
        evidence: recomputedEvidence,
        now,
      }));
    const terminalAt = requeueTerminalAt(evidence.providerActions) ?? now;
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
        terminalAt,
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
      providerActions: evidence.providerActions,
      stateChanges: evidence.stateChanges,
    };
  });
}

async function stageRecoveryExecutionEvidencePg(
  db: SouthstarDb,
  input: { executionResourceKey: string; evidence: RecoveryExecutionEvidence; now: string },
): Promise<RecoveryExecutionEvidence> {
  const execution = mapRuntimeResourceRow(await db.maybeOne<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = $1
        and resource_key = $2
      for update`,
    [RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey],
  ));
  if (!execution) throw new Error(`recovery execution ${input.executionResourceKey} not found`);
  if (execution.status !== "started") {
    throw new Error(`recovery execution ${input.executionResourceKey} is ${execution.status}, expected started`);
  }

  const payload = execution.payload as RecoveryExecutionPayload;
  const existingEvidence = stagedRecoveryExecutionEvidence(payload);
  if (existingEvidence) return existingEvidence;

  await upsertRuntimeResourcePg(db, {
    id: execution.id,
    resourceType: RECOVERY_EXECUTION_RESOURCE_TYPE,
    resourceKey: execution.resourceKey,
    runId: execution.runId,
    taskId: execution.taskId,
    sessionId: execution.sessionId,
    scope: execution.scope,
    status: "started",
    title: execution.title,
    payload: {
      ...payload,
      stateChanges: input.evidence.stateChanges,
      providerActions: input.evidence.providerActions,
    },
    summary: {
      ...(isPlainObject(execution.summary) ? execution.summary : {}),
      evidenceStagedAt: input.now,
      stateChangeCount: input.evidence.stateChanges.length,
      providerActionCount: input.evidence.providerActions.length,
    },
    metrics: execution.metrics,
    expiresAt: execution.expiresAt,
  });
  return input.evidence;
}

async function repairTerminalRecoveryExecutionPg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; executionResourceKey: string; now: string },
): Promise<string | undefined> {
  const execution = await getResourceByKeyPg(db, RECOVERY_EXECUTION_RESOURCE_TYPE, input.executionResourceKey);
  if (!execution) return undefined;
  if (execution.status !== "started") return execution.resourceKey;

  const reason = terminalDecisionReason(input.decision);
  const completedAt = terminalDecisionCompletedAt(input.decision, execution, input.now);
  await completeRecoveryExecutionPg(db, {
    runId: input.decision.payload.runId,
    executionResourceKey: input.executionResourceKey,
    status: input.decision.status,
    completedAt,
    stateChanges: [
      {
        resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
        resourceKey: input.decision.resourceKey,
        fromStatus: "applying",
        toStatus: input.decision.status,
        reason,
      },
    ],
    providerActions: [],
  });
  return execution.resourceKey;
}

function terminalDecisionCompletedAt(
  decision: RuntimeRecoveryDecisionRecord,
  execution: RuntimeResourceRecord,
  fallback: string,
): string {
  const payload = decision.payload as RecoveryDecisionPayload & Record<string, unknown>;
  const terminalAt =
    payload.blockedAt ??
    payload.failedAt ??
    payload.supersededAt ??
    payload.appliedAt ??
    (execution.payload as Partial<RecoveryExecutionPayload>).completedAt ??
    (execution.payload as Partial<RecoveryExecutionPayload>).createdAt;
  return typeof terminalAt === "string" && terminalAt.trim().length > 0 ? terminalAt : fallback;
}

function terminalDecisionReason(decision: RuntimeRecoveryDecisionRecord): string {
  const statusReason = (decision.payload as RecoveryDecisionPayload & { statusReason?: unknown }).statusReason;
  return typeof statusReason === "string" && statusReason.trim().length > 0
    ? statusReason
    : `decision already ${decision.status}`;
}

function stagedRecoveryExecutionEvidence(payload: RecoveryExecutionPayload): RecoveryExecutionEvidence | null {
  if (payload.stateChanges.length === 0 && payload.providerActions.length === 0) return null;
  return {
    stateChanges: payload.stateChanges,
    providerActions: payload.providerActions,
  };
}

function requeueTerminalAt(providerActions: RecoveryExecutionProviderAction[]): string | undefined {
  const cancelAction = providerActions.find((action) => action.action === "cancel" && action.status === "succeeded");
  return cancelAction?.succeededAt ?? cancelAction?.completedAt ?? cancelAction?.attemptedAt;
}

async function claimRecoveryDecisionApplyingPg(
  db: SouthstarDb,
  input: { decision: RuntimeRecoveryDecisionRecord; now: string },
): Promise<RuntimeRecoveryDecisionRecord> {
  return await db.tx(async (tx) => {
    const current = requireRecoveryDecision(await getRecoveryDecisionByKeyForUpdatePg(tx, input.decision.resourceKey));
    if (current.status === "applying") return current;
    if (current.status !== "recorded" && current.status !== "approved") return current;

    const payload = {
      ...current.payload,
      applyingAt: input.now,
      statusReason: "requeue-hand-execution applying",
    };
    await upsertRuntimeResourcePg(tx, {
      id: current.decisionId,
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: current.resourceKey,
      runId: current.payload.runId,
      taskId: current.payload.taskId,
      scope: "recovery",
      status: "applying",
      title: `Runtime recovery decision: ${current.payload.path}`,
      payload,
      summary: {
        exceptionId: current.payload.exceptionId,
        path: current.payload.path,
        applyingAt: input.now,
      },
    });
    return requireRecoveryDecision(await getResourceByKeyPg(tx, RECOVERY_DECISION_RESOURCE_TYPE, current.resourceKey));
  });
}

async function getRecoveryDecisionByKeyForUpdatePg(
  db: SouthstarDb,
  resourceKey: string,
): Promise<RuntimeResourceRecord | null> {
  const row = await db.maybeOne<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = $1
        and resource_key = $2
      for update`,
    [RECOVERY_DECISION_RESOURCE_TYPE, resourceKey],
  );
  return row ? mapRuntimeResourceRow(row) : null;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
