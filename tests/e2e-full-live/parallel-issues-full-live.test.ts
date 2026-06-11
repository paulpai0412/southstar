import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveEnabled, fullLiveScenarioSelected, requireFullLiveEnv } from "./env.ts";
import { formatFullLiveSummary } from "./metrics.ts";
import { FullLiveHarness } from "./harness.ts";
import { recordFullLiveScenarioMetrics } from "./suite-metrics.ts";

test("two issues parallel full live E2E", async (t) => {
  if (!fullLiveEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE=1 to run full live E2E.");
    return;
  }
  if (!fullLiveScenarioSelected("parallel")) {
    t.skip("NORTHSTAR_FULL_LIVE_SCENARIO selected a different scenario.");
    return;
  }
  const harness = new FullLiveHarness(requireFullLiveEnv());
  const metrics = await harness.runParallelIssuesScenario();
  recordFullLiveScenarioMetrics("parallel", metrics);
  t.diagnostic(formatFullLiveSummary(metrics));
  t.diagnostic(harness.traceSummary());

  assert.equal(metrics.full_live_parallel_issues_created, 2);
  assert.equal(metrics.full_live_parallel_completed, 2);
  assert.equal(metrics.full_live_parallel_prs_created, 2);
  assert.equal(metrics.full_live_parallel_prs_merged, 2);
  assert.ok(metrics.full_live_parallel_overlap_seconds >= 1);
  assert.ok(metrics.full_live_parallel_max_active_issue_workers >= 2);
  assert.equal(metrics.full_live_parallel_fixture_files_created, 2);
  assert.equal(metrics.full_live_parallel_cross_issue_contamination, 0);
  assert.equal(metrics.full_live_parallel_merge_conflicts, 0);
  assert.ok(metrics.full_live_parallel_duration_seconds <= 900);
});
