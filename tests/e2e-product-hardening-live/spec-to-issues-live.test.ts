import assert from "node:assert/strict";
import test from "node:test";
import {
  productHardeningLiveEnabled,
  requireProductHardeningLiveEnv,
} from "./env.ts";
import { runSpecToIssuesLiveE2E } from "./harness.ts";

test("spec-to-issues live flow applies confirmed issue drafts and completes real issues", async (t) => {
  if (!productHardeningLiveEnabled()) {
    t.skip("Set NORTHSTAR_PRODUCT_HARDENING_LIVE=1 with GitHub repo, Project id, SDK credentials, and confirmed apply to run spec-to-issues live E2E.");
    return;
  }

  const env = requireProductHardeningLiveEnv();
  const result = await runSpecToIssuesLiveE2E({
    ...env,
    confirmedApply: true,
  });

  t.diagnostic(JSON.stringify(result.metrics, null, 2));
  assert.equal(result.metrics.spec_plan_inputs_validated, 1);
  assert.equal(result.metrics.issues_generated_from_plan >= 3, true);
  assert.equal(result.metrics.dry_run_requires_no_github_mutation, 1);
  assert.equal(result.metrics.apply_requires_confirmation, 1);
  assert.equal(result.metrics.live_completed_issues >= 3, true);
  assert.equal(result.metrics.live_prs_merged >= 3, true);
  assert.equal(result.metrics.live_browser_tests_passed >= 1, true);
  assert.equal(result.metrics.secret_leaks_in_generated_issues, 0);
});
