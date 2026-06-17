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
  "operator-sheet",
];

export function assertProductizedUiLibraryPlannerGates(
  db: SouthstarDb,
  input: ProductizedPlannerGateInput,
): ProductizedPlannerGateResult {
  const failures: string[] = [];

  max(failures, "planner draft", input.timings.plannerDraftMs, 180_000);
  max(failures, "manifest validation", input.timings.validationMs, 3_000);
  max(failures, "first planning event", input.timings.firstPlanningEventMs, 10_000);
  max(failures, "Draft Review visible", input.timings.draftReviewVisibleMs, 5_000);
  max(failures, "Operator sheet open", input.timings.operatorSheetOpenMs, 300);
  max(failures, "Southstar App Shell route load", input.timings.appShellRouteLoadMs, 3_000);
  max(failures, "E2E scenario", input.timings.e2eScenarioMs, 25 * 60_000);

  const run = db.prepare("select status, goal_prompt, workflow_manifest_json from workflow_runs where id = ?")
    .get(input.runId) as { status: string; goal_prompt: string; workflow_manifest_json: string } | undefined;
  if (!run) {
    failures.push(`run not found: ${input.runId}`);
  } else {
    if (!isTerminalSuccess(run.status)) failures.push(`run must be passed/completed, got ${run.status}`);

    const workflow = parseManifest(run.workflow_manifest_json);
    for (const task of workflow.tasks) {
      const taskId = task.id || "unknown-task";
      const image = task.execution?.image ?? "southstar/pi-agent:local";
      if (image !== "southstar/pi-agent:local") failures.push(`task ${taskId} uses unapproved image ${image}`);

      const hasRunMount = (task.execution?.mounts ?? []).some(
        (mount) => mount.target === "/southstar-runs" && mount.readonly === true,
      );
      if (!hasRunMount) failures.push(`task ${taskId} missing readonly /southstar-runs mount`);
      if ((task.skillRefs ?? []).length === 0) failures.push(`task ${taskId} missing selected skill refs`);
      if ((task.mcpGrantRefs ?? []).length === 0) failures.push(`task ${taskId} missing selected MCP/tool grants`);
    }
  }

  for (const resourceType of [
    "planner_draft",
    "library_search_trace",
    "agent_composition_trace",
    "template_selection_trace",
    "planner_decision_trace",
    "run_brief",
    "repo_fact_cache",
  ]) {
    if (!hasAnyResourceForRun(db, input.runId, resourceType)) {
      failures.push(`${resourceType} evidence is required`);
    }
  }

  const tasks = db.prepare("select id from workflow_tasks where run_id = ? order by sort_order")
    .all(input.runId) as Array<{ id: string }>;
  if (tasks.length < 4) failures.push(`DAG must have at least 4 tasks, got ${tasks.length}`);

  const taskIds = new Set(tasks.map((task) => task.id));
  const requiresReviewLane = ["implement", "fix", "refactor"].some((id) => taskIds.has(id));
  if (requiresReviewLane) {
    for (const reviewTaskId of ["coding-review", "spec-alignment"]) {
      if (!taskIds.has(reviewTaskId)) failures.push(`parallel review lane missing ${reviewTaskId}`);
    }
  }

  for (const task of tasks) {
    if (!hasTaskResource(db, input.runId, task.id, "context_packet")) {
      failures.push(`task ${task.id} missing ContextPacket`);
    }
    if (!hasTaskResource(db, input.runId, task.id, "memory_injection_trace")) {
      failures.push(`task ${task.id} missing memory injection trace`);
    }
    if (!hasTaskResource(db, input.runId, task.id, "task_envelope")) {
      failures.push(`task ${task.id} missing TaskEnvelopeV2`);
    }
    if (!hasTaskResource(db, input.runId, task.id, "artifact", "accepted")) {
      failures.push(`task ${task.id} missing accepted artifact`);
    }
    if (!hasTaskResourceWithStatuses(db, input.runId, task.id, "evidence_packet", ["accepted", "complete"])) {
      failures.push(`task ${task.id} missing accepted/complete evidence_packet`);
    }
  }

  const acceptedArtifacts = countResources(db, input.runId, "artifact", "accepted");
  const acceptedEvidencePackets = countResourcesWithStatuses(db, input.runId, "evidence_packet", ["accepted", "complete"]);
  if (acceptedArtifacts !== acceptedEvidencePackets) {
    failures.push(`accepted artifact count must match evidence packet count (${acceptedArtifacts} vs ${acceptedEvidencePackets})`);
  }

  if (!hasAnyResourceForRun(db, input.runId, "executor_binding")) {
    failures.push("executor binding evidence is required");
  }

  const hasPassingEvaluator = [
    ...listResources(db, { resourceType: "evaluator_result" }),
    ...listResources(db, { resourceType: "evaluator_pipeline_result" }),
  ].some((resource) =>
    resource.runId === input.runId
    && (resource.status === "passed" || (resource.payload as { ok?: boolean }).ok === true),
  );
  if (!hasPassingEvaluator) failures.push("passed evaluator_result is required");

  const hasStopCondition = listResources(db, { resourceType: "stop_condition_result" })
    .some((resource) => resource.runId === input.runId && resource.status === "passed");
  if (!hasStopCondition) failures.push("passed stop_condition_result is required");

  const visited = new Set(input.visitedUiSurfaces);
  for (const surface of requiredUiSurfaces) {
    if (!visited.has(surface)) failures.push(`Southstar UI did not visit ${surface}`);
  }

  return { ok: failures.length === 0, failures };
}

type ManifestTask = {
  id: string;
  execution?: {
    image?: string;
    mounts?: Array<{ target: string; readonly: boolean }>;
  };
  skillRefs?: string[];
  mcpGrantRefs?: string[];
};

function parseManifest(json: string): { tasks: ManifestTask[] } {
  try {
    const parsed = JSON.parse(json) as { tasks?: ManifestTask[] };
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

function hasAnyResourceForRun(db: SouthstarDb, runId: string, resourceType: string): boolean {
  return listResources(db, { resourceType }).some((resource) => resource.runId === runId);
}

function hasTaskResource(
  db: SouthstarDb,
  runId: string,
  taskId: string,
  resourceType: string,
  status?: string,
): boolean {
  return listResources(db, { resourceType }).some(
    (resource) =>
      resource.runId === runId
      && resource.taskId === taskId
      && (status === undefined || resource.status === status),
  );
}

function countResources(db: SouthstarDb, runId: string, resourceType: string, status: string): number {
  return listResources(db, { resourceType }).filter(
    (resource) => resource.runId === runId && resource.status === status,
  ).length;
}

function countResourcesWithStatuses(
  db: SouthstarDb,
  runId: string,
  resourceType: string,
  statuses: string[],
): number {
  const allowed = new Set(statuses);
  return listResources(db, { resourceType }).filter(
    (resource) => resource.runId === runId && allowed.has(resource.status),
  ).length;
}

function hasTaskResourceWithStatuses(
  db: SouthstarDb,
  runId: string,
  taskId: string,
  resourceType: string,
  statuses: string[],
): boolean {
  const allowed = new Set(statuses);
  return listResources(db, { resourceType }).some(
    (resource) =>
      resource.runId === runId
      && resource.taskId === taskId
      && allowed.has(resource.status),
  );
}

function max(failures: string[], label: string, actual: number, maximum: number): void {
  if (!Number.isFinite(actual) || actual > maximum) failures.push(`${label} must be <= ${maximum}ms, got ${actual}ms`);
}

function isTerminalSuccess(status: string): boolean {
  return status === "passed" || status === "completed";
}
