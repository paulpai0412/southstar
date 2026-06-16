import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildExecutorOpsData(db: SouthstarDb, runId: string) {
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
