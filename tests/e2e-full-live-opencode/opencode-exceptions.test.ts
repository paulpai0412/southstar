import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveOpenCodeEnabled, fullLiveOpenCodeLayerSelected, requireFullLiveOpenCodeEnv } from "./env.ts";
import { assertOpenCodeExceptionThresholds, formatOpenCodeExceptionSummary } from "./metrics.ts";
import { OpenCodeFullLiveHarness } from "./harness.ts";

test("OpenCode full live exception flow covers SDK boundary, faults, quarantine, resume, and recovery", async (t) => {
  if (!fullLiveOpenCodeEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE_OPENCODE=1 to run OpenCode full live exception E2E.");
    return;
  }
  if (!fullLiveOpenCodeLayerSelected("exceptions")) {
    t.skip("OpenCode exception layer filtered by NORTHSTAR_FULL_LIVE_OPENCODE_LAYER.");
    return;
  }

  const env = requireFullLiveOpenCodeEnv();
  const harness = new OpenCodeFullLiveHarness(env);
  const metrics = await harness.runExceptionScenarios();
  assertOpenCodeExceptionThresholds(metrics);
  assert.equal(metrics.opencode_exception_secret_leaks, 0);
  assert.equal(metrics.opencode_exception_shell_fallbacks, 0);
  console.log(`# ${formatOpenCodeExceptionSummary(metrics)}`);
  console.log(`# ${harness.traceSummary()}`);
});
