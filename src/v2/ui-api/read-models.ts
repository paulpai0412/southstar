import type { SouthstarDb } from "../stores/sqlite.ts";
import { listHistoryForRun } from "../stores/history-store.ts";
import { listResources } from "../stores/resource-store.ts";

export function buildWorkflowCanvasModel(db: SouthstarDb, runId: string) {
  const run = getRun(db, runId);
  return {
    runId,
    status: run?.status ?? "unknown",
    nodes: listTasks(db, runId).map((task) => ({
      id: task.id,
      label: task.task_key,
      status: task.status,
      dependsOn: JSON.parse(task.depends_on_json) as string[],
    })),
  };
}

export function buildRuntimeMonitorModel(db: SouthstarDb, runId: string) {
  const run = getRun(db, runId);
  const history = listHistoryForRun(db, runId);
  const latestProgress = [...history].reverse().find((event) => event.eventType === "progress.commentary")?.payload as { message?: string } | undefined;
  const latestSteering = [...history].reverse().find((event) => event.eventType === "steering.received")?.payload as { message?: string } | undefined;
  const executorBindings = listResources(db, { resourceType: "executor_binding" });
  return {
    runId,
    status: run?.status ?? "unknown",
    latestProgress: latestProgress?.message,
    latestSteering: latestSteering?.message,
    executorJobIds: executorBindings
      .filter((binding) => binding.runId === runId)
      .map((binding) => (binding.payload as { torkJobId?: string }).torkJobId)
      .filter((jobId): jobId is string => typeof jobId === "string"),
    runningTaskIds: listTasks(db, runId).filter((task) => task.status === "running").map((task) => task.id),
  };
}

export function buildTaskDetailModel(db: SouthstarDb, runId: string, taskId: string) {
  const task = db.prepare("select * from workflow_tasks where run_id = ? and id = ?").get(runId, taskId) as WorkflowTaskRow | undefined;
  if (!task) return null;
  return {
    id: task.id,
    runId: task.run_id,
    taskKey: task.task_key,
    status: task.status,
    dependsOn: JSON.parse(task.depends_on_json) as string[],
    rootSessionId: task.root_session_id,
    subagentSessionIds: JSON.parse(task.subagent_session_ids_json) as string[],
    executorTaskId: task.executor_task_id,
    snapshot: JSON.parse(task.snapshot_json) as unknown,
    metrics: JSON.parse(task.metrics_json) as unknown,
  };
}

export function buildSessionsMemoryModel(db: SouthstarDb, runId: string) {
  return {
    runId,
    sessions: listResources(db, { resourceType: "session" }).filter((resource) => resource.runId === runId),
    memoryItems: listResources(db, { resourceType: "memory_item" }).filter((resource) => resource.runId === runId),
  };
}

export function buildVaultMcpModel(db: SouthstarDb, runId: string) {
  return {
    runId,
    vaultLeases: listResources(db, { resourceType: "vault_lease" }).filter((resource) => resource.runId === runId),
    mcpGrants: listResources(db, { resourceType: "mcp_grant" }).filter((resource) => resource.runId === runId),
  };
}

export function buildExecutorOpsModel(db: SouthstarDb, runId: string) {
  return {
    runId,
    bindings: listResources(db, { resourceType: "executor_binding" })
      .filter((resource) => resource.runId === runId)
      .map((resource) => ({
        id: resource.id,
        status: resource.status,
        taskId: resource.taskId,
        torkJobId: (resource.payload as { torkJobId?: string }).torkJobId,
      })),
  };
}

function getRun(db: SouthstarDb, runId: string): { id: string; status: string } | undefined {
  return db.prepare("select id, status from workflow_runs where id = ?").get(runId) as { id: string; status: string } | undefined;
}

function listTasks(db: SouthstarDb, runId: string): WorkflowTaskRow[] {
  return db.prepare("select * from workflow_tasks where run_id = ? order by sort_order").all(runId) as WorkflowTaskRow[];
}

type WorkflowTaskRow = {
  id: string;
  run_id: string;
  task_key: string;
  status: string;
  sort_order: number;
  depends_on_json: string;
  root_session_id: string | null;
  subagent_session_ids_json: string;
  executor_task_id: string | null;
  snapshot_json: string;
  metrics_json: string;
};
