import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";

export type WorkflowRunInput = {
  id: string;
  status: string;
  domain: string;
  goalPrompt: string;
  workflowManifestJson: string;
  executionProjectionJson: string;
  snapshotJson: string;
  runtimeContextJson: string;
  metricsJson: string;
};

export type WorkflowRunRecord = WorkflowRunInput & {
  executorJobId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type WorkflowTaskInput = {
  id: string;
  runId: string;
  taskKey: string;
  status: string;
  sortOrder: number;
  dependsOn: string[];
  rootSessionId?: string;
  subagentSessionIds?: string[];
  executorTaskId?: string;
  snapshot?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
};

export type AppendHistoryInput = {
  runId: string;
  taskId?: string;
  eventType: string;
  actorType: string;
  sessionId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
  payload: unknown;
};

export type WorkflowHistoryEvent = {
  id: string;
  runId: string;
  taskId: string | null;
  sequence: number;
  eventType: string;
  actorType: string;
  sessionId: string | null;
  idempotencyKey: string | null;
  payload: unknown;
  createdAt: string;
};

export type RuntimeResourceInput = {
  id?: string;
  resourceType: string;
  resourceKey: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  scope: string;
  status: string;
  title?: string;
  payload: unknown;
  summary?: unknown;
  metrics?: unknown;
  expiresAt?: string;
};

export type RuntimeResourceRecord = Required<Omit<RuntimeResourceInput, "id" | "runId" | "taskId" | "sessionId" | "title" | "expiresAt">> & {
  id: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  title?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export async function createWorkflowRunPg(db: SouthstarDb, input: WorkflowRunInput): Promise<WorkflowRunRecord> {
  const now = new Date().toISOString();
  await db.query(
    `insert into southstar.workflow_runs (
      id, status, domain, goal_prompt, executor_job_id, workflow_manifest_json,
      execution_projection_json, snapshot_json, runtime_context_json, metrics_json,
      created_at, updated_at, completed_at
    ) values ($1, $2, $3, $4, null, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $10, null)`,
    [
      input.id,
      input.status,
      input.domain,
      input.goalPrompt,
      input.workflowManifestJson,
      input.executionProjectionJson,
      input.snapshotJson,
      input.runtimeContextJson,
      input.metricsJson,
      now,
    ],
  );
  return await db.one<WorkflowRunRecordRow>("select * from southstar.workflow_runs where id = $1", [input.id]).then(mapRun);
}

export async function getWorkflowRunPg(db: SouthstarDb, runId: string): Promise<WorkflowRunRecord | null> {
  const row = await db.maybeOne<WorkflowRunRecordRow>("select * from southstar.workflow_runs where id = $1", [runId]);
  return row ? mapRun(row) : null;
}

export async function updateWorkflowManifestPg(db: SouthstarDb, runId: string, workflowManifestJson: string): Promise<void> {
  await db.query("update southstar.workflow_runs set workflow_manifest_json = $1::jsonb, updated_at = now() where id = $2", [workflowManifestJson, runId]);
}

export async function updateWorkflowRunStatusPg(db: SouthstarDb, runId: string, status: string): Promise<boolean> {
  const terminal = ["completed", "passed", "failed", "cancelled"].includes(status);
  const result = await db.query(
    "update southstar.workflow_runs set status = $1, updated_at = now(), completed_at = case when $2 then coalesce(completed_at, now()) else completed_at end where id = $3",
    [status, terminal, runId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function createWorkflowTaskPg(db: SouthstarDb, input: WorkflowTaskInput): Promise<void> {
  await db.query(
    `insert into southstar.workflow_tasks (
      id, run_id, task_key, status, sort_order, depends_on_json, root_session_id,
      subagent_session_ids_json, executor_task_id, snapshot_json, metrics_json,
      created_at, updated_at, completed_at
    ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, now(), now(), null)`,
    [
      input.id,
      input.runId,
      input.taskKey,
      input.status,
      input.sortOrder,
      JSON.stringify(input.dependsOn),
      input.rootSessionId ?? null,
      JSON.stringify(input.subagentSessionIds ?? []),
      input.executorTaskId ?? null,
      JSON.stringify(input.snapshot ?? {}),
      JSON.stringify(input.metrics ?? {}),
    ],
  );
}

export async function appendHistoryEventPg(db: SouthstarDb, input: AppendHistoryInput): Promise<{ id: string; sequence: number; createdAt: string }> {
  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const next = await tx.one<{ next_sequence: number }>(
      "select coalesce(max(sequence), 0) + 1 as next_sequence from southstar.workflow_history where run_id = $1",
      [input.runId],
    );
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await tx.query(
      `insert into southstar.workflow_history (
        id, run_id, task_id, sequence, event_type, actor_type, session_id,
        idempotency_key, correlation_id, causation_id, payload_json, created_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        id,
        input.runId,
        input.taskId ?? null,
        next.next_sequence,
        input.eventType,
        input.actorType,
        input.sessionId ?? null,
        input.idempotencyKey ?? null,
        input.correlationId ?? null,
        input.causationId ?? null,
        JSON.stringify(input.payload),
        createdAt,
      ],
    );
    return { id, sequence: next.next_sequence, createdAt };
  });
}

export async function appendHistoryEventOncePg(db: SouthstarDb, input: AppendHistoryInput & { idempotencyKey: string }): Promise<{ id: string; sequence: number; createdAt: string; duplicate: boolean }> {
  return await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
    const existing = await tx.maybeOne<{ id: string; sequence: number; created_at: Date | string }>(
      "select id, sequence, created_at from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
      [input.runId, input.idempotencyKey],
    );
    if (existing) {
      return {
        id: existing.id,
        sequence: Number(existing.sequence),
        createdAt: dateString(existing.created_at),
        duplicate: true,
      };
    }

    const next = await tx.one<{ next_sequence: number }>(
      "select coalesce(max(sequence), 0) + 1 as next_sequence from southstar.workflow_history where run_id = $1",
      [input.runId],
    );
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await tx.query(
      `insert into southstar.workflow_history (
        id, run_id, task_id, sequence, event_type, actor_type, session_id,
        idempotency_key, correlation_id, causation_id, payload_json, created_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        id,
        input.runId,
        input.taskId ?? null,
        next.next_sequence,
        input.eventType,
        input.actorType,
        input.sessionId ?? null,
        input.idempotencyKey,
        input.correlationId ?? null,
        input.causationId ?? null,
        JSON.stringify(input.payload),
        createdAt,
      ],
    );
    return { id, sequence: next.next_sequence, createdAt, duplicate: false };
  });
}

export async function listHistoryForRunPg(db: SouthstarDb, runId: string): Promise<WorkflowHistoryEvent[]> {
  const rows = await db.query<WorkflowHistoryRow>("select * from southstar.workflow_history where run_id = $1 order by sequence", [runId]);
  return rows.rows.map(mapHistoryEvent);
}

export async function upsertRuntimeResourcePg(db: SouthstarDb, input: RuntimeResourceInput): Promise<{ id: string }> {
  const existing = await db.maybeOne<{ id: string; created_at: string }>(
    "select id, created_at from southstar.runtime_resources where resource_type = $1 and resource_key = $2",
    [input.resourceType, input.resourceKey],
  );
  const id = existing?.id ?? input.id ?? randomUUID();
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, run_id, task_id, session_id, scope, status,
      title, payload_json, summary_json, metrics_json, created_at, updated_at, expires_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, coalesce($13::timestamptz, now()), now(), $14)
    on conflict(resource_type, resource_key) do update set
      run_id = excluded.run_id,
      task_id = excluded.task_id,
      session_id = excluded.session_id,
      scope = excluded.scope,
      status = excluded.status,
      title = excluded.title,
      payload_json = excluded.payload_json,
      summary_json = excluded.summary_json,
      metrics_json = excluded.metrics_json,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at`,
    [
      id,
      input.resourceType,
      input.resourceKey,
      input.runId ?? null,
      input.taskId ?? null,
      input.sessionId ?? null,
      input.scope,
      input.status,
      input.title ?? null,
      JSON.stringify(input.payload),
      JSON.stringify(input.summary ?? {}),
      JSON.stringify(input.metrics ?? {}),
      existing?.created_at ?? null,
      input.expiresAt ?? null,
    ],
  );
  return { id };
}

export async function listResourcesPg(db: SouthstarDb, input: { resourceType: string; scope?: string; status?: string }): Promise<RuntimeResourceRecord[]> {
  const rows = await db.query<RuntimeResourceRow>(
    `select * from southstar.runtime_resources
     where resource_type = $1
       and ($2::text is null or scope = $2)
       and ($3::text is null or status = $3)
     order by created_at`,
    [input.resourceType, input.scope ?? null, input.status ?? null],
  );
  return rows.rows.map(mapResource);
}

export async function getResourceByKeyPg(db: SouthstarDb, resourceType: string, resourceKey: string): Promise<RuntimeResourceRecord | null> {
  const row = await db.maybeOne<RuntimeResourceRow>(
    "select * from southstar.runtime_resources where resource_type = $1 and resource_key = $2",
    [resourceType, resourceKey],
  );
  return row ? mapResource(row) : null;
}

type WorkflowRunRecordRow = {
  id: string;
  status: string;
  domain: string;
  goal_prompt: string;
  executor_job_id: string | null;
  workflow_manifest_json: unknown;
  execution_projection_json: unknown;
  snapshot_json: unknown;
  runtime_context_json: unknown;
  metrics_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

type WorkflowHistoryRow = {
  id: string;
  run_id: string;
  task_id: string | null;
  sequence: number;
  event_type: string;
  actor_type: string;
  session_id: string | null;
  idempotency_key: string | null;
  payload_json: unknown;
  created_at: Date | string;
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

function mapRun(row: WorkflowRunRecordRow): WorkflowRunRecord {
  return {
    id: row.id,
    status: row.status,
    domain: row.domain,
    goalPrompt: row.goal_prompt,
    executorJobId: row.executor_job_id,
    workflowManifestJson: stringifyJson(row.workflow_manifest_json),
    executionProjectionJson: stringifyJson(row.execution_projection_json),
    snapshotJson: stringifyJson(row.snapshot_json),
    runtimeContextJson: stringifyJson(row.runtime_context_json),
    metricsJson: stringifyJson(row.metrics_json),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
    completedAt: row.completed_at ? dateString(row.completed_at) : null,
  };
}

function mapHistoryEvent(row: WorkflowHistoryRow): WorkflowHistoryEvent {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    sequence: row.sequence,
    eventType: row.event_type,
    actorType: row.actor_type,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload_json,
    createdAt: dateString(row.created_at),
  };
}

function mapResource(row: RuntimeResourceRow): RuntimeResourceRecord {
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

function stringifyJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
