import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { runEvaluatorPipeline } from "../../src/v2/evaluators/pipeline.ts";

test("software feature evaluator rejects missing evidence and selects recovery", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-eval"));
  const result = runEvaluatorPipeline(db, {
    runId: "run-eval",
    taskId: "implement-feature",
    pipeline: softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === "software-feature-quality")!,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "implementation_report")!,
    artifact: { summary: "changed calc" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.recoveryStrategy, "rollback-workspace");
  assert.ok(result.findings.some((finding) => finding.field === "filesChanged"));
  const row = db.prepare("select count(*) as count from runtime_resources where resource_type = 'evaluator_pipeline_result'")
    .get() as { count: number };
  assert.equal(row.count, 1);
});

test("software feature evaluator accepts complete evidence", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-eval-ok"));
  const result = runEvaluatorPipeline(db, {
    runId: "run-eval-ok",
    taskId: "implement-feature",
    pipeline: softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === "software-feature-quality")!,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "implementation_report")!,
    artifact: {
      summary: "implemented calc sum",
      filesChanged: ["src/calc.ts", "src/cli.ts", "test/calc.test.ts", "README.md"],
      commandsRun: ["npm test"],
      testResults: [{ command: "npm test", passed: true }],
      risks: [],
      artifactEvidence: ["git diff", "npm test output"],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recoveryStrategy, undefined);
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
