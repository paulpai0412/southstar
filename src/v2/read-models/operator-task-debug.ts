import type { SouthstarDb } from "../db/postgres.ts";

export const OPERATOR_TASK_DEBUG_SCHEMA_VERSION = "southstar.read_model.operator_task_debug.v1";

type OperatorCommand = {
  id: string;
  label: string;
  endpoint?: string;
  method: "GET" | "POST";
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
};

export async function buildOperatorTaskDebugReadModelPg(db: SouthstarDb, input: { runId: string; taskId: string }) {
  const task = await db.maybeOne<{
    id: string;
    run_id: string;
    task_key: string;
    status: string;
    sort_order: number;
    depends_on_json: unknown;
    root_session_id: string | null;
    subagent_session_ids_json: unknown;
    executor_task_id: string | null;
    snapshot_json: unknown;
    metrics_json: unknown;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
  }>(
    `select id, run_id, task_key, status, sort_order, depends_on_json, root_session_id,
            subagent_session_ids_json, executor_task_id, snapshot_json, metrics_json,
            created_at, updated_at, completed_at
       from southstar.workflow_tasks
      where run_id = $1 and id = $2`,
    [input.runId, input.taskId],
  );
  if (!task) throw new Error(`workflow task not found: ${input.runId}/${input.taskId}`);

  const [historyRows, resourceRows] = await Promise.all([
    db.query<{
      id: string;
      sequence: number;
      event_type: string;
      actor_type: string;
      session_id: string | null;
      payload_json: unknown;
      created_at: Date;
    }>(
      `select id, sequence, event_type, actor_type, session_id, payload_json, created_at
         from southstar.workflow_history
        where run_id = $1 and task_id = $2
        order by sequence desc`,
      [input.runId, input.taskId],
    ),
    db.query<{
      id: string;
      resource_type: string;
      resource_key: string;
      session_id: string | null;
      scope: string;
      status: string;
      title: string | null;
      payload_json: unknown;
      summary_json: unknown;
      metrics_json: unknown;
      created_at: Date;
      updated_at: Date;
      expires_at: Date | null;
    }>(
      `select id, resource_type, resource_key, session_id, scope, status, title,
              payload_json, summary_json, metrics_json, created_at, updated_at, expires_at
         from southstar.runtime_resources
        where run_id = $1 and task_id = $2
        order by updated_at desc, resource_type, resource_key`,
      [input.runId, input.taskId],
    ),
  ]);

  const resources = resourceRows.rows.map((row) => ({
    id: row.id,
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    scope: row.scope,
    status: row.status,
    ...(row.title ? { title: row.title } : {}),
    payload: row.payload_json,
    summary: row.summary_json,
    metrics: row.metrics_json,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
  }));

  return {
    schemaVersion: OPERATOR_TASK_DEBUG_SCHEMA_VERSION,
    runId: input.runId,
    task: {
      taskId: task.id,
      taskKey: task.task_key,
      status: task.status,
      sortOrder: task.sort_order,
      dependsOn: stringArray(task.depends_on_json),
      ...(task.root_session_id ? { rootSessionId: task.root_session_id } : {}),
      subagentSessionIds: stringArray(task.subagent_session_ids_json),
      ...(task.executor_task_id ? { executorTaskId: task.executor_task_id } : {}),
      snapshot: asRecord(task.snapshot_json),
      metrics: asRecord(task.metrics_json),
      createdAt: task.created_at.toISOString(),
      updatedAt: task.updated_at.toISOString(),
      ...(task.completed_at ? { completedAt: task.completed_at.toISOString() } : {}),
    },
    history: historyRows.rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      eventType: row.event_type,
      runId: input.runId,
      taskId: input.taskId,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      actorType: row.actor_type,
      payload: row.payload_json,
      createdAt: row.created_at.toISOString(),
    })),
    resources,
    artifactRefs: resources
      .filter((resource) => resource.resourceType === "artifact_ref")
      .map((resource) => ({
        id: resource.id,
        resourceKey: resource.resourceKey,
        status: resource.status,
        ...(resource.title ? { title: resource.title } : {}),
        ...(artifactRefId(resource.payload) ? { artifactRefId: artifactRefId(resource.payload) } : {}),
        payload: resource.payload,
        summary: resource.summary,
        updatedAt: resource.updatedAt,
      })),
    actions: taskActions(input.runId, input.taskId, task.status),
  };
}

function taskActions(runId: string, taskId: string, status: string): OperatorCommand[] {
  const encodedRunId = encodeURIComponent(runId);
  const encodedTaskId = encodeURIComponent(taskId);
  return [
    command("task.retry", "Retry Task", `/api/v2/runs/${encodedRunId}/tasks/${encodedTaskId}/retry`, {
      enabled: !["completed", "passed", "cancelled"].includes(status),
      requiresConfirmation: true,
    }),
    command("task.request-revision", "Request Revision", `/api/v2/runs/${encodedRunId}/tasks/${encodedTaskId}/request-revision`, {
      enabled: ["blocked", "failed", "completed", "passed"].includes(status),
      requiresConfirmation: true,
    }),
  ];
}

function command(id: string, label: string, endpoint: string, options: { enabled: boolean; requiresConfirmation: boolean }): OperatorCommand {
  return {
    id,
    label,
    endpoint,
    method: "POST",
    enabled: options.enabled,
    requiresConfirmation: options.requiresConfirmation,
  };
}

function artifactRefId(payload: unknown): string | undefined {
  const record = asRecord(payload);
  return stringValue(record.artifactRefId) ?? stringValue(record.artifactRef);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
