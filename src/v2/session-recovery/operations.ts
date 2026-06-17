import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import type { RecoveryDecisionV1, RecoveryStrategy, SessionOperationV1 } from "./types.ts";
import { validateRecoveryDecision, validateSessionOperation } from "./types.ts";

export type CommitRecoveryDecisionInput = {
  runId: string;
  taskId: string;
  source: RecoveryDecisionV1["source"];
  requestedStrategy: RecoveryStrategy;
  selectedStrategy: RecoveryStrategy;
  beforeRecoveryCheckpointId: string;
  baseCheckpointId?: string;
  reason: string;
  evaluatorFindingRefs?: string[];
  agentSuggestion?: RecoveryDecisionV1["agentSuggestion"];
  authorization: RecoveryDecisionV1["authorization"];
  tokenTelemetry?: RecoveryDecisionV1["tokenTelemetry"];
};

export function commitRecoveryDecision(db: SouthstarDb, input: CommitRecoveryDecisionInput): RecoveryDecisionV1 {
  requireRun(db, input.runId);
  const decisionId = `recovery-${input.runId}-${input.taskId}-${randomUUID()}`;
  const decision = validateRecoveryDecision({
    schemaVersion: "southstar.recovery-decision.v1",
    decisionId,
    runId: input.runId,
    taskId: input.taskId,
    source: input.source,
    requestedStrategy: input.requestedStrategy,
    selectedStrategy: input.selectedStrategy,
    baseCheckpointId: input.baseCheckpointId,
    beforeRecoveryCheckpointId: input.beforeRecoveryCheckpointId,
    reason: input.reason,
    evaluatorFindingRefs: input.evaluatorFindingRefs ?? [],
    agentSuggestion: input.agentSuggestion,
    authorization: input.authorization,
    execution: { status: "queued" },
    tokenTelemetry: input.tokenTelemetry ?? {},
  });

  upsertRuntimeResource(db, {
    id: decisionId,
    resourceType: "recovery_decision",
    resourceKey: decisionId,
    runId: input.runId,
    taskId: input.taskId,
    scope: "session",
    status: "queued",
    title: input.selectedStrategy,
    payload: decision,
    summary: { selectedStrategy: input.selectedStrategy, reason: input.reason, tokenTelemetry: decision.tokenTelemetry },
  });

  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: "recovery.decision",
    actorType: input.source,
    payload: decision,
  });

  return decision;
}

export function recordSessionOperation(db: SouthstarDb, input: Omit<SessionOperationV1, "operationId">): SessionOperationV1 {
  requireRun(db, input.runId);
  const operationId = `session-operation-${input.runId}-${input.taskId}-${randomUUID()}`;
  const operation = validateSessionOperation({ operationId, ...input });

  upsertRuntimeResource(db, {
    id: operationId,
    resourceType: "session_operation",
    resourceKey: operationId,
    runId: operation.runId,
    taskId: operation.taskId,
    sessionId: operation.newSessionId ?? operation.oldSessionId,
    scope: "session",
    status: operation.status,
    title: `${operation.type} via ${operation.host}`,
    payload: operation,
    summary: { type: operation.type, host: operation.host, fallbackUsed: operation.fallbackUsed, error: operation.error },
  });

  appendHistoryEvent(db, {
    runId: operation.runId,
    taskId: operation.taskId,
    sessionId: operation.newSessionId ?? operation.oldSessionId,
    eventType: "session.operation_recorded",
    actorType: "orchestrator",
    payload: operation,
  });

  return operation;
}

function requireRun(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select 1 from workflow_runs where id = ?").get(runId);
  if (!row) throw new Error(`unknown workflow run: ${runId}`);
}
