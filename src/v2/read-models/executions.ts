import type { SouthstarDb } from "../db/postgres.ts";

export type ExecutionProjection = {
  executionId: string;
  kind: "hand_execution" | "executor_binding";
  providerId: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  status: string;
  rawStatus: string;
  externalJobId?: string;
  heartbeat?: {
    lastHeartbeatAt?: string;
    heartbeatSeq?: number;
  };
  terminal?: {
    completedAt?: string;
    reason?: string;
  };
  callback?: {
    receivedAt?: string;
    ok?: boolean;
    eventRefs: string[];
  };
  exceptionRefs: string[];
};

type ExecutionResourceRow = {
  resource_type: "hand_execution" | "executor_binding";
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  status: string;
  payload_json: unknown;
  summary_json: unknown;
  created_at: Date | string;
};

type ExceptionResourceRow = {
  resource_key: string;
  payload_json: unknown;
};

export async function listExecutionProjectionsPg(db: SouthstarDb, runId: string): Promise<ExecutionProjection[]> {
  const [executions, exceptions] = await Promise.all([
    db.query<ExecutionResourceRow>(
      `select resource_type, resource_key, run_id, task_id, session_id, status, payload_json, summary_json, created_at
         from southstar.runtime_resources
        where run_id = $1
          and resource_type in ('hand_execution', 'executor_binding')
        order by created_at, resource_type, resource_key`,
      [runId],
    ),
    db.query<ExceptionResourceRow>(
      `select resource_key, payload_json
         from southstar.runtime_resources
        where run_id = $1
          and resource_type = 'runtime_exception'
        order by created_at, resource_key`,
      [runId],
    ),
  ]);
  return executions.rows.map((row) => mapExecutionProjection(row, exceptions.rows));
}

export async function getExecutionProjectionPg(
  db: SouthstarDb,
  input: { runId: string; executionId: string },
): Promise<ExecutionProjection | null> {
  const row = await db.maybeOne<ExecutionResourceRow>(
    `select resource_type, resource_key, run_id, task_id, session_id, status, payload_json, summary_json, created_at
       from southstar.runtime_resources
      where run_id = $1
        and resource_key = $2
        and resource_type in ('hand_execution', 'executor_binding')`,
    [input.runId, input.executionId],
  );
  if (!row) return null;
  const exceptions = await db.query<ExceptionResourceRow>(
    `select resource_key, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'runtime_exception'
      order by created_at, resource_key`,
    [input.runId],
  );
  return mapExecutionProjection(row, exceptions.rows);
}

export async function getExecutionProjectionByExternalJobIdPg(
  db: SouthstarDb,
  input: { runId: string; jobId: string },
): Promise<ExecutionProjection | null> {
  const rows = await db.query<ExecutionResourceRow>(
    `select resource_type, resource_key, run_id, task_id, session_id, status, payload_json, summary_json, created_at
       from southstar.runtime_resources
      where run_id = $1
        and resource_type in ('hand_execution', 'executor_binding')
        and (
          resource_key = $2
          or payload_json->>'externalJobId' = $2
          or payload_json->>'torkJobId' = $2
          or payload_json->>'jobId' = $2
        )
      order by created_at, resource_type, resource_key
      limit 1`,
    [input.runId, input.jobId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const exceptions = await db.query<ExceptionResourceRow>(
    `select resource_key, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'runtime_exception'
      order by created_at, resource_key`,
    [input.runId],
  );
  return mapExecutionProjection(row, exceptions.rows);
}

function mapExecutionProjection(row: ExecutionResourceRow, exceptions: ExceptionResourceRow[]): ExecutionProjection {
  const payload = asRecord(row.payload_json);
  const summary = asRecord(row.summary_json);
  const executionId = row.resource_key;
  const externalJobId = firstString(payload.externalJobId, payload.torkJobId, payload.jobId);
  const heartbeat = optionalObject({
    lastHeartbeatAt: firstString(payload.lastHeartbeatAt, payload.heartbeatAt),
    heartbeatSeq: numberValue(payload.heartbeatSeq),
  });
  const terminal = optionalObject({
    completedAt: firstString(payload.completedAt, payload.terminalAt, payload.terminalObservedAt, payload.failedAt, payload.cancelledAt),
    reason: firstString(payload.reason, payload.statusReason, payload.errorMessage),
  });
  const callback = optionalCallback(payload);

  return {
    executionId,
    kind: row.resource_type,
    providerId: firstString(payload.providerId, payload.executorType, summary.providerId) ?? "unknown",
    runId: row.run_id ?? firstString(payload.runId) ?? "",
    taskId: row.task_id ?? firstString(payload.taskId),
    sessionId: row.session_id ?? firstString(payload.sessionId),
    attemptId: firstString(payload.attemptId),
    status: normalizeExecutionStatus(row.status),
    rawStatus: row.status,
    ...(externalJobId ? { externalJobId } : {}),
    ...(heartbeat ? { heartbeat } : {}),
    ...(terminal ? { terminal } : {}),
    ...(callback ? { callback } : {}),
    exceptionRefs: exceptionRefsForExecution(executionId, exceptions),
  };
}

function normalizeExecutionStatus(status: string): string {
  if (status === "submitted" || status === "starting") return "queued";
  if (status === "heartbeat-lost" || status === "queue-timeout" || status === "hard-timeout" || status === "callback-missing" || status === "orphaned") return "lost";
  if (status === "cancel_requested") return "cancelled";
  if (status === "completed" || status === "failed" || status === "cancelled" || status === "lost" || status === "superseded" || status === "queued" || status === "running") return status;
  return "failed";
}

function optionalCallback(payload: Record<string, unknown>): ExecutionProjection["callback"] | undefined {
  const receivedAt = firstString(payload.callbackReceivedAt, payload.receivedAt);
  const ok = booleanValue(payload.callbackOk) ?? booleanValue(payload.ok);
  const eventRefs = stringArray(payload.eventRefs);
  if (!receivedAt && ok === undefined && eventRefs.length === 0) return undefined;
  return {
    ...(receivedAt ? { receivedAt } : {}),
    ...(ok !== undefined ? { ok } : {}),
    eventRefs,
  };
}

function exceptionRefsForExecution(executionId: string, exceptions: ExceptionResourceRow[]): string[] {
  return exceptions
    .filter((exception) => exceptionMentionsExecution(asRecord(exception.payload_json), executionId))
    .map((exception) => exception.resource_key);
}

function exceptionMentionsExecution(payload: Record<string, unknown>, executionId: string): boolean {
  return payload.handExecutionId === executionId
    || payload.executorBindingId === executionId
    || payload.bindingId === executionId
    || stringArray(payload.evidenceRefs).includes(executionId);
}

function optionalObject<T extends Record<string, unknown>>(value: T): T | undefined {
  return Object.values(value).some((item) => item !== undefined) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
