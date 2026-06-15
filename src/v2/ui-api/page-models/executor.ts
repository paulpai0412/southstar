import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";
import type { UiIntegrationHealth } from "./types.ts";

export function buildExecutorOpsPageModel(db: SouthstarDb, input: { jobId?: string } = {}) {
  const bindings = listResources(db, { resourceType: "executor_binding" });
  const commandResources = listResources(db, { resourceType: "executor_job_command" });
  const jobs = bindings.map((resource) => {
    const payload = resource.payload as { torkJobId?: string; externalJobId?: string; image?: string };
    return {
      jobId: payload.torkJobId ?? payload.externalJobId ?? resource.resourceKey,
      runId: resource.runId,
      taskId: resource.taskId ?? undefined,
      status: resource.status,
      image: payload.image ?? "southstar/pi-agent:local",
      resourceId: resource.id,
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
    } : undefined,
    workerPool: [{ worker: "tork-docker", status: bindings.length > 0 ? "bound" : "idle" }],
    integrationHealth: [
      { service: "Tork API", status: bindings.length > 0 ? "healthy" : "needs-binding", binding: bindings.length > 0 ? "api-bound" : "not-bound", notes: `${bindings.length} executor binding(s)` },
      { service: "Docker Runtime", status: "healthy", binding: "api-bound", notes: "Task images execute outside workflow truth" },
    ] satisfies UiIntegrationHealth[],
    reconcileStatus: commandResources.at(-1)?.status ?? "not-requested",
  };
}
