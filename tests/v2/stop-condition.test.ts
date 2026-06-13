import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { evaluateStopCondition } from "../../src/v2/evaluators/stop-condition.ts";

test("run cannot complete until required evaluator pipelines pass", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-stop"));
  const blocked = evaluateStopCondition(db, {
    runId: "run-stop",
    stopConditionId: "software-feature-complete",
    requiredEvaluatorPipelineIds: ["software-feature-quality", "software-verification-quality"],
  });
  assert.equal(blocked.ok, false);

  for (const pipelineId of ["software-feature-quality", "software-verification-quality"]) {
    db.prepare(`
      insert into runtime_resources (
        id, resource_type, resource_key, run_id, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
      ) values (?, 'evaluator_pipeline_result', ?, 'run-stop', 'software', 'passed', ?, ?, '{}', '{}', datetime('now'), datetime('now'))
    `).run(`eval-${pipelineId}`, `eval-${pipelineId}`, pipelineId, JSON.stringify({ pipelineId, ok: true }));
  }

  const passed = evaluateStopCondition(db, {
    runId: "run-stop",
    stopConditionId: "software-feature-complete",
    requiredEvaluatorPipelineIds: ["software-feature-quality", "software-verification-quality"],
  });
  assert.equal(passed.ok, true);
});

function minimalRun(id: string) {
  return {
    id,
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
