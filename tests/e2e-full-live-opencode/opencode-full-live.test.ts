import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveOpenCodeEnabled, fullLiveOpenCodeLayerSelected, requireFullLiveOpenCodeEnv } from "./env.ts";
import { assertOpenCodeFullLiveThresholds, formatOpenCodeFullLiveSummary } from "./metrics.ts";
import { OpenCodeFullLiveHarness } from "./harness.ts";

test("single issue OpenCode full live happy path", async (t) => {
  if (!fullLiveOpenCodeEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE_OPENCODE=1 to run OpenCode full live E2E.");
    return;
  }
  if (!fullLiveOpenCodeLayerSelected("happy")) {
    t.skip("OpenCode happy path layer filtered by NORTHSTAR_FULL_LIVE_OPENCODE_LAYER.");
    return;
  }

  const env = requireFullLiveOpenCodeEnv();
  const harness = new OpenCodeFullLiveHarness(env);
  const metrics = await harness.runHappyPathScenario();
  assertOpenCodeFullLiveThresholds(metrics);
  assert.equal(metrics.opencode_full_live_secret_leaks, 0);
  console.log(`# ${formatOpenCodeFullLiveSummary(metrics)}`);
  console.log(`# ${harness.traceSummary()}`);
});
