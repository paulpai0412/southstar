import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import {
  RECOVERY_DECISION_RESOURCE_TYPE,
  RECOVERY_DECISION_SCHEMA_VERSION,
  type RecoveryDecisionPayload,
  type RecoveryDecisionStatus,
} from "./types.ts";

export type RecoveryApprovalDecision = "approved" | "rejected";

export type RecoveryApprovalResult = {
  decisionId: string;
  resourceKey: string;
  status: "approved" | "blocked";
  operatorApprovalResourceKey: string;
};

type RuntimeRecoveryDecisionRow = {
  id: string;
  resource_key: string;
  task_id: string | null;
  session_id: string | null;
  status: string;
  payload_json: unknown;
};

export async function decideRecoveryDecisionApprovalPg(
  db: SouthstarDb,
  input: {
    runId: string;
    decisionId: string;
    decision: RecoveryApprovalDecision;
    reason: string;
    now?: string;
  },
): Promise<RecoveryApprovalResult> {
  const now = input.now ?? new Date().toISOString();
  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ id: string }>(
      "select id from southstar.workflow_runs where id = $1 for update",
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);

    const row = await tx.maybeOne<RuntimeRecoveryDecisionRow>(
      `select id, resource_key, task_id, session_id, status, payload_json
         from southstar.runtime_resources
        where resource_type = $1
          and run_id = $2
          and payload_json->>'schemaVersion' = $3
          and payload_json->>'decisionId' = $4
        for update`,
      [RECOVERY_DECISION_RESOURCE_TYPE, input.runId, RECOVERY_DECISION_SCHEMA_VERSION, input.decisionId],
    );
    if (!row) throw new Error(`runtime recovery decision not found: ${input.decisionId}`);

    const payload = requireRuntimeRecoveryDecisionPayload(row, input.decisionId);
    if (payload.runId !== input.runId) {
      throw new Error(`runtime recovery decision payload runId mismatch: ${input.decisionId}`);
    }
    const nextStatus = input.decision === "approved" ? "approved" : "blocked";
    assertTransitionAllowed(row.status as RecoveryDecisionStatus, payload, input, nextStatus);

    const existingDecidedAt = stringValue((payload as Record<string, unknown>).operatorDecidedAt);
    const decidedAt = existingDecidedAt ?? now;
    const nextPayload = {
      ...payload,
      operatorDecision: input.decision,
      operatorReason: input.reason,
      operatorDecidedAt: decidedAt,
    };

    if (row.status === "waiting_operator_approval") {
      await tx.query(
        `update southstar.runtime_resources
            set status = $1,
                payload_json = $2::jsonb,
                updated_at = now()
          where id = $3`,
        [nextStatus, JSON.stringify(nextPayload), row.id],
      );
    }

    const operatorApprovalResourceKey = operatorApprovalKey(payload.decisionId);
    await upsertRuntimeResourcePg(tx, {
      id: operatorApprovalResourceKey,
      resourceType: "operator_approval",
      resourceKey: operatorApprovalResourceKey,
      runId: input.runId,
      taskId: row.task_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      scope: "recovery",
      status: input.decision,
      title: `Operator approval: ${payload.path}`,
      payload: {
        schemaVersion: "southstar.runtime.operator_approval.v1",
        approvalId: operatorApprovalResourceKey,
        decisionId: payload.decisionId,
        recoveryDecisionResourceKey: row.resource_key,
        runId: input.runId,
        ...(row.task_id ? { taskId: row.task_id } : {}),
        operatorDecision: input.decision,
        reason: input.reason,
        decidedAt,
      },
      summary: {
        decisionId: payload.decisionId,
        recoveryDecisionResourceKey: row.resource_key,
        operatorDecision: input.decision,
      },
    });

    await appendOperatorDecisionHistoryOncePg(tx, {
      runId: input.runId,
      taskId: row.task_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      decisionId: payload.decisionId,
      resourceKey: row.resource_key,
      path: payload.path,
      operatorDecision: input.decision,
      reason: input.reason,
      operatorApprovalResourceKey,
      decidedAt,
    });

    return {
      decisionId: payload.decisionId,
      resourceKey: row.resource_key,
      status: nextStatus,
      operatorApprovalResourceKey,
    };
  });
}

function requireRuntimeRecoveryDecisionPayload(
  row: RuntimeRecoveryDecisionRow,
  decisionId: string,
): RecoveryDecisionPayload {
  if (!isRecord(row.payload_json)) throw new Error(`runtime recovery decision payload is invalid: ${decisionId}`);
  if (row.payload_json.schemaVersion !== RECOVERY_DECISION_SCHEMA_VERSION) {
    throw new Error(`runtime recovery decision not found: ${decisionId}`);
  }
  if (row.payload_json.decisionId !== decisionId) {
    throw new Error(`runtime recovery decision payload decisionId mismatch: ${decisionId}`);
  }
  if (typeof row.payload_json.exceptionId !== "string" || typeof row.payload_json.runId !== "string") {
    throw new Error(`runtime recovery decision payload is invalid: ${decisionId}`);
  }
  return row.payload_json as RecoveryDecisionPayload;
}

function assertTransitionAllowed(
  currentStatus: RecoveryDecisionStatus,
  payload: RecoveryDecisionPayload,
  input: { decisionId: string; decision: RecoveryApprovalDecision; reason: string },
  nextStatus: "approved" | "blocked",
): void {
  if (currentStatus === "waiting_operator_approval") return;

  const record = payload as RecoveryDecisionPayload & {
    operatorDecision?: string;
    operatorReason?: string;
  };
  if (currentStatus === nextStatus && record.operatorDecision === input.decision && record.operatorReason === input.reason) return;

  if (currentStatus === "approved" || currentStatus === "blocked") {
    throw new Error(`recovery decision already ${currentStatus}: ${input.decisionId}`);
  }
  throw new Error(`recovery decision is not waiting for operator approval: ${input.decisionId} is ${currentStatus}`);
}

async function appendOperatorDecisionHistoryOncePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId?: string;
    sessionId?: string;
    decisionId: string;
    resourceKey: string;
    path: string;
    operatorDecision: RecoveryApprovalDecision;
    reason: string;
    operatorApprovalResourceKey: string;
    decidedAt: string;
  },
): Promise<void> {
  const idempotencyKey = `${input.resourceKey}:operator-decision:${input.operatorDecision}`;
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, idempotencyKey],
  );
  if (existing) return;

  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "recovery_decision.operator_decided",
    actorType: "operator",
    idempotencyKey,
    payload: {
      decisionId: input.decisionId,
      resourceKey: input.resourceKey,
      path: input.path,
      operatorDecision: input.operatorDecision,
      reason: input.reason,
      operatorApprovalResourceKey: input.operatorApprovalResourceKey,
      decidedAt: input.decidedAt,
    },
  });
}

function operatorApprovalKey(decisionId: string): string {
  return `operator_approval:${decisionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
