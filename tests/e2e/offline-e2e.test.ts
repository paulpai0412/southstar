import test from "node:test";
import assert from "node:assert/strict";
import { createOfflineE2EHarness } from "./harness.ts";

const originalFetch = globalThis.fetch;

test("offline E2E summary contract reports quantified acceptance metrics", async (t) => {
  let networkCalls = 0;
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error("offline E2E must not call fetch");
  }) as typeof fetch;
  let harness: Awaited<ReturnType<typeof createOfflineE2EHarness>> | undefined;
  try {
    harness = await createOfflineE2EHarness();
    await harness.runCodingReleaseFullCycle();
    await harness.runCodingNoReleaseFullCycle();
    await harness.runContentCreationFullCycle();
    await harness.runOfficeReportFullCycle();
    await harness.runRestartRecoveryScenario();
    await harness.runInvalidArtifactScenario();

    const summary = harness.summary();
    t.diagnostic(harness.formatSummary());

    assert.equal(summary.successful_full_cycle_workflows, 4);
    assert.equal(summary.total_scenarios, 6);
    assert.equal(summary.scenarios_passed, 6);
    assert.equal(summary.restart_recovery_completed, 1);
    assert.equal(summary.invalid_artifact_scenarios, 1);
    assert.equal(summary.workflows_completed, 4);
    assert.ok(summary.lifecycle_states_observed >= 8);
    assert.equal(summary.new_domain_lifecycle_states, 0);
    assert.equal(summary.network_calls, 0);
    assert.equal(networkCalls, 0);
    assert.equal(summary.live_credential_reads, 0);
    assert.ok(summary.coding_release_owner_leases >= 1);
    assert.ok(summary.coding_release_child_run_records >= 2);
    assert.ok(summary.coding_release_valid_child_artifacts >= 2);
    assert.ok(summary.coding_release_confirmed_merge_facts >= 1);
    assert.ok(summary.artifact_rejection_history_rows >= 1);
    assert.ok(summary.retryable_projection_failures >= 1);
    assert.ok(summary.retryable_effect_failures >= 1);
    assert.ok(summary.post_completion_cleanup_failures_preserved >= 1);
    assert.equal(summary.domain_full_cycle_workflows, 2);
    assert.equal(summary.domain_workflows_with_coding_role_chain, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await harness?.cleanup();
  }
});

test("offline E2E harness seeds local issue packets without network calls", async () => {
  const harness = await createOfflineE2EHarness();
  try {
    const issue = harness.seedIssue("issue_to_done", "E2E seed smoke");

    assert.equal(issue.lifecycle_state, "ready");
    assert.equal(issue.issue_id, "local:1001");
    assert.equal(harness.summary().network_calls, 0);
    assert.equal(harness.store.listHistory("local:1001").at(-1)?.event_type, "intake_packet");
  } finally {
    await harness.cleanup();
  }
});
