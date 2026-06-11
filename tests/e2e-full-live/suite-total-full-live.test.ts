import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveEnabled } from "./env.ts";
import { formatFullLiveSummary } from "./metrics.ts";
import { buildRecordedSuiteMetrics, recordedFullLiveSuiteMetrics } from "./suite-metrics.ts";

test("full live suite total metrics", (t) => {
  if (!fullLiveEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE=1 to run full live E2E.");
    return;
  }
  if (process.env.NORTHSTAR_FULL_LIVE_SCENARIO) {
    t.skip("Suite totals require running all full live scenarios.");
    return;
  }

  const recorded = recordedFullLiveSuiteMetrics();
  assert.ok(recorded.single, "single scenario metrics were recorded");
  assert.ok(recorded.sequential, "sequential scenario metrics were recorded");
  assert.ok(recorded.parallel, "parallel scenario metrics were recorded");

  const metrics = buildRecordedSuiteMetrics();
  t.diagnostic(formatFullLiveSummary(metrics));

  assert.equal(metrics.full_live_total_issues_created, 5);
  assert.equal(metrics.full_live_total_completed, 5);
  assert.equal(metrics.full_live_total_prs_merged, 5);
  assert.equal(metrics.full_live_total_fixture_files_created, 5);
  assert.equal(metrics.full_live_total_failed_releases, 0);
  assert.equal(metrics.full_live_total_secret_leaks, 0);
  assert.ok(metrics.full_live_total_duration_seconds <= 2700);
});
