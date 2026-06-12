import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "./sqlite.ts";
import { appendHistoryEvent } from "./history-store.ts";
import { updateWorkflowManifest } from "./run-store.ts";

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

export type RuntimeResourceRecord = RuntimeResourceInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export function upsertRuntimeResource(db: SouthstarDb, input: RuntimeResourceInput): { id: string } {
  const now = new Date().toISOString();
  const existing = db.prepare("select id, created_at from runtime_resources where resource_type = ? and resource_key = ?")
    .get(input.resourceType, input.resourceKey) as { id: string; created_at: string } | undefined;
  const id = existing?.id ?? input.id ?? randomUUID();
  const createdAt = existing?.created_at ?? now;
  db.prepare(`
    insert into runtime_resources (
      id, resource_type, resource_key, run_id, task_id, session_id, scope, status,
      title, payload_json, summary_json, metrics_json, created_at, updated_at, expires_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      expires_at = excluded.expires_at
  `).run(
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
    createdAt,
    now,
    input.expiresAt ?? null,
  );
  return { id };
}

export function listResources(db: SouthstarDb, input: { resourceType: string; scope?: string; status?: string }): RuntimeResourceRecord[] {
  const rows = db.prepare(`
    select * from runtime_resources
    where resource_type = ?
      and (? is null or scope = ?)
      and (? is null or status = ?)
    order by created_at
  `).all(input.resourceType, input.scope ?? null, input.scope ?? null, input.status ?? null, input.status ?? null) as RuntimeResourceRow[];
  return rows.map(mapResource);
}

export function proposeMemoryDelta(db: SouthstarDb, runId: string, body: unknown): { id: string } {
  const id = randomUUID();
  upsertRuntimeResource(db, {
    id,
    resourceType: "memory_delta",
    resourceKey: id,
    runId,
    scope: "software",
    status: "proposed",
    title: "Memory delta",
    payload: body,
  });
  appendHistoryEvent(db, {
    runId,
    eventType: "memory.delta_proposed",
    actorType: "root-session",
    payload: { deltaId: id, body },
  });
  return { id };
}

export function approveMemoryDelta(db: SouthstarDb, deltaId: string): { memoryItemId: string } {
  const delta = getResourceByKey(db, "memory_delta", deltaId);
  if (!delta) throw new Error(`memory delta not found: ${deltaId}`);
  const memoryItemId = randomUUID();
  upsertRuntimeResource(db, {
    id: delta.id,
    resourceType: "memory_delta",
    resourceKey: deltaId,
    runId: delta.runId ?? undefined,
    scope: delta.scope,
    status: "approved",
    title: delta.title ?? undefined,
    payload: delta.payload,
  });
  upsertRuntimeResource(db, {
    id: memoryItemId,
    resourceType: "memory_item",
    resourceKey: memoryItemId,
    runId: delta.runId ?? undefined,
    scope: delta.scope,
    status: "approved",
    title: "Approved memory",
    payload: delta.payload,
  });
  appendHistoryEvent(db, {
    runId: delta.runId ?? "unknown",
    eventType: "memory.item_approved",
    actorType: "orchestrator",
    payload: { deltaId, memoryItemId },
  });
  return { memoryItemId };
}

export function retrieveApprovedMemory(db: SouthstarDb, scope: string, limit: number) {
  const items = listResources(db, { resourceType: "memory_item", scope, status: "approved" })
    .slice(0, limit)
    .map((resource) => ({ id: resource.id, body: resource.payload }));
  return { items, capturedAt: new Date().toISOString() };
}

export function requestWorkflowRevision(db: SouthstarDb, input: {
  runId: string;
  revisionId: string;
  reason: string;
  patch: unknown;
  idempotencyKey: string;
}): { resourceId: string } {
  const { id } = upsertRuntimeResource(db, {
    resourceType: "workflow_revision",
    resourceKey: input.revisionId,
    runId: input.runId,
    scope: "workflow",
    status: "proposed",
    title: input.reason,
    payload: { revisionId: input.revisionId, reason: input.reason, patch: input.patch },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    eventType: "workflow.revision_requested",
    actorType: "orchestrator",
    idempotencyKey: input.idempotencyKey,
    payload: { revisionId: input.revisionId, reason: input.reason, patch: input.patch },
  });
  return { resourceId: id };
}

export function validateWorkflowRevision(db: SouthstarDb, input: {
  runId: string;
  revisionId: string;
  validationResult: unknown;
  manifestFingerprint: string;
}): void {
  const revision = getResourceByKey(db, "workflow_revision", input.revisionId);
  upsertRuntimeResource(db, {
    id: revision?.id,
    resourceType: "workflow_revision",
    resourceKey: input.revisionId,
    runId: input.runId,
    scope: "workflow",
    status: "validated",
    title: revision?.title ?? "Workflow revision",
    payload: { ...(revision?.payload as Record<string, unknown> ?? {}), validationResult: input.validationResult, manifestFingerprint: input.manifestFingerprint },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    eventType: "workflow.revision_validated",
    actorType: "validator",
    payload: input,
  });
}

export function applyWorkflowExpansion(db: SouthstarDb, input: {
  runId: string;
  revisionId: string;
  workflowManifestJson: string;
  createdTasks: Array<{ id: string; taskKey: string; dependsOn: string[] }>;
}): void {
  db.exec("begin immediate");
  try {
    const revision = getResourceByKey(db, "workflow_revision", input.revisionId);
    updateWorkflowManifest(db, input.runId, input.workflowManifestJson);
    upsertRuntimeResource(db, {
      id: revision?.id,
      resourceType: "workflow_revision",
      resourceKey: input.revisionId,
      runId: input.runId,
      scope: "workflow",
      status: "applied",
      title: revision?.title ?? "Workflow revision",
      payload: { ...(revision?.payload as Record<string, unknown> ?? {}), workflowManifestJson: input.workflowManifestJson },
    });
    for (const [index, task] of input.createdTasks.entries()) {
      const now = new Date().toISOString();
      db.prepare(`
        insert into workflow_tasks (
          id, run_id, task_key, status, sort_order, depends_on_json, root_session_id,
          subagent_session_ids_json, executor_task_id, snapshot_json, metrics_json,
          created_at, updated_at, completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        input.runId,
        task.taskKey,
        "pending",
        index,
        JSON.stringify(task.dependsOn),
        null,
        JSON.stringify([]),
        null,
        JSON.stringify({ revisionId: input.revisionId }),
        JSON.stringify({}),
        now,
        now,
        null,
      );
      appendHistoryEvent(db, {
        runId: input.runId,
        taskId: task.id,
        eventType: "task.created",
        actorType: "orchestrator",
        payload: { revisionId: input.revisionId, taskKey: task.taskKey, dependsOn: task.dependsOn },
      });
    }
    appendHistoryEvent(db, {
      runId: input.runId,
      eventType: "workflow.expanded",
      actorType: "orchestrator",
      payload: { revisionId: input.revisionId, createdTasks: input.createdTasks },
    });
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function getResourceByKey(db: SouthstarDb, resourceType: string, resourceKey: string): RuntimeResourceRecord | null {
  const row = db.prepare("select * from runtime_resources where resource_type = ? and resource_key = ?")
    .get(resourceType, resourceKey) as RuntimeResourceRow | undefined;
  return row ? mapResource(row) : null;
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
  payload_json: string;
  summary_json: string;
  metrics_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

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
    payload: JSON.parse(row.payload_json),
    summary: JSON.parse(row.summary_json),
    metrics: JSON.parse(row.metrics_json),
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
