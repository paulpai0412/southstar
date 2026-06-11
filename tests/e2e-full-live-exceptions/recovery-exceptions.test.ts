import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveExceptionsEnabled, fullLiveExceptionLayerSelected, requireFullLiveExceptionEnv } from "./env.ts";
import { formatFullLiveExceptionSummary } from "./metrics.ts";
import { createFullLiveExceptionHarness } from "./harness.ts";

test("recovery full live exception layer covers quarantine, resume, release rejection, cleanup failure, and secret safety", async (t) => {
  if (!fullLiveExceptionsEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE_EXCEPTIONS=1 to run recovery full live exception E2E.");
    return;
  }
  if (!fullLiveExceptionLayerSelected("recovery")) {
    t.skip("NORTHSTAR_FULL_LIVE_EXCEPTION_LAYER selected a different layer.");
    return;
  }

  const harness = await createFullLiveExceptionHarness({ env: requireFullLiveExceptionEnv() });
  try {
    await harness.runRuntimeQuarantineScenario();
    await harness.runRuntimeResumeScenario();
    await harness.runReleaseWithoutMergeRejectedScenario();
    await harness.runConfirmedMergeCleanupFailureScenario();
    await harness.runFailedBranchCleanupRetryableScenario();
    await harness.runSecretSafetyScenario();
    const metrics = harness.summary();
    t.diagnostic(formatFullLiveExceptionSummary(metrics));
    t.diagnostic(harness.traceSummary());

    for (const id of ["FLX-13", "FLX-14", "FLX-15", "FLX-16", "FLX-17", "FLX-18"]) {
      assert.ok(metrics.covered_requirements.includes(id as never), `${id} should be covered`);
    }
    assert.ok(metrics.full_live_exception_quarantined_cases >= 1);
    assert.ok(metrics.full_live_exception_resume_successes >= 1);
    assert.ok(metrics.full_live_exception_recovery_completed_cases >= 1);
    assert.ok(metrics.full_live_exception_cleanup_failures_recorded >= 1);
    assert.ok(metrics.full_live_exception_failed_branch_cleanup_attempts >= 1);
    assert.equal(metrics.full_live_exception_secret_leaks, 0);
  } finally {
    await harness.dispose();
  }
});
