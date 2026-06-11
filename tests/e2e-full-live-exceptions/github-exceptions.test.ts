import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveExceptionsEnabled, fullLiveExceptionLayerSelected, requireFullLiveExceptionEnv } from "./env.ts";
import { formatFullLiveExceptionSummary } from "./metrics.ts";
import { createFullLiveExceptionHarness } from "./harness.ts";

test("github full live exception layer covers projection, cleanup, PR, conflict, and conflict recovery", async (t) => {
  if (!fullLiveExceptionsEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE_EXCEPTIONS=1 to run GitHub full live exception E2E.");
    return;
  }
  if (!fullLiveExceptionLayerSelected("github")) {
    t.skip("NORTHSTAR_FULL_LIVE_EXCEPTION_LAYER selected a different layer.");
    return;
  }

  const env = requireFullLiveExceptionEnv();
  const harness = await createFullLiveExceptionHarness({ env });
  try {
    await harness.runGithubProjectionFailureScenario();
    await harness.runGithubProjectMissingEnvScenario();
    await harness.runGithubIssueCloseFailureScenario();
    await harness.runGithubPrCreateFailureScenario();
    await harness.runGithubRealMergeConflictScenario();
    await harness.runGithubMergeConflictRecoveryScenario();
    const metrics = harness.summary();
    t.diagnostic(formatFullLiveExceptionSummary(metrics));
    t.diagnostic(harness.traceSummary());

    for (const id of ["FLX-01", "FLX-02", "FLX-03", "FLX-04", "FLX-05", "FLX-06"]) {
      assert.ok(metrics.covered_requirements.includes(id as never), `${id} should be covered`);
    }
    assert.ok(metrics.full_live_exception_live_github_cases >= 6);
    assert.ok(metrics.full_live_exception_prs_created >= 2);
    assert.ok(metrics.full_live_exception_prs_merged >= 1);
    assert.equal(metrics.full_live_exception_real_merge_conflicts, 1);
    assert.ok(metrics.full_live_exception_retryable_failures >= 3);
    assert.ok(metrics.full_live_exception_cleanup_failures_recorded >= 1);
    assert.equal(metrics.full_live_exception_secret_leaks, 0);
    assert.equal(metrics.full_live_exception_unclosed_failed_issues, 0);
  } finally {
    await harness.dispose();
  }
});
