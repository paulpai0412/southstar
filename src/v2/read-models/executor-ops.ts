import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildExecutorOpsData(db: SouthstarDb, runId: string) {
  return {
    runId,
    bindings: listResources(db, { resourceType: "executor_binding" })
      .filter((resource) => resource.runId === runId)
      .map((resource) => {
        const payload = resource.payload as {
          southstarExecutorStatus?: string;
          runnerPhase?: string;
          lastHeartbeatAt?: string;
        };
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
        };
      }),
  };
}

function executorJobId(payload: unknown): string | undefined {
  const record = payload as { externalJobId?: unknown; torkJobId?: unknown };
  return typeof record.externalJobId === "string"
    ? record.externalJobId
    : typeof record.torkJobId === "string"
      ? record.torkJobId
      : undefined;
}
