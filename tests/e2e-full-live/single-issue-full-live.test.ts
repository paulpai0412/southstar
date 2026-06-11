import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveEnabled, fullLiveScenarioSelected, requireFullLiveEnv } from "./env.ts";
import { formatFullLiveSummary } from "./metrics.ts";
import { FullLiveHarness } from "./harness.ts";
import { recordFullLiveScenarioMetrics } from "./suite-metrics.ts";

test("single issue full live E2E", async (t) => {
  if (!fullLiveEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE=1 to run full live E2E.");
    return;
  }
  if (!fullLiveScenarioSelected("single")) {
    t.skip("NORTHSTAR_FULL_LIVE_SCENARIO selected a different scenario.");
    return;
  }

  const harness = new FullLiveHarness(requireFullLiveEnv());
  const metrics = await harness.runSingleIssueScenario();
  recordFullLiveScenarioMetrics("single", metrics);
  t.diagnostic(formatFullLiveSummary(metrics));
  t.diagnostic(harness.traceSummary());

  assert.equal(metrics.full_live_issues_created, 1);
  assert.equal(metrics.full_live_runtime_issues_completed, 1);
  assert.ok(metrics.full_live_codex_root_sessions_started >= 1);
  assert.ok(metrics.full_live_codex_child_runs_started >= 2);
  assert.equal(metrics.full_live_branches_pushed, 1);
  assert.equal(metrics.full_live_prs_created, 1);
  assert.equal(metrics.full_live_prs_merged, 1);
  assert.equal(metrics.full_live_confirmed_merge_facts, 1);
  assert.equal(metrics.full_live_fixture_files_created, 1);
  assert.equal(metrics.full_live_fixture_content_matches, 1);
  assert.equal(metrics.full_live_github_issues_closed, 1);
  assert.equal(metrics.full_live_secret_leaks, 0);
  assert.ok(metrics.full_live_single_duration_seconds <= 600);
});
