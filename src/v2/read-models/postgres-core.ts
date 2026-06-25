import type { SouthstarDb } from "../db/postgres.ts";
import { envelopeReadModel } from "./envelope.ts";
import { listExecutionProjectionsPg } from "./executions.ts";
import type { ReadModelInput, ReadModelKind } from "./types.ts";
import { buildUiSurfaceReadModel, isUiSurfaceReadModelKind } from "./ui-surfaces.ts";

export async function buildPostgresCoreReadModel(db: SouthstarDb, input: ReadModelInput) {
  if (isUiSurfaceReadModelKind(input.kind)) return await buildUiSurfaceReadModel(db, input);
  switch (input.kind) {
    case "run-summary":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.run_summary.v1", kind: input.kind, data: await runSummary(db, input.runId) });
    case "executions":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.executions.v1", kind: input.kind, data: { runId: input.runId, executions: await listExecutionProjectionsPg(db, input.runId) } });
    case "workflow-canvas":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.workflow_canvas.v1", kind: input.kind, data: await workflowCanvas(db, input.runId) });
    case "runtime-monitor":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.runtime_monitor.v1", kind: input.kind, data: { runtime: await runtimeMonitor(db, input.runId) } });
    case "executor-ops":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.executor_ops.v1", kind: input.kind, data: { bindings: await executorBindings(db, input.runId) } });
    case "task-detail":
      if (!input.taskId) throw new Error("taskId is required for task-detail read model");
      return envelopeReadModel({ schemaVersion: "southstar.read_model.task_detail.v1", kind: input.kind, data: await taskDetail(db, input.runId, input.taskId) });
    case "sessions-memory":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.sessions_memory.v1", kind: input.kind, data: await sessionsMemory(db, input.runId) });
    case "vault-mcp":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.vault_mcp.v1", kind: input.kind, data: await vaultMcp(db, input.runId) });
    default:
      throw new Error(`unsupported Postgres core read model: ${String((input as { kind?: ReadModelKind }).kind)}`);
  }
}

export function isPostgresCoreReadModelKind(kind: ReadModelKind): boolean {
  return [
    "run-summary",
    "executions",
    "workflow-canvas",
    "runtime-monitor",
    "executor-ops",
    "task-detail",
    "sessions-memory",
    "vault-mcp",
    "run-control",
    "workflow-dag",
  ].includes(kind);
}

async function runSummary(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ id: string; status: string; domain: string | null; goal_prompt: string }>(
    "select id, status, domain, goal_prompt from southstar.workflow_runs where id = $1",
    [runId],
  );
  if (!run) throw new Error(`run not found: ${runId}`);
  const counts = await db.query<{ status: string; count: string | number }>(
    `select status, count(*) as count
       from southstar.workflow_tasks
      where run_id = $1
      group by status
      order by status`,
    [runId],
  );
  return {
    runId: run.id,
    status: run.status,
    rawStatus: run.status,
    ...(run.domain ? { domain: run.domain } : {}),
    goalPrompt: run.goal_prompt,
    taskCounts: Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)])),
  };
}

async function workflowCanvas(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ id: string; status: string }>("select id, status from southstar.workflow_runs where id = $1", [runId]);
  const tasks = await taskRows(db, runId);
  return {
    runId,
    status: run?.status ?? "unknown",
    nodes: tasks.map((task) => ({ id: task.id, label: task.task_key, status: task.status, dependsOn: arrayValue(task.depends_on_json) })),
  };
}

async function runtimeMonitor(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
  const tasks = await taskRows(db, runId);
  const history = await db.query<{ event_type: string; payload_json: unknown }>(
    "select event_type, payload_json from southstar.workflow_history where run_id = $1 order by sequence desc limit 1",
    [runId],
  );
  const bindings = await executorBindings(db, runId);
  return {
    status: run?.status ?? "unknown",
    latestProgress: stringValue(asRecord(history.rows[0]?.payload_json).message) ?? history.rows[0]?.event_type,
    executorJobIds: bindings.map((binding) => binding.externalJobId).filter((id): id is string => Boolean(id)),
    runningTaskIds: tasks.filter((task) => task.status === "running").map((task) => task.id),
  };
}

async function executorBindings(db: SouthstarDb, runId: string) {
  const rows = await resources(db, runId, "executor_binding");
  return rows.map((row) => {
    const payload = asRecord(row.payload_json);
    return {
      id: row.resource_key,
      status: row.status,
      taskId: row.task_id ?? undefined,
      executorType: stringValue(payload.executorType),
      externalJobId: stringValue(payload.externalJobId) ?? stringValue(payload.torkJobId),
      payload,
    };
  });
}

async function taskDetail(db: SouthstarDb, runId: string, taskId: string) {
  const task = await db.maybeOne<TaskRow>("select * from southstar.workflow_tasks where run_id = $1 and id = $2", [runId, taskId]);
  if (!task) throw new Error(`task not found: ${runId}/${taskId}`);
  const context = (await resources(db, runId, "context_packet", taskId)).at(-1);
  const binding = (await resources(db, runId, "executor_binding", taskId)).at(-1);
  return {
    taskId: task.id,
    taskKey: task.task_key,
    status: task.status,
    sortOrder: task.sort_order,
    dependsOn: arrayValue(task.depends_on_json),
    rootSessionId: task.root_session_id,
    contextPacket: context?.payload_json,
    executorBinding: binding ? { id: binding.resource_key, status: binding.status, payload: binding.payload_json } : undefined,
  };
}

async function sessionsMemory(db: SouthstarDb, runId: string) {
  const sessions = await resources(db, runId, "session");
  const memory = await resources(db, runId, "memory_item");
  const memoryDeltas = await resources(db, runId, "memory_delta");
  const rollbacks = await resources(db, runId, "rollback_marker");
  return {
    sessions: sessions.map(mapResource),
    memory: memory.map(mapResource),
    memoryDeltas: memoryDeltas.map(mapResource),
    rollbacks: rollbacks.map(mapResource),
  };
}

async function vaultMcp(db: SouthstarDb, runId: string) {
  const vaultLeases = await resources(db, runId, "vault_lease");
  const mcpGrants = await resources(db, runId, "mcp_grant");
  return { vaultLeases: vaultLeases.map(mapResource), mcpGrants: mcpGrants.map(mapResource) };
}

async function taskRows(db: SouthstarDb, runId: string): Promise<TaskRow[]> {
  return (await db.query<TaskRow>("select * from southstar.workflow_tasks where run_id = $1 order by sort_order", [runId])).rows;
}

async function resources(db: SouthstarDb, runId: string, resourceType: string, taskId?: string): Promise<ResourceRow[]> {
  return (await db.query<ResourceRow>(
    `select * from southstar.runtime_resources
     where run_id = $1 and resource_type = $2 and ($3::text is null or task_id = $3)
     order by created_at, resource_key`,
    [runId, resourceType, taskId ?? null],
  )).rows;
}

type TaskRow = { id: string; task_key: string; status: string; sort_order: number; depends_on_json: unknown; root_session_id: string | null };
type ResourceRow = { resource_key: string; task_id: string | null; status: string; payload_json: unknown };

function mapResource(row: ResourceRow) {
  return { id: row.resource_key, taskId: row.task_id ?? undefined, status: row.status, payload: row.payload_json };
}

function arrayValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
