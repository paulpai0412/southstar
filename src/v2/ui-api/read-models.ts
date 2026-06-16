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
    executorJobIds: [...new Set(
      executorBindings
        .filter((binding) => binding.runId === runId)
        .map((binding) => executorJobId(binding.payload))
        .filter((jobId): jobId is string => typeof jobId === "string"),
    )],
    runningTaskIds: listTasks(db, runId).filter((task) => task.status === "running").map((task) => task.id),
  };
}

export function buildTaskDetailModel(db: SouthstarDb, runId: string, taskId: string) {
  const task = db.prepare("select * from workflow_tasks where run_id = ? and id = ?").get(runId, taskId) as WorkflowTaskRow | undefined;
  if (!task) return null;
  const latestBinding = listResources(db, { resourceType: "executor_binding" })
    .filter((resource) => resource.runId === runId && resource.taskId === taskId)
    .at(-1);
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
    executorObservation: latestBinding ? {
      bindingId: latestBinding.id,
      status: latestBinding.status,
      payload: latestBinding.payload,
    } : null,
  };
}

export function buildSessionsMemoryModel(db: SouthstarDb, runId: string) {
  return {
    runId,
    sessions: sessionGraphResources(db).filter((resource) => resource.runId === runId),
    memoryItems: listResources(db, { resourceType: "memory_item" }).filter((resource) => resource.runId === runId),
  };
}

export function sessionGraphResources(db: SouthstarDb) {
  return [
    ...listResources(db, { resourceType: "session" }),
    ...listResources(db, { resourceType: "session_node" }),
    ...listResources(db, { resourceType: "session_checkpoint" }),
    ...listResources(db, { resourceType: "recovery_decision" }),
  ];
}

export function buildVaultMcpModel(db: SouthstarDb, runId: string) {
  return {
    runId,
    vaultLeases: listResources(db, { resourceType: "vault_lease" }).filter((resource) => resource.runId === runId),
    mcpGrants: listResources(db, { resourceType: "mcp_grant" }).filter((resource) => resource.runId === runId),
  };
}

export function buildExecutorOpsModel(db: SouthstarDb, runId: string) {
  const reconcileResources = listResources(db, { resourceType: "executor_reconcile_result" });
  const commandResources = listResources(db, { resourceType: "executor_job_command" });
  return {
    runId,
    bindings: listResources(db, { resourceType: "executor_binding" })
      .filter((resource) => resource.runId === runId)
      .map((resource) => {
        const payload = resource.payload as {
          southstarExecutorStatus?: string;
          runnerPhase?: string;
          lastHeartbeatAt?: string;
          lastReconcileAt?: string;
          reconcileGeneration?: number;
        };
        const latestReconcile = reconcileResources
          .filter((item) => (item.payload as { bindingId?: string }).bindingId === resource.id)
          .at(-1);
        const latestCommand = commandResources
          .filter((item) => (item.payload as { bindingId?: string }).bindingId === resource.id)
          .at(-1);
        return {
          id: resource.id,
          status: resource.status,
          taskId: resource.taskId,
          torkJobId: executorJobId(resource.payload),
          statusLayers: {
            workflowTaskStatus: resource.taskId ? (db.prepare("select status from workflow_tasks where run_id = ? and id = ?").get(runId, resource.taskId) as { status: string } | undefined)?.status ?? "unknown" : "unknown",
            executorStatus: payload.southstarExecutorStatus ?? resource.status,
            runnerStatus: payload.runnerPhase ?? "no-heartbeat-yet",
          },
          lastHeartbeatAt: payload.lastHeartbeatAt ?? null,
          lastHeartbeatAgeMs: heartbeatAgeMs(payload.lastHeartbeatAt),
          lastReconcileAt: payload.lastReconcileAt ?? latestReconcile?.updatedAt ?? null,
          lastClassification: latestReconcile ? ((latestReconcile.payload as { classification?: string }).classification ?? latestReconcile.status) : null,
          reconcileGeneration: payload.reconcileGeneration ?? 0,
          lastAction: latestCommand ? {
            action: ((latestCommand.payload as { action?: string }).action ?? latestCommand.status),
            status: latestCommand.status,
            updatedAt: latestCommand.updatedAt,
          } : null,
        };
      }),
  };
}

function heartbeatAgeMs(lastHeartbeatAt: string | undefined): number | null {
  if (!lastHeartbeatAt) return null;
  const ms = Date.now() - Date.parse(lastHeartbeatAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function executorJobId(payload: unknown): string | undefined {
  const record = payload as { externalJobId?: unknown; torkJobId?: unknown };
  return typeof record.externalJobId === "string"
    ? record.externalJobId
    : typeof record.torkJobId === "string"
      ? record.torkJobId
      : undefined;
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
