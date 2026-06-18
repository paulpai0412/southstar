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

test("software feature evaluator rejects failed command evidence", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-eval-failed-tests"));
  const result = runEvaluatorPipeline(db, {
    runId: "run-eval-failed-tests",
    taskId: "implement-feature",
    pipeline: softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === "software-feature-quality")!,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "implementation_report")!,
    artifact: {
      summary: "claimed calc sum was implemented",
      filesChanged: ["src/calc.ts"],
      commandsRun: ["npm test", "npm run -s cli -- sum 1 2 3"],
      testResults: [
        { command: "npm test", status: "failed", exitCode: 1 },
        { command: "npm run -s cli -- sum 1 2 3", status: "failed", exitCode: 1 },
      ],
      risks: [],
      artifactEvidence: {
        testResults: [{ command: "npm test", status: "failed", exitCode: 1 }],
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.recoveryStrategy, "rollback-workspace");
  assert.ok(result.findings.some((finding) => finding.field.startsWith("testResults")));
});

test("software feature evaluator rejects failed object-map test results", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-eval-object-map-fail"));
  const result = runEvaluatorPipeline(db, {
    runId: "run-eval-object-map-fail",
    taskId: "implement-feature",
    pipeline: softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === "software-feature-quality")!,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "implementation_report")!,
    artifact: {
      summary: "implemented calc sum",
      filesChanged: ["src/calc.ts"],
      commandsRun: ["npm test"],
      testResults: {
        repositoryTests: {
          status: "failed",
          gating: "blocking",
          details: "2 failed",
        },
      },
      risks: [],
      artifactEvidence: ["npm test output"],
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.recoveryStrategy, "rollback-workspace");
  assert.ok(result.findings.some((finding) => finding.field === "testResults.repositoryTests"));
});

test("software feature evaluator ignores non-gating failure evidence", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-eval-non-gating"));
  const result = runEvaluatorPipeline(db, {
    runId: "run-eval-non-gating",
    taskId: "implement-feature",
    pipeline: softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === "software-feature-quality")!,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "implementation_report")!,
    artifact: {
      summary: "implemented calc sum",
      filesChanged: ["src/calc.ts", "README.md"],
      commandsRun: ["npm test", "npm run lint"],
      testResults: {
        repositoryTests: {
          status: "passed",
          gating: "blocking",
          details: "4 passed, 0 failed",
        },
        typecheck: {
          status: "failed_non_gating",
          gating: "non-gating",
          details: "non-gating static check",
        },
      },
      risks: [],
      artifactEvidence: ["npm test output"],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recoveryStrategy, undefined);
});

test("software feature evaluator accepts expected non-zero invalid-input evidence when status passed", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-eval-invalid-input"));
  const result = runEvaluatorPipeline(db, {
    runId: "run-eval-invalid-input",
    taskId: "implement-feature",
    pipeline: softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === "software-feature-quality")!,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "implementation_report")!,
    artifact: {
      summary: "implemented calc sum",
      filesChanged: ["src/calc.ts", "src/cli.ts", "test/calc.test.ts", "README.md"],
      commandsRun: ["npm test", "npm run -s cli -- sum 1 nope 3"],
      testResults: [
        { command: "npm test", status: "passed", exitCode: 0 },
        { command: "npm run -s cli -- sum 1 nope 3", status: "passed", output: "Invalid number: nope", exitCode: 1 },
      ],
      risks: [],
      artifactEvidence: {
        behaviorEvidence: ["invalid input prints Invalid number and exits non-zero"],
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recoveryStrategy, undefined);
});

test("evaluator pipeline recovery drill fails once from workflow config", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-eval-drill"));
  const pipeline = {
    ...softwareDomainPack.evaluatorPipelines.find((candidate) => candidate.id === "software-verification-quality")!,
    evaluators: [
      ...softwareDomainPack.evaluatorPipelines.find((candidate) => candidate.id === "software-verification-quality")!.evaluators,
      {
        id: "recovery-drill",
        kind: "domain" as const,
        config: {
          recoveryDrill: {
            strategy: "fork-from-checkpoint",
            trigger: "once",
            reason: "force one recovery path for workflow validation",
          },
        },
        required: true,
      },
    ],
  };
  const artifact = {
    summary: "verified calc sum",
    commandsRun: ["npm test"],
    testResults: [{ command: "npm test", status: "passed" }],
    checkerFindings: [],
    risks: [],
  };

  const first = runEvaluatorPipeline(db, {
    runId: "run-eval-drill",
    taskId: "verify-feature",
    pipeline,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "verification_report")!,
    artifact,
  });
  const second = runEvaluatorPipeline(db, {
    runId: "run-eval-drill",
    taskId: "verify-feature",
    pipeline,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "verification_report")!,
    artifact,
  });

  assert.equal(first.ok, false);
  assert.equal(first.recoveryStrategy, "fork-from-checkpoint");
  assert.equal(first.findings.some((finding) => finding.field === "recoveryDrill.recovery-drill"), true);
  assert.equal(second.ok, true);
});

test("software verification evaluator accepts explicit empty checker findings", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun("run-eval-checker-ok"));
  const result = runEvaluatorPipeline(db, {
    runId: "run-eval-checker-ok",
    taskId: "verify-feature",
    pipeline: softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === "software-verification-quality")!,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "verification_report")!,
    artifact: {
      summary: "verified calc sum",
      commandsRun: ["npm test", "npm run -s cli -- sum 1 2 3"],
      testResults: [{ command: "npm test", status: "passed" }],
      checkerFindings: [],
      risks: [],
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
