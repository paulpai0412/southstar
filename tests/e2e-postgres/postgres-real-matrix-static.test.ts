import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string { return readFileSync(join(root, path), "utf8"); }

const implementedCases = [
  "00-infra-preflight.test.ts",
  "01-db-schema-init.test.ts",
  "02-runtime-api-contract.test.ts",
  "03-normal-software-run.test.ts",
  "04-artifact-repair-recovery.test.ts",
  "05-session-recovery.test.ts",
  "06-executor-reconcile.test.ts",
  "07-evolution-learning.test.ts",
  "08-evolution-sandbox-baseline-candidate.test.ts",
  "09-regression-rollback.test.ts",
  "10-managed-brain-crash-wake.test.ts",
  "11-managed-hand-reprovision.test.ts",
  "12-managed-credential-isolation.test.ts",
  "13-managed-per-task-tork-runtime.test.ts",
  "14-tork-queue-timeout-recovery.test.ts",
  "15-tork-running-hang-recovery.test.ts",
  "16-late-callback-superseded-attempt.test.ts",
  "17-tool-proxy-runtime-enforcement.test.ts",
  "18-work-item-intake-run-execution.test.ts",
  "19-completion-gate-unresolved-exception.test.ts",
  "20-operator-approved-recovery.test.ts",
  "21-recovery-decision-apply-requeue.test.ts",
  "22-recovery-decision-apply-reprovision.test.ts",
  "23-operator-approved-recovery-apply.test.ts",
  "24-provider-unreachable-apply-failure.test.ts",
  "25-normal-context-session-memory-flow.test.ts",
  "26-abnormal-context-session-memory-recovery.test.ts",
  "27-runtime-api-completeness.test.ts",
  "28-llm-constrained-workflow-end-to-end.test.ts",
  "29-llm-dynamic-workflow-materialization.test.ts",
];

test("canonical real E2E entrypoint is a static manifest and real cases run one at a time", () => {
  const pkg = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["test:e2e:real"], "tsx tests/e2e-postgres/index.test.ts");
  assert.equal(pkg.scripts["test:e2e:postgres"], "tsx tests/e2e-postgres/index.test.ts");
  assert.equal(source("tests/e2e-postgres/index.test.ts"), "await import(\"./postgres-real-matrix-static.test.ts\");\n");

  for (const caseFile of implementedCases) {
    const caseId = caseFile.slice(0, 2);
    assert.equal(pkg.scripts[`test:e2e:postgres:${caseId}`], `tsx tests/e2e-postgres/cases/${caseFile}`);
  }
});

test("Postgres real E2E cases are explicitly ordered and contain no UI/browser cases", () => {
  const actual = readdirSync(join(root, "tests/e2e-postgres/cases")).filter((entry) => entry.endsWith(".test.ts")).sort();
  assert.deepEqual(actual, implementedCases);
  assert.match(source("tests/e2e-postgres/README.md"), /Run \*\*one case at a time\*\*/);
  assert.match(source("tests/e2e-postgres/README.md"), /Do \*\*not\*\* add UI\/browser flows here/);
  assert.equal(existsSync(join(root, "tests/e2e-postgres/ui")), false);
});

test("Postgres real E2E suite contains no SQLite/local API coupling or fake shortcuts", () => {
  const executablePaths = [
    "tests/e2e-postgres/index.test.ts",
    "tests/e2e-postgres/postgres-real-harness.ts",
    "tests/e2e-postgres/runtime-hardening-fixtures.ts",
    ...implementedCases.map((caseFile) => `tests/e2e-postgres/cases/${caseFile}`),
  ];
  for (const path of ["tests/e2e-postgres/README.md", ...executablePaths]) {
    const text = source(path);
    assert.doesNotMatch(text, /stores\/sqlite|ui-api\/local-api|openSouthstarDb\(\":memory:\"|assertSqliteEvidence|node:sqlite/);
  }
  for (const path of executablePaths) {
    assert.doesNotMatch(source(path), /fake|mock|smoke|test-only/i);
  }
});

test("managed context E2E cases use retrievable memory kinds and typed manifest policies", () => {
  const normalContextCase = source("tests/e2e-postgres/cases/25-normal-context-session-memory-flow.test.ts");
  const abnormalContextCase = source("tests/e2e-postgres/cases/26-abnormal-context-session-memory-recovery.test.ts");
  assert.doesNotMatch(normalContextCase, /kind:\s*"workflow_context"/);
  assert.match(normalContextCase, /kind:\s*"artifact_summary"/);
  assert.doesNotMatch(normalContextCase, /executionPolicy/);
  assert.match(normalContextCase, /effortPolicy/);
  assert.match(abnormalContextCase, /kind:\s*"failure_lesson"/);
  assert.doesNotMatch(abnormalContextCase, /executionPolicy/);
  assert.match(abnormalContextCase, /effortPolicy/);
  assert.doesNotMatch(abnormalContextCase, /update\s+southstar\.workflow_tasks/i);
  assert.doesNotMatch(abnormalContextCase, /seedRunningHandAttempt/);
  assert.match(abnormalContextCase, /SOUTHSTAR_AGENT_RUNNER_FAULT/);
  assert.match(abnormalContextCase, /producerTaskId/);
  assert.match(abnormalContextCase, /consumerTaskId/);
  assert.match(abnormalContextCase, /failedArtifactRefs/);
  assert.match(abnormalContextCase, /artifact_repair_marker/);
  assert.match(abnormalContextCase, /runtime\.fault_injected/);
  assert.match(source("tests/e2e-postgres/README.md"), /\| 26 abnormal context\/session\/memory recovery \| implemented \|/);
  assert.match(source("tests/e2e-postgres/README.md"), /\| 27 runtime API completeness \| implemented \|/);
  assert.match(source("tests/e2e-postgres/README.md"), /\| 28 llm-constrained workflow end-to-end \| implemented \|/);
  assert.match(source("tests/e2e-postgres/README.md"), /\| 29 llm dynamic workflow materialization \| implemented \|/);
});

test("legacy SQLite real E2E suite is removed from the runnable tree", () => {
  assert.equal(existsSync(join(root, "tests/e2e-real")), false);
  assert.equal(existsSync(join(root, "tests/e2e-legacy-sqlite")), false);
  assert.equal(existsSync(join(root, "tests/e2e-ui")), false);
});
