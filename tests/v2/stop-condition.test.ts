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

test("failed evaluator pipeline requires rerun pass after recovery operation", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-stop-recovery"));

  db.prepare(`
    insert into runtime_resources (
      id, resource_type, resource_key, run_id, task_id, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values (?, 'evaluator_pipeline_result', ?, 'run-stop-recovery', 'checker', 'software', 'failed', ?, ?, '{}', '{}', datetime('now', '-3 seconds'), datetime('now', '-3 seconds'))
  `).run(
    "eval-verification-failed",
    "eval-verification-failed",
    "software-verification-quality",
    JSON.stringify({
      pipelineId: "software-verification-quality",
      ok: false,
      recoveryStrategy: "fork-from-checkpoint",
    }),
  );

  db.prepare(`
    insert into runtime_resources (
      id, resource_type, resource_key, run_id, task_id, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values (?, 'recovery_decision', ?, 'run-stop-recovery', 'checker', 'session', 'queued', ?, ?, '{}', '{}', datetime('now', '-2 seconds'), datetime('now', '-2 seconds'))
  `).run(
    "recovery-1",
    "recovery-1",
    "fork-from-checkpoint",
    JSON.stringify({
      selectedStrategy: "fork-from-checkpoint",
      requestedStrategy: "fork-from-checkpoint",
    }),
  );

  db.prepare(`
    insert into runtime_resources (
      id, resource_type, resource_key, run_id, task_id, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values (?, 'session_operation', ?, 'run-stop-recovery', 'checker', 'session', 'succeeded', ?, ?, '{}', '{}', datetime('now', '-1 seconds'), datetime('now', '-1 seconds'))
  `).run(
    "session-op-1",
    "session-op-1",
    "fork",
    JSON.stringify({ type: "fork", status: "succeeded" }),
  );

  const blocked = evaluateStopCondition(db, {
    runId: "run-stop-recovery",
    stopConditionId: "software-feature-complete",
    requiredEvaluatorPipelineIds: ["software-verification-quality"],
  });

  assert.equal(blocked.ok, false);

  db.prepare(`
    insert into runtime_resources (
      id, resource_type, resource_key, run_id, task_id, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values (?, 'evaluator_pipeline_result', ?, 'run-stop-recovery', 'checker', 'software', 'passed', ?, ?, '{}', '{}', datetime('now'), datetime('now'))
  `).run(
    "eval-verification-passed",
    "eval-verification-passed",
    "software-verification-quality",
    JSON.stringify({
      pipelineId: "software-verification-quality",
      ok: true,
    }),
  );

  const recovered = evaluateStopCondition(db, {
    runId: "run-stop-recovery",
    stopConditionId: "software-feature-complete",
    requiredEvaluatorPipelineIds: ["software-verification-quality"],
  });

  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.recoveredEvaluatorPipelineIds, ["software-verification-quality"]);
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
