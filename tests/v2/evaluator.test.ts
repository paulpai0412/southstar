import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { evaluateArtifactSchema, persistEvaluatorResult } from "../../src/v2/evaluators/runner.ts";

test("evaluates required artifact fields", () => {
  assert.deepEqual(evaluateArtifactSchema({
    artifact: { summary: "ok", commandsRun: ["npm test"], risks: [] },
    requiredFields: ["summary", "commandsRun", "risks"],
  }), {
    ok: true,
    missingFields: [],
  });
  assert.deepEqual(evaluateArtifactSchema({
    artifact: { summary: "ok" },
    requiredFields: ["summary", "commandsRun"],
  }), {
    ok: false,
    missingFields: ["commandsRun"],
  });
});

test("persists evaluator result as workflow history", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());
  createWorkflowTask(db, {
    id: "task-1",
    runId: "run-1",
    taskKey: "task-implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });

  persistEvaluatorResult(db, {
    runId: "run-1",
    taskId: "task-1",
    ok: false,
    missingFields: ["commandsRun"],
  });

  const [event] = listHistoryForRun(db, "run-1");
  assert.equal(event.eventType, "evaluator.completed");
  assert.deepEqual(event.payload, { ok: false, missingFields: ["commandsRun"] });
});

function minimalRun() {
  return {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
