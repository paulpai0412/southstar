import assert from "node:assert/strict";
import test from "node:test";

import { inspectIssueSnapshot } from "../../src/orchestrator/inspect.ts";

test("inspect issue exposes runtime github project and recovery fields", () => {
  const model = inspectIssueSnapshot({
    issue_id: "issue-88",
    source: "github",
    external_id: "88",
    title: "Inspect",
    body: "body",
    lifecycle_state: "release_pending",
    runtime_context_json: {
      project: { lifecycle: "release_pending", status: "Releasing" },
      pr: { number: 99, url: "https://github.com/owner/repo/pull/99", merge_sha: "" },
      current_stage: "release",
      owner_lease: { lease_id: "lease-1", heartbeat_seq: 3, last_heartbeat_at: "2026-05-31T00:59:00.000Z" },
      child_runs: [{ child_run_id: "child-1", root_session_id: "root-1", status: "running" }],
      cleanup: { backlog: 1 },
    },
    updated_at: "2026-05-31T01:00:00.000Z",
  }, [
    { event_type: "effect_failed_retryable", payload: { reason: "projection failed" } },
  ]);

  assert.equal(model.fields_present >= 12, true);
  assert.equal(model.project_lifecycle, "release_pending");
  assert.equal(model.project_status, "Releasing");
  assert.equal(model.pr_url, "https://github.com/owner/repo/pull/99");
  assert.equal(model.merge_sha, null);
  assert.equal(model.current_stage, "release");
  assert.equal(model.last_heartbeat, "2026-05-31T00:59:00.000Z");
  assert.equal(model.cleanup_backlog, 1);
  assert.match(model.recovery_suggestion, /retryable effect/);
});

test("inspect issue reflects production project fields pr shape release metadata and redacts retryable history", () => {
  const model = inspectIssueSnapshot({
    issue_id: "github:99",
    source: "github",
    external_id: "99",
    title: "Production inspect",
    body: "body",
    lifecycle_state: "completed",
    runtime_context_json: {
      pr: { prNumber: 44, prUrl: "https://github.com/owner/repo/pull/44" },
      release: { merge_sha: "merge-sha-44" },
      current_stage: "release",
      child_runs: [],
    },
    updated_at: "2026-05-31T01:00:00.000Z",
  }, [
    {
      event_type: "effect_failed_retryable",
      payload: {
        reason: "GitHub failed with github_pat_SECRETSECRETSECRETSECRETSECRET",
        token: "github_pat_SECRETSECRETSECRETSECRETSECRET",
      },
    },
  ]);

  assert.equal(model.project_lifecycle, "completed");
  assert.equal(model.project_status, "Done");
  assert.equal(model.pr_url, "https://github.com/owner/repo/pull/44");
  assert.equal(model.merge_sha, "merge-sha-44");
  assert.doesNotMatch(JSON.stringify(model), /github_pat_SECRET/);
  assert.match(JSON.stringify(model.retryable_effects), /\[REDACTED\]/);
});

test("inspect summary does not expose active lease or running child for completed issue", () => {
  const model = inspectIssueSnapshot({
    issue_id: "github:100",
    lifecycle_state: "completed",
    current_session_id: "stale-root",
    runtime_context_json: {
      owner_lease: {
        lease_id: "lease-implementation-github:100",
        root_session_id: "stale-root",
        role: "issue_worker",
        generation: 1,
        heartbeat_seq: 0,
        last_heartbeat_at: "2026-05-31T01:00:00.000Z",
        expires_at: "2026-05-31T01:10:00.000Z",
      },
      stage_cursor: "implementation",
      child_runs: [{
        child_run_id: "stale-root:implement",
        lease_id: "lease-implementation-github:100",
        root_session_id: "stale-root",
        role: "issue_worker",
        status: "running",
        session_id: "stale-root",
        started_at: "2026-05-31T01:00:00.000Z",
        last_seen_at: "2026-05-31T01:00:00.000Z",
      }],
      pr: { prNumber: 100, prUrl: "https://github.com/owner/repo/pull/100" },
      release: { merge_sha: "merge-sha-100" },
    },
  }, []);

  assert.equal(model.owner_lease, null);
  assert.equal(model.current_stage, "completed");
  assert.equal(model.child_runs.some((run) => (run as { status?: string }).status === "running"), false);
});


test("inspect quarantined issue surfaces repair and resume guidance", () => {
  const model = inspectIssueSnapshot({
    issue_id: "github:101",
    lifecycle_state: "quarantined",
    runtime_context_json: {
      blocked_by: ["host_liveness"],
      last_error: "Host root liveness is missing",
    },
  }, []);

  assert.equal(model.next_action, "operator_resume_or_repair_runtime");
  assert.match(model.recovery_suggestion, /northstar repair-runtime/);
  assert.match(model.recovery_suggestion, /northstar resume/);
});