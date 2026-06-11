import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveExceptionsEnabled, fullLiveExceptionLayerSelected, requireFullLiveExceptionEnv } from "./env.ts";
import { formatFullLiveExceptionSummary } from "./metrics.ts";
import { createFullLiveExceptionHarness } from "./harness.ts";

test("codex full live exception layer covers verifier failure, artifact rejection, timeout, empty response, and implementation recovery", async (t) => {
  if (!fullLiveExceptionsEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE_EXCEPTIONS=1 to run Codex full live exception E2E.");
    return;
  }
  if (!fullLiveExceptionLayerSelected("codex")) {
    t.skip("NORTHSTAR_FULL_LIVE_EXCEPTION_LAYER selected a different layer.");
    return;
  }

  const harness = await createFullLiveExceptionHarness({ env: requireFullLiveExceptionEnv() });
  try {
    await harness.runCodexPromptVerifierFailureScenario();
    await harness.runCodexVerifierRecoveryScenario();
    await harness.runCodexMalformedArtifactScenario();
    await harness.runCodexTimeoutScenario();
    await harness.runCodexEmptyResponseScenario();
    await harness.runCodexImplementationRecoveryScenario();
    const metrics = harness.summary();
    t.diagnostic(formatFullLiveExceptionSummary(metrics));
    t.diagnostic(harness.traceSummary());

    for (const id of ["FLX-07", "FLX-08", "FLX-09", "FLX-10", "FLX-11", "FLX-12"]) {
      assert.ok(metrics.covered_requirements.includes(id as never), `${id} should be covered`);
    }
    assert.ok(metrics.full_live_exception_live_codex_cases >= 3);
    assert.ok(metrics.full_live_exception_fault_injection_cases >= 3);
    assert.ok(metrics.full_live_exception_retryable_failures >= 3);
    assert.ok(metrics.full_live_exception_terminal_failures >= 1);
    assert.ok(metrics.full_live_exception_recovery_completed_cases >= 2);
    assert.ok(metrics.full_live_exception_prs_created >= 1);
    assert.ok(metrics.full_live_exception_prs_merged >= 1);
    assert.equal(metrics.full_live_exception_secret_leaks, 0);
  } finally {
    await harness.dispose();
  }
});
