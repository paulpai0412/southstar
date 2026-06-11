import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyExceptionE2EMetrics,
  formatExceptionE2ESummary,
  markRequirementCovered,
  hasExceptionE2ESecretLeak,
} from "./metrics.ts";
import { createExceptionE2EHarness } from "./harness.ts";

test("exception E2E metrics calculate requirement coverage and summary", () => {
  const metrics = emptyExceptionE2EMetrics();
  for (const id of ["EX-01", "EX-02", "EX-03", "EX-04", "EX-05", "EX-06", "EX-07", "EX-08", "EX-09", "EX-10", "EX-11", "EX-12"]) {
    markRequirementCovered(metrics, id);
  }
  metrics.exception_e2e_scenarios_total = 8;
  metrics.exception_e2e_scenarios_passed = 8;
  metrics.exception_e2e_quarantined_cases = 3;
  metrics.exception_e2e_failed_cases = 2;
  metrics.exception_e2e_recovery_cases = 3;
  metrics.exception_e2e_resume_rejections = 2;
  metrics.exception_e2e_retryable_failures = 3;
  metrics.exception_e2e_terminal_failures = 2;
  metrics.exception_e2e_artifact_rejections = 1;
  metrics.exception_e2e_repair_admin_actions = 2;

  const summary = formatExceptionE2ESummary(metrics);

  assert.equal(metrics.exception_e2e_requirements_total, 14);
  assert.equal(metrics.exception_e2e_requirements_covered, 12);
  assert.equal(metrics.exception_e2e_requirement_coverage_percent, 85);
  assert.match(summary, /exception_e2e_requirements_total=14/);
  assert.match(summary, /exception_e2e_scenarios_passed=8\/8/);
  assert.equal(hasExceptionE2ESecretLeak("Authorization: Bearer gho_abc12345678901234567890"), true);
  assert.equal(hasExceptionE2ESecretLeak(summary), false);
});

test("exception E2E harness seeds deterministic offline SQLite issues", async () => {
  const harness = await createExceptionE2EHarness();
  try {
    const issue = harness.seedIssue({
      issueId: "local:1001",
      lifecycleState: "running",
      stageCursor: "implementation",
    });

    assert.equal(issue.issue_id, "local:1001");
    assert.equal(issue.lifecycle_state, "running");
    assert.equal(harness.metrics.exception_e2e_network_calls, 0);
    assert.equal(harness.metrics.exception_e2e_live_credential_reads, 0);
    assert.equal(harness.listIssues().length, 1);
  } finally {
    await harness.dispose();
  }
});

test("exception E2E covers quarantine and resume requirements", async () => {
  const harness = await createExceptionE2EHarness();
  try {
    await harness.runQuarantineAndResumeScenarios();
    const summary = harness.summary();

    assert.ok(summary.covered_requirements.includes("EX-01"));
    assert.ok(summary.covered_requirements.includes("EX-02"));
    assert.ok(summary.covered_requirements.includes("EX-03"));
    assert.ok(summary.covered_requirements.includes("EX-04"));
    assert.ok(summary.covered_requirements.includes("EX-05"));
    assert.ok(summary.covered_requirements.includes("EX-06"));
    assert.equal(summary.exception_e2e_quarantined_cases, 3);
    assert.equal(summary.exception_e2e_resume_rejections, 2);
    assert.ok(summary.exception_e2e_recovery_cases >= 2);
    assert.ok(summary.exception_e2e_repair_admin_actions >= 2);
    assert.equal(summary.exception_e2e_secret_leaks, 0);
  } finally {
    await harness.dispose();
  }
});

test("exception E2E covers child failure, artifact rejection, gate failure, projection, effect, and release recovery", async () => {
  const harness = await createExceptionE2EHarness();
  try {
    await harness.runExecutionExceptionScenarios();
    const summary = harness.summary();

    for (const id of ["EX-07", "EX-08", "EX-09", "EX-10", "EX-11", "EX-12", "EX-13", "EX-14"]) {
      assert.ok(summary.covered_requirements.includes(id as never), `${id} should be covered`);
    }
    assert.ok(summary.exception_e2e_failed_cases >= 2);
    assert.ok(summary.exception_e2e_retryable_failures >= 3);
    assert.ok(summary.exception_e2e_terminal_failures >= 2);
    assert.ok(summary.exception_e2e_artifact_rejections >= 1);
    assert.equal(summary.exception_e2e_duplicate_child_runs, 0);
    assert.equal(summary.exception_e2e_secret_leaks, 0);
  } finally {
    await harness.dispose();
  }
});

test("exception E2E summary meets quantitative acceptance thresholds", async (t) => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error("exception E2E must not call fetch");
  }) as typeof fetch;
  const harness = await createExceptionE2EHarness();
  try {
    await harness.runQuarantineAndResumeScenarios();
    await harness.runExecutionExceptionScenarios();
    const summary = harness.summary();
    t.diagnostic(formatExceptionE2ESummary(summary));

    assert.equal(summary.exception_e2e_requirements_total, 14);
    assert.ok(summary.exception_e2e_requirements_covered >= 12);
    assert.ok(summary.exception_e2e_requirement_coverage_percent >= 85);
    assert.ok(summary.exception_e2e_scenarios_total >= 8);
    assert.equal(summary.exception_e2e_scenarios_passed, summary.exception_e2e_scenarios_total);
    assert.ok(summary.exception_e2e_quarantined_cases >= 3);
    assert.ok(summary.exception_e2e_failed_cases >= 2);
    assert.ok(summary.exception_e2e_recovery_cases >= 3);
    assert.ok(summary.exception_e2e_resume_rejections >= 2);
    assert.ok(summary.exception_e2e_retryable_failures >= 3);
    assert.ok(summary.exception_e2e_terminal_failures >= 2);
    assert.ok(summary.exception_e2e_artifact_rejections >= 1);
    assert.ok(summary.exception_e2e_repair_admin_actions >= 2);
    assert.equal(summary.exception_e2e_duplicate_child_runs, 0);
    assert.equal(summary.exception_e2e_secret_leaks, 0);
    assert.equal(summary.exception_e2e_network_calls, 0);
    assert.equal(summary.exception_e2e_live_credential_reads, 0);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await harness.dispose();
  }
});
