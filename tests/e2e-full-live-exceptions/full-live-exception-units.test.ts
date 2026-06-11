import test from "node:test";
import assert from "node:assert/strict";
import {
  fullLiveExceptionsEnabled,
  fullLiveExceptionLayerSelected,
  requireFullLiveExceptionEnv,
} from "./env.ts";
import {
  emptyFullLiveExceptionMetrics,
  formatFullLiveExceptionSummary,
  hasFullLiveExceptionSecretLeak,
  markFullLiveExceptionRequirementCovered,
  mergeFullLiveExceptionMetrics,
  assertFullLiveExceptionThresholds,
} from "./metrics.ts";
import { buildFullLiveExceptionGateCommands, parseFullLiveExceptionSummary } from "./run-full-live-exception-gates.ts";
import { createFaultingGitHubFetch } from "./github-faults.ts";
import { createCodexFaultRunner } from "./codex-faults.ts";
import { cleanupFailedBranch, closeSmokeIssueWithComment } from "./cleanup.ts";
import { createFullLiveExceptionHarness } from "./harness.ts";

test("full live exception env skips when flag is absent", () => {
  assert.equal(fullLiveExceptionsEnabled({}), false);
});

test("full live exception env fails with actionable missing fields when enabled", () => {
  assert.throws(
    () => requireFullLiveExceptionEnv({ NORTHSTAR_FULL_LIVE_EXCEPTIONS: "1" }),
    /Missing full live exception E2E configuration: GITHUB_TOKEN, NORTHSTAR_LIVE_GITHUB_REPO/,
  );
});

test("full live exception env requires sandbox repository", () => {
  assert.throws(
    () => requireFullLiveExceptionEnv({
      NORTHSTAR_FULL_LIVE_EXCEPTIONS: "1",
      GITHUB_TOKEN: "gho_example",
      NORTHSTAR_LIVE_GITHUB_REPO: "paulpai0412/northstar",
    }),
    /NORTHSTAR_LIVE_GITHUB_REPO must be paulpai0412\/northstar-live-sandbox/,
  );
});

test("full live exception layer filter can isolate one layer", () => {
  assert.equal(fullLiveExceptionLayerSelected("github", {}), true);
  assert.equal(fullLiveExceptionLayerSelected("github", { NORTHSTAR_FULL_LIVE_EXCEPTION_LAYER: "" }), true);
  assert.equal(fullLiveExceptionLayerSelected("github", { NORTHSTAR_FULL_LIVE_EXCEPTION_LAYER: "github" }), true);
  assert.equal(fullLiveExceptionLayerSelected("codex", { NORTHSTAR_FULL_LIVE_EXCEPTION_LAYER: "github" }), false);
});

test("full live exception metrics track FLX and EX mapping coverage", () => {
  const metrics = emptyFullLiveExceptionMetrics();
  markFullLiveExceptionRequirementCovered(metrics, "FLX-01");
  markFullLiveExceptionRequirementCovered(metrics, "FLX-06");
  markFullLiveExceptionRequirementCovered(metrics, "FLX-14");
  metrics.full_live_exception_scenarios_total = 3;
  metrics.full_live_exception_scenarios_passed = 3;
  metrics.full_live_exception_live_github_cases = 2;
  metrics.full_live_exception_recovery_completed_cases = 1;
  metrics.full_live_exception_prs_created = 1;
  metrics.full_live_exception_prs_merged = 1;

  const summary = formatFullLiveExceptionSummary(metrics);

  assert.equal(metrics.full_live_exception_requirements_total, 18);
  assert.equal(metrics.full_live_exception_requirements_covered, 3);
  assert.equal(metrics.full_live_exception_ex_mappings_total, 14);
  assert.ok(metrics.full_live_exception_ex_mappings_covered >= 3);
  assert.match(summary, /full_live_exception_requirements_total=18/);
  assert.match(summary, /full_live_exception_scenarios_passed=3\/3/);
});

test("full live exception metrics merge layer results without losing coverage", () => {
  const github = emptyFullLiveExceptionMetrics();
  markFullLiveExceptionRequirementCovered(github, "FLX-01");
  github.full_live_exception_live_github_cases = 1;

  const codex = emptyFullLiveExceptionMetrics();
  markFullLiveExceptionRequirementCovered(codex, "FLX-10");
  codex.full_live_exception_live_codex_cases = 1;

  const merged = mergeFullLiveExceptionMetrics([github, codex], 99);

  assert.equal(merged.full_live_exception_requirements_covered, 2);
  assert.equal(merged.full_live_exception_live_github_cases, 1);
  assert.equal(merged.full_live_exception_live_codex_cases, 1);
  assert.equal(merged.full_live_exception_duration_seconds, 99);
});

test("full live exception summary detects secret-shaped values", () => {
  const metrics = emptyFullLiveExceptionMetrics();
  const summary = formatFullLiveExceptionSummary(metrics);

  assert.equal(hasFullLiveExceptionSecretLeak("authorization: bearer gho_abc12345678901234567890"), true);
  assert.equal(hasFullLiveExceptionSecretLeak("OPENAI_API_KEY=sk-abc123456789"), true);
  assert.equal(hasFullLiveExceptionSecretLeak(summary), false);
});

test("full live exception aggregate runner uses argv arrays for layer commands", () => {
  const commands = buildFullLiveExceptionGateCommands("node");

  assert.deepEqual(commands, [
    { command: "node", args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-exceptions/github-exceptions.test.ts"] },
    { command: "node", args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-exceptions/codex-exceptions.test.ts"] },
    { command: "node", args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-exceptions/recovery-exceptions.test.ts"] },
  ]);
  assert.equal(JSON.stringify(commands).includes("&&"), false);
});

test("github fault fetch can fail selected operations with redacted errors", async () => {
  const fetchImpl = createFaultingGitHubFetch({
    fail: { method: "POST", pathIncludes: "/pulls", status: 500, message: "server saw gho_secret" },
  });

  const response = await fetchImpl("https://api.github.com/repos/paulpai0412/northstar-live-sandbox/pulls", { method: "POST" });

  assert.equal(response.ok, false);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /gho_secret/);
});

test("codex fault runner returns timeout, malformed artifact, and empty response faults", async () => {
  const timeout = createCodexFaultRunner("timeout");
  const malformed = createCodexFaultRunner("malformed_artifact");
  const empty = createCodexFaultRunner("empty_response");

  await assert.rejects(() => timeout.run({ role: "implement", prompt: "x", timeout_ms: 1 }), /timed out/);
  assert.match((await malformed.run({ role: "implement", prompt: "x", timeout_ms: 1 })).final_response, /not-json/);
  assert.equal((await empty.run({ role: "verify", prompt: "x", timeout_ms: 1 })).final_response, "");
});

test("cleanup helpers redact errors and report retryable cleanup failures", async () => {
  const calls: string[] = [];
  const client = {
    addIssueComment: async (_number: number, body: string) => {
      calls.push(body);
      return { html_url: "https://github.test/comment" };
    },
    closeIssue: async (_number: number) => ({ state: "closed" }),
    deleteBranch: async (_branch: string) => {
      throw new Error("delete failed for token gho_secret");
    },
  };

  const closeResult = await closeSmokeIssueWithComment(client, 42, "failure with token gho_secret");
  const branchResult = await cleanupFailedBranch(client, "northstar-exception-smoke-branch");

  assert.equal(closeResult.closed, true);
  assert.equal(branchResult.status, "retryable_failed");
  assert.doesNotMatch(JSON.stringify(calls), /gho_secret/);
  assert.doesNotMatch(branchResult.last_error ?? "", /gho_secret/);
});

test("full live exception harness records covered requirements and compact metrics", async () => {
  const harness = await createFullLiveExceptionHarness();
  try {
    const metrics = await harness.recordSyntheticScenario({
      requirement: "FLX-01",
      layer: "github",
      retryable_failures: 1,
    });

    assert.ok(metrics.covered_requirements.includes("FLX-01"));
    assert.equal(metrics.full_live_exception_live_github_cases, 1);
    assert.equal(metrics.full_live_exception_retryable_failures, 1);
    assert.equal(metrics.full_live_exception_secret_leaks, 0);
  } finally {
    await harness.dispose();
  }
});

test("full live exception thresholds require quantified suite acceptance", () => {
  const metrics = emptyFullLiveExceptionMetrics();
  for (const id of [
    "FLX-01", "FLX-02", "FLX-03", "FLX-04", "FLX-05", "FLX-06",
    "FLX-07", "FLX-08", "FLX-09", "FLX-10", "FLX-11", "FLX-12",
    "FLX-13", "FLX-14", "FLX-15", "FLX-16",
  ] as const) {
    markFullLiveExceptionRequirementCovered(metrics, id);
  }
  metrics.full_live_exception_scenarios_total = 18;
  metrics.full_live_exception_scenarios_passed = 18;
  metrics.full_live_exception_live_github_cases = 6;
  metrics.full_live_exception_live_codex_cases = 3;
  metrics.full_live_exception_fault_injection_cases = 4;
  metrics.full_live_exception_recovery_completed_cases = 4;
  metrics.full_live_exception_prs_created = 4;
  metrics.full_live_exception_prs_merged = 4;
  metrics.full_live_exception_real_merge_conflicts = 1;
  metrics.full_live_exception_retryable_failures = 5;
  metrics.full_live_exception_quarantined_cases = 1;
  metrics.full_live_exception_resume_successes = 1;
  metrics.full_live_exception_terminal_failures = 1;
  metrics.full_live_exception_cleanup_failures_recorded = 1;
  metrics.full_live_exception_unclosed_failed_issues = 0;
  metrics.full_live_exception_failed_branch_cleanup_attempts = 1;
  metrics.full_live_exception_duration_seconds = 120;

  assert.doesNotThrow(() => assertFullLiveExceptionThresholds(metrics));
});

test("full live exception aggregate runner parses layer summaries for threshold aggregation", () => {
  const parsed = parseFullLiveExceptionSummary(
    "# full_live_exception_requirements_total=18 full_live_exception_scenarios_passed=2/2 full_live_exception_live_github_cases=2 covered_requirements=FLX-01,FLX-02",
  );

  assert.equal(parsed.full_live_exception_scenarios_total, 2);
  assert.equal(parsed.full_live_exception_scenarios_passed, 2);
  assert.equal(parsed.full_live_exception_live_github_cases, 2);
  assert.deepEqual(parsed.covered_requirements, ["FLX-01", "FLX-02"]);
});
