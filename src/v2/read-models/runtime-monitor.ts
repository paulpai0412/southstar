import { listHistoryForRun } from "../stores/history-store.ts";
import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildRuntimeMonitorData(db: SouthstarDb, runId: string) {
  const run = db.prepare("select id, status from workflow_runs where id = ?").get(runId) as { id: string; status: string } | undefined;
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
    runningTaskIds: (db.prepare("select id from workflow_tasks where run_id = ? and status = 'running' order by sort_order").all(runId) as Array<{ id: string }>).map((task) => task.id),
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
