// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";

export type OperationsTabPageModel = {
  surface: "southstar.ui.operations-tab.v1";
  runs: Array<{ runId: string; status: string; title: string }>;
  approvals: Array<{ id: string; runId?: string; title: string; status: string }>;
  executorHealth: Array<{ service: string; status: "healthy" | "attention" | "unknown" }>;
  releaseLanes: Array<{ runId?: string; status: string; summary: string }>;
};

export function buildOperationsTabPageModel(db: SouthstarDb, _input: {}): OperationsTabPageModel {
  const runRows = db.prepare("select id, status, goal_prompt from workflow_runs order by updated_at desc limit 20").all() as Array<{ id: string; status: string; goal_prompt: string }>;
  const approvals = listResources(db, { resourceType: "approval" });
  const executorBindings = listResources(db, { resourceType: "executor_binding" });
  const releaseResources = [
    ...listResources(db, { resourceType: "merge_result" }),
    ...listResources(db, { resourceType: "release_result" }),
  ];
  return {
    surface: "southstar.ui.operations-tab.v1",
    runs: runRows.map((run) => ({ runId: run.id, status: run.status, title: run.goal_prompt })),
    approvals: approvals.map((approval) => ({ id: approval.id, runId: approval.runId, title: approval.title ?? approval.resourceKey, status: approval.status })),
    executorHealth: [{ service: "Tork Executor", status: executorBindings.some((binding) => ["heartbeat-lost", "queue-timeout", "hard-timeout", "callback-missing", "orphaned"].includes(binding.status)) ? "attention" : "healthy" }],
    releaseLanes: releaseResources.map((resource) => ({ runId: resource.runId, status: resource.status, summary: resource.title ?? resource.resourceKey })),
  };
}
