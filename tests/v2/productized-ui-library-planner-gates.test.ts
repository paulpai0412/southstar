import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { assertProductizedUiLibraryPlannerGates } from "../../src/v2/quality/productized-ui-library-planner-gates.ts";

test("productized planner gates pass with durable non-calc evidence", () => {
  const db = openSouthstarDb(":memory:");
  const taskIds = ["explore", "implement", "coding-review", "spec-alignment", "browser-qa", "summarize"];
  createWorkflowRun(db, {
    id: "run-productized",
    status: "passed",
    domain: "software",
    goalPrompt: "todo-web priority labels",
    workflowManifestJson: JSON.stringify({
      tasks: taskIds.map((id) => ({
        id,
        execution: { image: "southstar/pi-agent:local", mounts: [{ target: "/southstar-runs", readonly: true }] },
        skillRefs: [`software.${id}`],
        mcpGrantRefs: [id === "implement" ? "filesystem.workspace-write" : "filesystem.readonly"],
      })),
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: JSON.stringify({ aggregate: { tokens: 100, costUsd: 0, toolCalls: 10, retryCount: 1 } }),
  });
  for (const [index, id] of taskIds.entries()) {
    createWorkflowTask(db, {
      id,
      runId: "run-productized",
      taskKey: id,
      status: "completed",
      sortOrder: index,
      dependsOn: id === "implement"
        ? ["explore"]
        : ["coding-review", "spec-alignment", "browser-qa"].includes(id)
          ? ["implement"]
          : id === "summarize"
            ? ["coding-review", "spec-alignment", "browser-qa"]
            : [],
      rootSessionId: `root-${id}`,
      snapshot: {},
    });
    upsertRuntimeResource(db, { resourceType: "context_packet", resourceKey: `ctx-${id}`, runId: "run-productized", taskId: id, scope: "test", status: "created", payload: { tokenEstimate: { total: 1000 } } });
    upsertRuntimeResource(db, { resourceType: "memory_injection_trace", resourceKey: `mem-${id}`, runId: "run-productized", taskId: id, scope: "test", status: "created", payload: { included: [], excluded: [], decisionReason: "test" } });
    upsertRuntimeResource(db, { resourceType: "artifact", resourceKey: `artifact-${id}`, runId: "run-productized", taskId: id, scope: "test", status: "accepted", payload: { summary: id, evidence: true, risks: [] } });
    upsertRuntimeResource(db, { resourceType: "artifact_summary", resourceKey: `artifact-summary-${id}`, runId: "run-productized", taskId: id, scope: "test", status: "created", payload: { summary: id, evidenceRefs: [`evidence-${id}`], validatorRefs: [`validator-${id}`] } });
  }
  for (const resourceType of ["planner_draft", "library_search_trace", "agent_composition_trace", "template_selection_trace", "planner_decision_trace", "run_brief", "repo_fact_cache"]) {
    upsertRuntimeResource(db, { resourceType, resourceKey: `${resourceType}-1`, runId: resourceType === "planner_draft" ? undefined : "run-productized", scope: "test", status: "created", payload: resourceType === "agent_composition_trace" ? ["software.implementer", "software.coding-reviewer", "software.spec-alignment"] : { ok: true } });
  }
  upsertRuntimeResource(db, { resourceType: "evaluator_result", resourceKey: "eval-1", runId: "run-productized", scope: "test", status: "passed", payload: { ok: true } });
  upsertRuntimeResource(db, { resourceType: "stop_condition_result", resourceKey: "stop-1", runId: "run-productized", scope: "test", status: "passed", payload: { ok: true } });

  const result = assertProductizedUiLibraryPlannerGates(db, {
    runId: "run-productized",
    scenarioId: "todo-web-feature",
    timings: {
      plannerDraftMs: 1000,
      validationMs: 100,
      firstPlanningEventMs: 500,
      draftReviewVisibleMs: 500,
      operatorSheetOpenMs: 100,
      appShellRouteLoadMs: 500,
      e2eScenarioMs: 60_000,
    },
    visitedUiSurfaces: ["chat-tab", "workflow-new-goal", "workflow-planning", "workflow-draft-review", "operations-tab", "task-inspector", "library-alternatives", "context-sources", "operator-sheet"],
  });
  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("productized planner gates fail closed for calc scenario or missing context economy", () => {
  const db = openSouthstarDb(":memory:");
  const result = assertProductizedUiLibraryPlannerGates(db, {
    runId: "missing",
    scenarioId: "calc-feature",
    timings: {
      plannerDraftMs: 181_000,
      validationMs: 4_000,
      firstPlanningEventMs: 11_000,
      draftReviewVisibleMs: 6_000,
      operatorSheetOpenMs: 400,
      appShellRouteLoadMs: 4_000,
      e2eScenarioMs: 26 * 60_000,
    },
    visitedUiSurfaces: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /non-calc|run not found|planner draft|Southstar UI/);
});
