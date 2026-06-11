import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveEnabled, fullLiveScenarioSelected, requireFullLiveEnv } from "./env.ts";
import { formatFullLiveSummary } from "./metrics.ts";
import { FullLiveHarness } from "./harness.ts";
import { recordFullLiveScenarioMetrics } from "./suite-metrics.ts";

test("two issues sequential full live E2E", async (t) => {
  if (!fullLiveEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE=1 to run full live E2E.");
    return;
  }
  if (!fullLiveScenarioSelected("sequential")) {
    t.skip("NORTHSTAR_FULL_LIVE_SCENARIO selected a different scenario.");
    return;
  }
  const harness = new FullLiveHarness(requireFullLiveEnv());
  const metrics = await harness.runSequentialIssuesScenario();
  recordFullLiveScenarioMetrics("sequential", metrics);
  t.diagnostic(formatFullLiveSummary(metrics));
  t.diagnostic(harness.traceSummary());

  assert.equal(metrics.full_live_sequential_issues_created, 2);
  assert.equal(metrics.full_live_sequential_completed, 2);
  assert.equal(metrics.full_live_sequential_prs_created, 2);
  assert.equal(metrics.full_live_sequential_prs_merged, 2);
  assert.equal(metrics.full_live_sequential_ordering_violations, 0);
  assert.equal(metrics.full_live_sequential_max_active_issue_workers, 1);
  assert.equal(metrics.full_live_sequential_fixture_files_created, 2);
  assert.equal(metrics.full_live_sequential_cross_issue_contamination, 0);
  assert.ok(metrics.full_live_sequential_duration_seconds <= 1200);
});
