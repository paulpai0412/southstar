import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  appendHistoryEventPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  type RuntimeResourceRecord,
} from "../stores/postgres-runtime-store.ts";
import {
  RUNTIME_EXCEPTION_RESOURCE_TYPE,
  RUNTIME_EXCEPTION_SCHEMA_VERSION,
  type RuntimeExceptionPayload,
  type RuntimeExceptionRecord,
  type RuntimeExceptionRecordInput,
  type RuntimeExceptionStatus,
} from "./types.ts";

export async function recordRuntimeExceptionPg(
  db: SouthstarDb,
  input: RuntimeExceptionRecordInput,
): Promise<RuntimeExceptionRecord> {
  const resourceKey = runtimeExceptionResourceKey(input);
  const exceptionId = input.exceptionId ?? runtimeExceptionId(input);
  const status = input.status ?? "observed";
  const resolutionPayload = status === "resolved"
    ? {
        ...(input.resolvedAt ? { resolvedAt: input.resolvedAt } : {}),
        ...(input.resolvedReason ? { resolvedReason: input.resolvedReason } : {}),
      }
    : {};
  const payload: RuntimeExceptionPayload = {
    schemaVersion: RUNTIME_EXCEPTION_SCHEMA_VERSION,
    exceptionId,
    runId: input.runId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.handExecutionId ? { handExecutionId: input.handExecutionId } : {}),
    ...(input.brainBindingId ? { brainBindingId: input.brainBindingId } : {}),
    ...(input.handBindingId ? { handBindingId: input.handBindingId } : {}),
    source: input.source,
    kind: input.kind,
    severity: input.severity,
    status,
    observedAt: input.observedAt,
    ...(input.classifiedAt ? { classifiedAt: input.classifiedAt } : {}),
    ...resolutionPayload,
    evidenceRefs: input.evidenceRefs,
    ...(input.providerEvidence ? { providerEvidence: input.providerEvidence } : {}),
    ...(input.retryBudgetRef ? { retryBudgetRef: input.retryBudgetRef } : {}),
    ...(input.recoveryDecisionRef ? { recoveryDecisionRef: input.recoveryDecisionRef } : {}),
  };

  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const existing = toRuntimeExceptionRecord(await getResourceByKeyPg(tx, RUNTIME_EXCEPTION_RESOURCE_TYPE, resourceKey));
    if (existing) {
      await appendObservedHistoryOncePg(tx, existing);
      return existing;
    }

    await upsertRuntimeResourcePg(tx, {
      id: exceptionId,
      resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
      resourceKey,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: runtimeExceptionScope(input),
      status,
      title: `${input.kind} runtime exception`,
      payload,
      summary: {
        source: input.source,
        kind: input.kind,
        severity: input.severity,
        observedAt: input.observedAt,
      },
    });

    const record = requireRuntimeExceptionRecord(await getResourceByKeyPg(tx, RUNTIME_EXCEPTION_RESOURCE_TYPE, resourceKey));
    await appendObservedHistoryOncePg(tx, record);
    return record;
  });
}

export async function listUnresolvedRuntimeExceptionsPg(
  db: SouthstarDb,
  input: { runId?: string },
): Promise<RuntimeExceptionRecord[]> {
  const rows = await db.query<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = $1
        and ($2::text is null or run_id = $2)
        and status <> 'resolved'
      order by created_at, resource_key`,
    [RUNTIME_EXCEPTION_RESOURCE_TYPE, input.runId ?? null],
  );
  return rows.rows
    .map(mapRuntimeResourceRow)
    .map(toRuntimeExceptionRecord)
    .filter((record): record is RuntimeExceptionRecord => Boolean(record));
}

export async function resolveRuntimeExceptionPg(
  db: SouthstarDb,
  input: { runId: string; resourceKey: string; resolvedAt: string; reason: string },
): Promise<RuntimeExceptionRecord> {
  return await db.tx(async (tx) => {
    const current = requireRuntimeExceptionRecord(await getRuntimeExceptionByKeyForUpdatePg(tx, input.resourceKey));
    if (current.runId !== input.runId) throw new Error(`runtime exception ${input.resourceKey} does not belong to run ${input.runId}`);
    if (current.status === "resolved") return current;

    const payload: RuntimeExceptionPayload = {
      ...current.payload,
      status: "resolved",
      resolvedAt: input.resolvedAt,
      resolvedReason: input.reason,
    };

    await upsertRuntimeResourcePg(tx, {
      id: current.id,
      resourceType: RUNTIME_EXCEPTION_RESOURCE_TYPE,
      resourceKey: current.resourceKey,
      runId: current.runId,
      taskId: current.taskId,
      sessionId: current.sessionId,
      scope: current.scope,
      status: "resolved",
      title: `${current.payload.kind} runtime exception`,
      payload,
      summary: {
        source: current.payload.source,
        kind: current.payload.kind,
        severity: current.payload.severity,
        resolvedAt: input.resolvedAt,
        reason: input.reason,
      },
    });

    await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      taskId: current.taskId,
      sessionId: current.sessionId,
      eventType: "runtime_exception.resolved",
      actorType: "orchestrator",
      idempotencyKey: `${current.resourceKey}:resolved`,
      payload: {
        exceptionId: current.exceptionId,
        resourceKey: current.resourceKey,
        resolvedAt: input.resolvedAt,
        reason: input.reason,
      },
    });

    return requireRuntimeExceptionRecord(await getResourceByKeyPg(tx, RUNTIME_EXCEPTION_RESOURCE_TYPE, input.resourceKey));
  });
}

async function getRuntimeExceptionByKeyForUpdatePg(
  db: SouthstarDb,
  resourceKey: string,
): Promise<RuntimeResourceRecord | null> {
  const row = await db.maybeOne<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
      where resource_type = $1
        and resource_key = $2
      for update`,
    [RUNTIME_EXCEPTION_RESOURCE_TYPE, resourceKey],
  );
  return row ? mapRuntimeResourceRow(row) : null;
}

function runtimeExceptionResourceKey(input: RuntimeExceptionRecordInput): string {
  const scope = runtimeExceptionScope(input);
  return `runtime_exception:${input.runId}:${scope}:${runtimeExceptionFingerprint(input)}`;
}

function runtimeExceptionId(input: RuntimeExceptionRecordInput): string {
  return `runtime-exception-${runtimeExceptionFingerprint(input)}`;
}

function runtimeExceptionFingerprint(input: RuntimeExceptionRecordInput): string {
  return createHash("sha256")
    .update(stableStringify({
      runId: input.runId,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      handId: input.handExecutionId ?? input.handBindingId ?? null,
      brainBindingId: input.brainBindingId ?? null,
      source: input.source,
      kind: input.kind,
    }))
    .digest("hex")
    .slice(0, 16);
}

function runtimeExceptionScope(input: RuntimeExceptionRecordInput): string {
  if (input.handExecutionId || input.handBindingId) return "hand";
  if (input.brainBindingId) return "brain";
  if (input.taskId) return "task";
  return "run";
}

async function appendHistoryEventOncePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId?: string;
    sessionId?: string;
    eventType: string;
    actorType: string;
    idempotencyKey: string;
    payload: unknown;
  },
): Promise<void> {
  await db.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, input.idempotencyKey],
  );
  if (existing) return;

  await appendHistoryEventPg(db, input);
}

async function appendObservedHistoryOncePg(db: SouthstarDb, record: RuntimeExceptionRecord): Promise<void> {
  await appendHistoryEventOncePg(db, {
    runId: record.runId,
    taskId: record.taskId,
    sessionId: record.sessionId,
    eventType: "runtime_exception.observed",
    actorType: "orchestrator",
    idempotencyKey: `${record.resourceKey}:observed`,
    payload: {
      exceptionId: record.exceptionId,
      resourceKey: record.resourceKey,
      source: record.payload.source,
      kind: record.payload.kind,
      severity: record.payload.severity,
      observedAt: record.payload.observedAt,
      evidenceRefs: record.payload.evidenceRefs,
    },
  });
}

function requireRuntimeExceptionRecord(resource: RuntimeResourceRecord | null): RuntimeExceptionRecord {
  const record = toRuntimeExceptionRecord(resource);
  if (!record) throw new Error("runtime exception not found");
  return record;
}

function toRuntimeExceptionRecord(resource: RuntimeResourceRecord | null): RuntimeExceptionRecord | null {
  if (!resource) return null;
  const payload = resource.payload as Partial<RuntimeExceptionPayload>;
  if (
    resource.resourceType !== RUNTIME_EXCEPTION_RESOURCE_TYPE ||
    !resource.runId ||
    typeof payload.exceptionId !== "string" ||
    payload.schemaVersion !== RUNTIME_EXCEPTION_SCHEMA_VERSION
  ) {
    return null;
  }

  return {
    id: resource.id,
    exceptionId: payload.exceptionId,
    resourceKey: resource.resourceKey,
    runId: resource.runId,
    taskId: resource.taskId,
    sessionId: resource.sessionId,
    scope: resource.scope,
    status: resource.status as RuntimeExceptionStatus,
    payload: payload as RuntimeExceptionPayload,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

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

function mapRuntimeResourceRow(row: RuntimeResourceRow): RuntimeResourceRecord {
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

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
