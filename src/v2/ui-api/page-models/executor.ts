import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";
import type { UiIntegrationHealth } from "./types.ts";

type BindingPayload = {
  torkJobId?: string;
  externalJobId?: string;
  image?: string;
  southstarExecutorStatus?: string;
  runnerPhase?: string;
  heartbeatSeq?: number;
  lastHeartbeatAt?: string;
  queueTimeoutAt?: string;
  heartbeatTimeoutAt?: string;
  hardTimeoutAt?: string;
  torkObservedStatus?: string;
  lastReconcileAt?: string;
  reconcileGeneration?: number;
};

export function buildExecutorOpsPageModel(db: SouthstarDb, input: { jobId?: string } = {}) {
  const bindings = listResources(db, { resourceType: "executor_binding" });
  const commandResources = listResources(db, { resourceType: "executor_job_command" });
  const reconcileResources = listResources(db, { resourceType: "executor_reconcile_result" });
  const jobs = bindings.map((resource) => {
    const payload = resource.payload as BindingPayload;
    const runId = resource.runId ?? undefined;
    const taskId = resource.taskId ?? undefined;
    const latestReconcile = reconcileResources
      .filter((item) => {
        const reconcilePayload = item.payload as { bindingId?: string; classification?: string };
        return reconcilePayload.bindingId === resource.id;
      })
      .at(-1);
    const latestCommand = commandResources
      .filter((item) => {
        const commandPayload = item.payload as { bindingId?: string; jobId?: string };
        return commandPayload.bindingId === resource.id
          || commandPayload.jobId === payload.torkJobId
          || commandPayload.jobId === payload.externalJobId;
      })
      .at(-1);
    return {
      jobId: payload.torkJobId ?? payload.externalJobId ?? resource.resourceKey,
      runId,
      taskId,
      status: resource.status,
      image: payload.image ?? "southstar/pi-agent:local",
      resourceId: resource.id,
      statusLayers: {
        workflowTaskStatus: taskStatus(db, runId, taskId) ?? "unknown",
        executorStatus: payload.southstarExecutorStatus ?? resource.status,
        runnerStatus: payload.runnerPhase ?? "no-heartbeat-yet",
        evaluatorStatus: evaluatorStatus(db, runId, taskId),
      },
      heartbeat: {
        seq: payload.heartbeatSeq ?? 0,
        lastHeartbeatAt: payload.lastHeartbeatAt ?? null,
        lastHeartbeatAgeMs: heartbeatAgeMs(payload.lastHeartbeatAt),
        torkObservedStatus: payload.torkObservedStatus ?? null,
      },
      reconcile: {
        lastReconcileAt: payload.lastReconcileAt ?? latestReconcile?.updatedAt ?? null,
        lastClassification: latestReconcile
          ? ((latestReconcile.payload as { classification?: string }).classification ?? latestReconcile.status)
          : null,
        reconcileGeneration: payload.reconcileGeneration ?? 0,
      },
      lastAction: latestCommand ? {
        action: ((latestCommand.payload as { action?: string }).action ?? latestCommand.status),
        status: latestCommand.status,
        updatedAt: latestCommand.updatedAt,
      } : null,
      deadlines: {
        queueTimeoutAt: payload.queueTimeoutAt ?? null,
        heartbeatTimeoutAt: payload.heartbeatTimeoutAt ?? null,
        hardTimeoutAt: payload.hardTimeoutAt ?? null,
      },
    };
  });
  const selectedJob = jobs.find((job) => job.jobId === input.jobId) ?? jobs[0];
  return {
    surface: "southstar.ui.executor.v1" as const,
    jobs,
    selectedJob: selectedJob ? {
      ...selectedJob,
      actions: [
        { label: "Retry Job", command: "retry-job" },
        { label: "Cancel Job", command: "cancel-job" },
        { label: "Reconcile", command: "reconcile-job" },
      ],
      commands: commandResources.filter((resource) => (resource.payload as { jobId?: string }).jobId === selectedJob.jobId),
      reconcileResults: reconcileResources
        .filter((resource) => resource.taskId === selectedJob.taskId || resource.runId === selectedJob.runId)
        .slice(-5),
    } : undefined,
    workerPool: [{ worker: "tork-docker", status: bindings.length > 0 ? "bound" : "idle" }],
    integrationHealth: [
      { service: "Tork API", status: bindings.length > 0 ? "healthy" : "needs-binding", binding: bindings.length > 0 ? "api-bound" : "not-bound", notes: `${bindings.length} executor binding(s)` },
      { service: "Docker Runtime", status: "healthy", binding: "api-bound", notes: "Task images execute outside workflow truth" },
    ] satisfies UiIntegrationHealth[],
    reconcileStatus: commandResources.at(-1)?.status ?? "not-requested",
  };
}

function heartbeatAgeMs(lastHeartbeatAt: string | undefined): number | null {
  if (!lastHeartbeatAt) return null;
  const ms = Date.now() - Date.parse(lastHeartbeatAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function taskStatus(db: SouthstarDb, runId?: string, taskId?: string): string | undefined {
  if (!runId || !taskId) return undefined;
  const row = db.prepare("select status from workflow_tasks where run_id = ? and id = ?").get(runId, taskId) as { status: string } | undefined;
  return row?.status;
}

function evaluatorStatus(db: SouthstarDb, runId?: string, taskId?: string): string {
  if (!runId || !taskId) return "pending";
  const row = db.prepare("select status from runtime_resources where run_id = ? and task_id = ? and resource_type = 'evaluator_result' order by updated_at desc limit 1").get(runId, taskId) as { status: string } | undefined;
  if (!row) return "pending";
  return row.status === "ok" ? "passed" : row.status;
}
