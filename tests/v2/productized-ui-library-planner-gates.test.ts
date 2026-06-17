import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { assertProductizedUiLibraryPlannerGates } from "../../src/v2/quality/productized-ui-library-planner-gates.ts";

test("productized planner gates pass with durable non-calc UI->runtime evidence", () => {
  const db = openSouthstarDb(":memory:");
  const taskIds = ["explore", "implement", "coding-review", "spec-alignment", "browser-qa", "summarize"];

  createWorkflowRun(db, {
    id: "run-productized",
    status: "passed",
    domain: "software",
    goalPrompt: "todo-web priority labels and overdue filter",
    workflowManifestJson: JSON.stringify({
      tasks: taskIds.map((id) => ({
        id,
        execution: {
          image: "southstar/pi-agent:local",
          mounts: [{ target: "/southstar-runs", readonly: true }],
        },
        skillRefs: [`software.${id}`],
        mcpGrantRefs: id === "implement" ? ["filesystem.workspace-write", "shell.test-runner"] : ["filesystem.readonly"],
      })),
    }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({ aggregate: { tokens: 220, costUsd: 0.04, toolCalls: 22, retryCount: 1 } }),
  });

  for (const [index, taskId] of taskIds.entries()) {
    createWorkflowTask(db, {
      id: taskId,
      runId: "run-productized",
      taskKey: taskId,
      status: "completed",
      sortOrder: index,
      dependsOn: index === 0 ? [] : [taskIds[index - 1]!],
      rootSessionId: `root-${taskId}`,
    });

    upsertRuntimeResource(db, {
      resourceType: "context_packet",
      resourceKey: `ctx-${taskId}`,
      runId: "run-productized",
      taskId,
      scope: "task",
      status: "created",
      payload: { id: `ctx-${taskId}` },
    });

    upsertRuntimeResource(db, {
      resourceType: "memory_injection_trace",
      resourceKey: `mem-${taskId}`,
      runId: "run-productized",
      taskId,
      scope: "task",
      status: "created",
      payload: { included: [], excluded: [], decisionReason: "seeded" },
    });

    upsertRuntimeResource(db, {
      resourceType: "task_envelope",
      resourceKey: `env-${taskId}`,
      runId: "run-productized",
      taskId,
      scope: "task",
      status: "created",
      payload: { schemaVersion: "southstar.task-envelope.v2" },
    });

    upsertRuntimeResource(db, {
      resourceType: "artifact",
      resourceKey: `artifact-${taskId}`,
      runId: "run-productized",
      taskId,
      scope: "task",
      status: "accepted",
      payload: { summary: taskId, evidence: true, risks: [] },
    });

    upsertRuntimeResource(db, {
      resourceType: "evidence_packet",
      resourceKey: `evidence-${taskId}`,
      runId: "run-productized",
      taskId,
      scope: "task",
      status: "accepted",
      payload: { completeness: { requiredCount: 3, presentCount: 3, missingKinds: [] } },
    });
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
    upsertRuntimeResource(db, {
      resourceType,
      resourceKey: `${resourceType}-1`,
      runId: "run-productized",
      scope: "planner",
      status: "created",
      payload: { ok: true },
    });
  }

  upsertRuntimeResource(db, {
    resourceType: "executor_binding",
    resourceKey: "exec-1",
    runId: "run-productized",
    scope: "executor",
    status: "queued",
    payload: { torkJobId: "job-1" },
  });

  upsertRuntimeResource(db, {
    resourceType: "evaluator_result",
    resourceKey: "eval-1",
    runId: "run-productized",
    scope: "workflow",
    status: "passed",
    payload: { ok: true },
  });

  upsertRuntimeResource(db, {
    resourceType: "stop_condition_result",
    resourceKey: "stop-1",
    runId: "run-productized",
    scope: "run",
    status: "passed",
    payload: { ok: true },
  });

  const result = assertProductizedUiLibraryPlannerGates(db, {
    runId: "run-productized",
    scenarioId: "todo-web-feature",
    timings: {
      plannerDraftMs: 1_000,
      validationMs: 120,
      firstPlanningEventMs: 300,
      draftReviewVisibleMs: 450,
      operatorSheetOpenMs: 120,
      appShellRouteLoadMs: 400,
      e2eScenarioMs: 120_000,
    },
    visitedUiSurfaces: [
      "chat-tab",
      "workflow-new-goal",
      "workflow-planning",
      "workflow-draft-review",
      "operations-tab",
      "task-inspector",
      "library-alternatives",
      "context-sources",
      "operator-sheet",
    ],
  });

  assert.deepEqual(result, { ok: true, failures: [] });
});

test("productized planner gates fail closed when context economy and evidence are missing", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-missing-evidence",
    status: "running",
    domain: "software",
    goalPrompt: "todo-web feature",
    workflowManifestJson: JSON.stringify({ tasks: [{ id: "implement", execution: { image: "southstar/custom:latest", mounts: [] }, skillRefs: [], mcpGrantRefs: [] }] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({ aggregate: {} }),
  });
  createWorkflowTask(db, {
    id: "implement",
    runId: "run-missing-evidence",
    taskKey: "implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });

  const result = assertProductizedUiLibraryPlannerGates(db, {
    runId: "run-missing-evidence",
    scenarioId: "markdown-table-bugfix",
    timings: {
      plannerDraftMs: 200_000,
      validationMs: 4_000,
      firstPlanningEventMs: 20_000,
      draftReviewVisibleMs: 8_000,
      operatorSheetOpenMs: 600,
      appShellRouteLoadMs: 5_000,
      e2eScenarioMs: 26 * 60_000,
    },
    visitedUiSurfaces: ["workflow-planning"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.some((failure) => /run must be passed\/completed/.test(failure)), true);
  assert.equal(result.failures.some((failure) => /planner draft/.test(failure)), true);
  assert.equal(result.failures.some((failure) => /unapproved image/.test(failure)), true);
  assert.equal(result.failures.some((failure) => /ContextPacket/.test(failure)), true);
  assert.equal(result.failures.some((failure) => /Southstar UI did not visit chat-tab/.test(failure)), true);
});
