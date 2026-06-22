import type { SouthstarDb } from "../db/postgres.ts";
import {
  RECOVERY_DECISION_RESOURCE_TYPE,
  RECOVERY_EXECUTION_RESOURCE_TYPE,
  RUNTIME_EXCEPTION_RESOURCE_TYPE,
} from "../exceptions/types.ts";
import { inspectRunPg } from "../inspection/postgres-inspect-run.ts";
import { envelopeReadModel } from "./envelope.ts";

type RuntimeExceptionResourceRow = {
  resource_type: string;
  resource_key: string;
  status: string;
  task_id: string | null;
  payload_json: unknown;
};

export type RuntimeExceptionRunReadModel = {
  runId: string;
  exceptions: Array<{
    resourceKey: string;
    status: string;
    kind?: string;
    severity?: string;
    source?: string;
    taskId?: string;
    handExecutionId?: string;
    observedAt?: string;
  }>;
  recoveryDecisions: Array<{
    resourceKey: string;
    status: string;
    path?: string;
    exceptionId?: string;
    operatorApprovalRequired?: boolean;
  }>;
  recoveryExecutions: Array<{
    resourceKey: string;
    status: string;
    decisionId?: string;
    exceptionId?: string;
    path?: string;
    taskId?: string;
    providerActionCount?: number;
    stateChangeCount?: number;
  }>;
};

export async function buildRunInspectionReadModelPg(db: SouthstarDb, runId: string) {
  return envelopeReadModel({
    schemaVersion: "southstar.read_model.run_inspection.v1",
    kind: "run-inspection",
    data: await inspectRunPg(db, { runId }),
  });
}

export async function buildRuntimeExceptionReadModelPg(
  db: SouthstarDb,
  input: { runId: string },
): Promise<RuntimeExceptionRunReadModel> {
  const run = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_runs where id = $1",
    [input.runId],
  );
  if (!run) throw new Error(`run not found: ${input.runId}`);

  const rows = await db.query<RuntimeExceptionResourceRow>(
    `select resource_type, resource_key, status, task_id, payload_json
     from southstar.runtime_resources
     where run_id = $1
       and resource_type = any($2::text[])
     order by created_at, resource_key`,
    [input.runId, [RUNTIME_EXCEPTION_RESOURCE_TYPE, RECOVERY_DECISION_RESOURCE_TYPE, RECOVERY_EXECUTION_RESOURCE_TYPE]],
  );
  return {
    runId: input.runId,
    exceptions: rows.rows
      .filter((row) => row.resource_type === RUNTIME_EXCEPTION_RESOURCE_TYPE)
      .map(mapRuntimeExceptionResource),
    recoveryDecisions: rows.rows
      .filter((row) => row.resource_type === RECOVERY_DECISION_RESOURCE_TYPE)
      .map(mapRecoveryDecisionResource),
    recoveryExecutions: rows.rows
      .filter((row) => row.resource_type === RECOVERY_EXECUTION_RESOURCE_TYPE)
      .map(mapRecoveryExecutionResource),
  };
}

function mapRuntimeExceptionResource(row: RuntimeExceptionResourceRow): RuntimeExceptionRunReadModel["exceptions"][number] {
  const payload = asRecord(row.payload_json);
  return {
    resourceKey: row.resource_key,
    status: row.status,
    kind: stringValue(payload.kind),
    severity: stringValue(payload.severity),
    source: stringValue(payload.source),
    taskId: row.task_id ?? stringValue(payload.taskId),
    handExecutionId: stringValue(payload.handExecutionId),
    observedAt: stringValue(payload.observedAt),
  };
}

function mapRecoveryDecisionResource(row: RuntimeExceptionResourceRow): RuntimeExceptionRunReadModel["recoveryDecisions"][number] {
  const payload = asRecord(row.payload_json);
  return {
    resourceKey: row.resource_key,
    status: row.status,
    path: stringValue(payload.path),
    exceptionId: stringValue(payload.exceptionId),
    operatorApprovalRequired: typeof payload.operatorApprovalRequired === "boolean" ? payload.operatorApprovalRequired : undefined,
  };
}

function mapRecoveryExecutionResource(row: RuntimeExceptionResourceRow): RuntimeExceptionRunReadModel["recoveryExecutions"][number] {
  const payload = asRecord(row.payload_json);
  const providerActions = payload.providerActions;
  const stateChanges = payload.stateChanges;
  return {
    resourceKey: row.resource_key,
    status: row.status,
    decisionId: stringValue(payload.decisionId),
    exceptionId: stringValue(payload.exceptionId),
    path: stringValue(payload.path),
    taskId: row.task_id ?? stringValue(payload.taskId),
    providerActionCount: Array.isArray(providerActions) ? providerActions.length : undefined,
    stateChangeCount: Array.isArray(stateChanges) ? stateChanges.length : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
