import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  appendHistoryEventPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  type RuntimeResourceRecord,
} from "../stores/postgres-runtime-store.ts";
import { recordRuntimeExceptionPg } from "./postgres-runtime-exceptions.ts";
import type {
  RecoveryDecisionPayload,
  RecoveryPath,
  RuntimeExceptionClassification,
  RuntimeExceptionRecord,
  RuntimeObservation,
  RuntimeRecoveryDecisionRecord,
} from "./types.ts";

const RECOVERY_DECISION_RESOURCE_TYPE = "recovery_decision";
const RECOVERY_DECISION_SCHEMA_VERSION = "southstar.runtime.recovery_decision.v1";

export function createRuntimeExceptionController(deps: { db: SouthstarDb }): {
  observe(input: RuntimeObservation): Promise<RuntimeExceptionRecord>;
  classify(exception: RuntimeExceptionRecord): Promise<RuntimeExceptionClassification>;
  decide(classification: RuntimeExceptionClassification): Promise<RuntimeRecoveryDecisionRecord>;
} {
  return {
    async observe(input) {
      return await recordRuntimeExceptionPg(deps.db, { status: "observed", ...input });
    },
    async classify(exception) {
      const recoveryPath = classifyRecoveryPath(exception);
      return {
        ...exception,
        recoveryPath,
        operatorApprovalRequired: requiresOperatorApproval(recoveryPath),
        reason: classificationReason(exception, recoveryPath),
      };
    },
    async decide(classification) {
      return await recordRecoveryDecisionPg(deps.db, classification);
    },
  };
}

async function recordRecoveryDecisionPg(
  db: SouthstarDb,
  classification: RuntimeExceptionClassification,
): Promise<RuntimeRecoveryDecisionRecord> {
  const resourceKey = recoveryDecisionResourceKey(classification);
  const decisionId = recoveryDecisionId(resourceKey);

  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [classification.runId]);
    const existing = toRuntimeRecoveryDecisionRecord(
      await getResourceByKeyPg(tx, RECOVERY_DECISION_RESOURCE_TYPE, resourceKey),
    );
    if (existing) {
      await appendRecoveryDecisionHistoryOncePg(tx, existing, classification);
      return existing;
    }

    const payload: RecoveryDecisionPayload = {
      schemaVersion: RECOVERY_DECISION_SCHEMA_VERSION,
      decisionId,
      exceptionId: classification.exceptionId,
      runId: classification.runId,
      ...(classification.taskId ? { taskId: classification.taskId } : {}),
      ...(classification.payload.handExecutionId ? { handExecutionId: classification.payload.handExecutionId } : {}),
      path: classification.recoveryPath,
      reason: classification.reason,
      operatorApprovalRequired: classification.operatorApprovalRequired,
      ...(classification.payload.attemptId ? { previousAttemptId: classification.payload.attemptId } : {}),
      ...nextAttemptPayload(classification),
      evidenceRefs: classification.payload.evidenceRefs,
      createdAt: new Date().toISOString(),
    };

    await upsertRuntimeResourcePg(tx, {
      id: decisionId,
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey,
      runId: classification.runId,
      taskId: classification.taskId,
      sessionId: classification.sessionId,
      scope: "recovery",
      status: "recorded",
      title: `Runtime recovery decision: ${classification.recoveryPath}`,
      payload,
      summary: {
        exceptionId: classification.exceptionId,
        path: classification.recoveryPath,
        operatorApprovalRequired: classification.operatorApprovalRequired,
      },
    });

    const record = requireRuntimeRecoveryDecisionRecord(
      await getResourceByKeyPg(tx, RECOVERY_DECISION_RESOURCE_TYPE, resourceKey),
    );
    await appendRecoveryDecisionHistoryOncePg(tx, record, classification);
    return record;
  });
}

function classifyRecoveryPath(exception: RuntimeExceptionRecord): RecoveryPath {
  switch (exception.payload.kind) {
    case "tork_queue_timeout":
      return "requeue-hand-execution";
    case "tork_running_hang":
      return providerEvidenceFlag(exception, "workspaceUnsafe") ? "rollback-workspace" : "reprovision-hand";
    case "tork_terminal_without_callback":
      return "retry-same-task-new-attempt";
    case "late_callback":
    case "stale_callback":
      return "none-observe-only";
    case "callback_contract_violation":
    case "artifact_rejected":
      return "repair-artifact";
    case "tool_proxy_violation":
    case "completion_gate_failed":
    case "provider_unreachable":
      return "block-for-operator";
    case "brain_wake_failed":
      return "wake-new-brain";
    case "hand_provision_failed":
    case "hand_submit_failed":
      return "reprovision-hand";
    case "scheduler_claim_stale":
      return "retry-same-task-new-attempt";
    case "intake_invalid":
      return "block-for-operator";
  }
}

function requiresOperatorApproval(path: RecoveryPath): boolean {
  return path === "rollback-workspace" || path === "block-for-operator";
}

function classificationReason(exception: RuntimeExceptionRecord, path: RecoveryPath): string {
  return `${exception.payload.kind} classified for ${path}`;
}

function providerEvidenceFlag(exception: RuntimeExceptionRecord, key: string): boolean {
  return exception.payload.providerEvidence?.[key] === true;
}

function nextAttemptPayload(classification: RuntimeExceptionClassification): Pick<RecoveryDecisionPayload, "nextAttemptId"> {
  if (!classification.payload.attemptId) return {};
  if (classification.recoveryPath === "none-observe-only" || classification.recoveryPath === "block-for-operator") return {};
  return { nextAttemptId: `${classification.payload.attemptId}:recovery-${stableHash(recoveryDecisionResourceKey(classification)).slice(0, 8)}` };
}

function recoveryDecisionResourceKey(classification: RuntimeExceptionClassification): string {
  return `runtime_exception_recovery_decision:${classification.exceptionId}:${classification.recoveryPath}`;
}

function recoveryDecisionId(resourceKey: string): string {
  return `recovery-decision-${stableHash(resourceKey).slice(0, 24)}`;
}

async function appendRecoveryDecisionHistoryOncePg(
  db: SouthstarDb,
  record: RuntimeRecoveryDecisionRecord,
  classification: RuntimeExceptionClassification,
): Promise<void> {
  const idempotencyKey = `${record.resourceKey}:recovery-decided`;
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [record.payload.runId, idempotencyKey],
  );
  if (existing) return;

  await appendHistoryEventPg(db, {
    runId: record.payload.runId,
    taskId: record.payload.taskId,
    sessionId: classification.sessionId,
    eventType: "runtime_exception.recovery_decided",
    actorType: "orchestrator",
    idempotencyKey,
    payload: {
      decisionId: record.decisionId,
      resourceKey: record.resourceKey,
      exceptionId: record.payload.exceptionId,
      path: record.payload.path,
      operatorApprovalRequired: record.payload.operatorApprovalRequired,
      reason: record.payload.reason,
      evidenceRefs: record.payload.evidenceRefs,
    },
  });
}

function requireRuntimeRecoveryDecisionRecord(resource: RuntimeResourceRecord | null): RuntimeRecoveryDecisionRecord {
  const record = toRuntimeRecoveryDecisionRecord(resource);
  if (!record) throw new Error("runtime recovery decision not found");
  return record;
}

function toRuntimeRecoveryDecisionRecord(resource: RuntimeResourceRecord | null): RuntimeRecoveryDecisionRecord | null {
  if (!resource) return null;
  const payload = resource.payload as Partial<RecoveryDecisionPayload>;
  if (
    resource.resourceType !== RECOVERY_DECISION_RESOURCE_TYPE ||
    payload.schemaVersion !== RECOVERY_DECISION_SCHEMA_VERSION ||
    typeof payload.decisionId !== "string" ||
    typeof payload.exceptionId !== "string" ||
    typeof payload.runId !== "string"
  ) {
    return null;
  }

  return {
    decisionId: payload.decisionId,
    resourceKey: resource.resourceKey,
    status: resource.status as RuntimeRecoveryDecisionRecord["status"],
    payload: payload as RecoveryDecisionPayload,
  };
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
