// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listHistoryForRun } from "../../stores/history-store.ts";
import { listResources } from "../../stores/resource-store.ts";
import type { UiIntegrationHealth } from "./types.ts";
import { getRunRow, resourcesForRun } from "./internal.ts";

export type RuntimeMonitorPageModel = {
  surface: "southstar.ui.runtime-monitor.v1";
  run: { runId: string; status: string; domain: string; goalPrompt: string };
  kpis: Record<string, { label: string; value: number | string }>;
  events: Array<{ sequence: number; eventType: string; actorType: string; taskId?: string; createdAt: string }>;
  executorJobs: Array<{ jobId: string; status: string; runId?: string; taskId?: string }>;
  artifactProgress: Array<{ id: string; status: string; taskId?: string; title?: string | null }>;
  evaluatorPipeline: Array<{ id: string; status: string; taskId?: string; ok?: boolean }>;
  stopGate: { status: string; passed: boolean; resourceId?: string };
  integrationHealth: UiIntegrationHealth[];
  alerts: string[];
};

export function buildRuntimeMonitorPageModel(db: SouthstarDb, input: { runId: string }): RuntimeMonitorPageModel {
  const run = getRunRow(db, input.runId);
  const tasks = db.prepare("select id, status from workflow_tasks where run_id = ?").all(input.runId) as Array<{ id: string; status: string }>;
  const events = listHistoryForRun(db, input.runId);
  const executorBindings = resourcesForRun(db, input.runId, "executor_binding");
  const artifacts = resourcesForRun(db, input.runId, "artifact");
  const evaluators = [
    ...resourcesForRun(db, input.runId, "evaluator_pipeline_result"),
    ...resourcesForRun(db, input.runId, "evaluator_result"),
  ];
  const stop = resourcesForRun(db, input.runId, "stop_condition_result").at(-1);
  const activeTasks = tasks.filter((task) => ["running", "pending", "queued"].includes(task.status)).length;
  return {
    surface: "southstar.ui.runtime-monitor.v1",
    run: { runId: run.id, status: run.status, domain: run.domain, goalPrompt: run.goal_prompt },
    kpis: {
      activeTasks: { label: "Active Tasks", value: activeTasks },
      completedTasks: { label: "Completed", value: tasks.filter((task) => task.status === "completed").length },
      pendingTasks: { label: "Pending", value: tasks.filter((task) => task.status === "pending").length },
      artifacts: { label: "Artifacts", value: artifacts.length },
      evaluatorPasses: { label: "Evaluator Passes", value: evaluators.filter((resource) => resource.status === "passed").length },
      executorQueue: { label: "Executor Jobs", value: executorBindings.length },
    },
    events: events.map((event) => ({ sequence: event.sequence, eventType: event.eventType, actorType: event.actorType, taskId: event.taskId ?? undefined, createdAt: event.createdAt })),
    executorJobs: executorBindings.map((resource) => {
      const payload = resource.payload as { torkJobId?: string; externalJobId?: string };
      return { jobId: payload.torkJobId ?? payload.externalJobId ?? resource.resourceKey, status: resource.status, runId: resource.runId, taskId: resource.taskId ?? undefined };
    }),
    artifactProgress: artifacts.map((resource) => ({ id: resource.id, status: resource.status, taskId: resource.taskId ?? undefined, title: resource.title })),
    evaluatorPipeline: evaluators.map((resource) => ({ id: resource.id, status: resource.status, taskId: resource.taskId ?? undefined, ok: (resource.payload as { ok?: boolean }).ok })),
    stopGate: { status: stop?.status ?? "pending", passed: stop?.status === "passed", resourceId: stop?.id },
    integrationHealth: [
      { service: "Southstar DB", status: "healthy", binding: "api-bound", notes: "SQLite read model online" },
      { service: "Tork Executor", status: executorBindings.length > 0 ? "healthy" : "needs-binding", binding: executorBindings.length > 0 ? "api-bound" : "not-bound", notes: executorBindings.length > 0 ? "Executor binding recorded" : "No executor binding for this run" },
      { service: "Evaluator Pipeline", status: evaluators.length > 0 ? "healthy" : "degraded", binding: "api-bound", notes: `${evaluators.length} evaluator resource(s)` },
    ],
    alerts: run.status === "failed" ? ["Run failed; inspect evaluator and executor evidence."] : [],
  };
}
