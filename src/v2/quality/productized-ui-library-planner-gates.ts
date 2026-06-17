import type { SouthstarDb } from "../stores/sqlite.ts";
import { listResources } from "../stores/resource-store.ts";

export type ProductizedPlannerGateInput = {
  runId: string;
  scenarioId: string;
  timings: {
    plannerDraftMs: number;
    validationMs: number;
    firstPlanningEventMs: number;
    draftReviewVisibleMs: number;
    operatorSheetOpenMs: number;
    appShellRouteLoadMs: number;
    e2eScenarioMs: number;
  };
  visitedUiSurfaces: string[];
};

export type ProductizedPlannerGateResult = { ok: boolean; failures: string[] };

const requiredUiSurfaces = [
  "chat-tab",
  "workflow-new-goal",
  "workflow-planning",
  "workflow-draft-review",
  "operations-tab",
  "task-inspector",
  "library-alternatives",
  "context-sources",
];

export function assertProductizedUiLibraryPlannerGates(db: SouthstarDb, input: ProductizedPlannerGateInput): ProductizedPlannerGateResult {
  const failures: string[] = [];

  if (/calc/i.test(input.scenarioId)) failures.push("E2E scenario must be non-calc");
  max(failures, "planner draft", input.timings.plannerDraftMs, 180_000);
  max(failures, "manifest validation", input.timings.validationMs, 3_000);
  max(failures, "first planning event", input.timings.firstPlanningEventMs, 10_000);
  max(failures, "Draft Review visible", input.timings.draftReviewVisibleMs, 5_000);
  max(failures, "Operator sheet open", input.timings.operatorSheetOpenMs, 300);
  max(failures, "Southstar App Shell route load", input.timings.appShellRouteLoadMs, 3_000);
  max(failures, "E2E scenario", input.timings.e2eScenarioMs, 25 * 60_000);

  const run = db.prepare("select status, goal_prompt, workflow_manifest_json from workflow_runs where id = ?")
    .get(input.runId) as { status: string; goal_prompt: string; workflow_manifest_json: string } | undefined;
  if (!run) failures.push(`run not found: ${input.runId}`);
  if (run && !["passed", "completed"].includes(run.status)) failures.push(`run must be passed/completed, got ${run.status}`);
  if (run && /calc/i.test(run.goal_prompt)) failures.push("run goal must be non-calc");

  for (const resourceType of [
    "planner_draft",
    "library_search_trace",
    "agent_composition_trace",
    "template_selection_trace",
    "planner_decision_trace",
    "run_brief",
    "repo_fact_cache",
  ]) {
    const hasResource = listResources(db, { resourceType }).some((resource) =>
      resourceType === "planner_draft"
        ? true
        : resource.runId === input.runId,
    );
    if (!hasResource) failures.push(`${resourceType} evidence is required`);
  }

  const tasks = db.prepare("select id from workflow_tasks where run_id = ? order by sort_order asc")
    .all(input.runId) as Array<{ id: string }>;
  if (tasks.length < 4) failures.push(`DAG must have at least 4 tasks, got ${tasks.length}`);
  for (const task of tasks) {
    if (!listResources(db, { resourceType: "context_packet" }).some((resource) => resource.runId === input.runId && resource.taskId === task.id)) failures.push(`task ${task.id} missing ContextPacket`);
    if (!listResources(db, { resourceType: "memory_injection_trace" }).some((resource) => resource.runId === input.runId && resource.taskId === task.id)) failures.push(`task ${task.id} missing memory injection trace`);
    if (!listResources(db, { resourceType: "artifact" }).some((resource) => resource.runId === input.runId && resource.taskId === task.id && resource.status === "accepted")) failures.push(`task ${task.id} missing accepted artifact`);
    if (!listResources(db, { resourceType: "artifact_summary" }).some((resource) => resource.runId === input.runId && resource.taskId === task.id)) failures.push(`task ${task.id} missing artifact_summary`);
  }

  if (tasks.some((task) => ["implement", "fix", "refactor"].includes(task.id))) {
    for (const reviewer of ["coding-review", "spec-alignment"]) {
      if (!tasks.some((task) => task.id === reviewer)) failures.push(`parallel review lane missing ${reviewer}`);
    }
  }

  if (run) {
    const workflow = parseJsonObject(run.workflow_manifest_json) as { tasks?: Array<{ id: string; execution?: { image?: string; mounts?: Array<{ target?: string; readonly?: boolean }> }; skillRefs?: string[]; mcpGrantRefs?: string[] }> };
    for (const task of workflow.tasks ?? []) {
      if ((task.execution?.image ?? "southstar/pi-agent:local") !== "southstar/pi-agent:local") failures.push(`task ${task.id} uses unapproved image ${task.execution?.image}`);
      if (!(task.execution?.mounts ?? []).some((mount) => mount.target === "/southstar-runs" && mount.readonly === true)) failures.push(`task ${task.id} missing readonly /southstar-runs mount`);
      if ((task.skillRefs ?? []).length === 0) failures.push(`task ${task.id} missing selected skill refs`);
      if ((task.mcpGrantRefs ?? []).length === 0) failures.push(`task ${task.id} missing selected MCP/tool grants`);
    }
  }

  if (!listResources(db, { resourceType: "evaluator_result" }).some((resource) => resource.runId === input.runId && (resource.status === "passed" || (resource.payload as { ok?: boolean }).ok === true))) failures.push("passed evaluator_result is required");
  if (!listResources(db, { resourceType: "stop_condition_result" }).some((resource) => resource.runId === input.runId && resource.status === "passed")) failures.push("passed stop_condition_result is required");

  const visited = new Set(input.visitedUiSurfaces);
  for (const surface of requiredUiSurfaces) {
    if (!visited.has(surface)) failures.push(`Southstar UI did not visit ${surface}`);
  }

  return { ok: failures.length === 0, failures };
}

function max(failures: string[], label: string, actual: number, maximum: number): void {
  if (!Number.isFinite(actual) || actual > maximum) failures.push(`${label} must be <= ${maximum}ms, got ${actual}ms`);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
