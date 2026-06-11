import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkflow } from "../../src/types/workflow.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import {
  claimAndStartStage,
  submitWorkerArtifact,
  submitVerifierArtifact,
  claimAndStartRelease,
  submitConfirmedRelease,
  submitChildArtifactPayload,
} from "../../src/orchestrator/issue-flow.ts";

const workflow = loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml");
const now = "2026-05-30T00:00:00.000Z";

test("shared issue flow advances issue to completed", () => {
  let snapshot = newIssueSnapshot("github:1", {
    lifecycle_state: "ready",
    runtime_context_json: {
      issue_packet: {
        issue_number: "1",
        title: "one",
        source: "github",
        source_url: "https://github.test/1",
        branch: "northstar/1",
        base_branch: "main",
        labels: [],
        dependencies: [],
        raw_text: "one",
        ready_for_agent: true,
      },
      child_runs: [],
      projection_sync: [],
    },
  });

  let result = claimAndStartStage({
    snapshot,
    workflow,
    stageName: "implementation",
    leaseId: "lease-impl",
    rootSessionId: "root-impl",
    childRunId: "child-impl",
    sessionId: "session-impl",
    now,
    ttlSeconds: 600,
  });
  snapshot = result.snapshot;
  assert.equal(snapshot.lifecycle_state, "running");
  assert.equal(snapshot.runtime_context_json.child_runs?.[0]?.root_session_id, "root-impl");

  result = submitWorkerArtifact({
    snapshot,
    workflow,
    childRunId: "child-impl",
    artifactHistoryId: 2,
    roleName: "implementation_agent",
    artifactKind: "worker_result",
    branch: "northstar/1",
    commitSha: "abc",
    changedFiles: ["src/a.ts"],
    now,
  });
  snapshot = result.snapshot;
  assert.equal(snapshot.lifecycle_state, "verifying");

  result = claimAndStartStage({
    snapshot,
    workflow,
    stageName: "verification",
    leaseId: "lease-verify",
    rootSessionId: "root-verify",
    childRunId: "child-verify",
    sessionId: "session-verify",
    now,
    ttlSeconds: 600,
  });
  snapshot = result.snapshot;

  result = submitVerifierArtifact({
    snapshot,
    workflow,
    childRunId: "child-verify",
    artifactHistoryId: 4,
    roleName: "verifier_agent",
    artifactKind: "evidence_packet",
    prNumber: 10,
    now,
  });
  snapshot = result.snapshot;
  assert.equal(snapshot.lifecycle_state, "verified");

  result = claimAndStartRelease({
    snapshot,
    workflow,
    roleName: "release_agent",
    leaseId: "lease-release",
    rootSessionId: "root-release",
    childRunId: "child-release",
    sessionId: "session-release",
    now,
    ttlSeconds: 600,
  });
  snapshot = result.snapshot;
  assert.equal(snapshot.lifecycle_state, "releasing");
  assert.equal(snapshot.runtime_context_json.stage_cursor, "release");
  assert.equal(snapshot.runtime_context_json.child_runs?.at(-1)?.child_run_id, "child-release");

  result = submitConfirmedRelease({ snapshot, workflow, mergeSha: "merge-sha", now });
  assert.equal(result.snapshot.lifecycle_state, "completed");
});

test("release result artifact completes release stage from release child run", () => {
  let snapshot = newIssueSnapshot("github:release-artifact", {
    lifecycle_state: "verified",
    stage_cursor: "verification",
    runtime_context_json: {
      issue_packet: {
        issue_number: "44",
        title: "Release artifact",
        raw_text: "Acceptance: release_result completes",
        source_url: "https://github.test/owner/repo/issues/44",
      },
    },
  });

  let result = claimAndStartRelease({
    snapshot,
    workflow,
    roleName: "release_agent",
    leaseId: "lease-release",
    rootSessionId: "root-release",
    childRunId: "child-release",
    sessionId: "session-release",
    now,
    ttlSeconds: 600,
  });
  snapshot = result.snapshot;

  result = submitChildArtifactPayload({
    snapshot,
    workflow,
    childRunId: "child-release",
    artifactHistoryId: 44,
    now,
    artifact: {
      schema_version: "1.0",
      artifact_kind: "release_result",
      issue_number: 44,
      role: "release_agent",
      status: "completed",
      observed_at: now,
      summary: "release completed",
      retryable: false,
      release: {
        confirmed: true,
        merge_commit: "merge-artifact",
        local_sync: {
          base_branch: "main",
          synced: true,
          local_head: "merge-artifact",
          remote_head: "merge-artifact",
          matches_remote: true,
        },
        repo_root_sync: {
          status: "skipped",
          reason: "repo_root_dirty",
        },
        worktree_cleanup: {
          path: ".northstar/runtime/worktrees/issue-44-release",
          removed: true,
        },
      },
      issue_update: {
        comment_summary: "Released via PR #44.",
      },
      evidence: [
        { type: "merge_commit", value: "merge-artifact" },
        { type: "local_remote_sync", value: "main at merge-artifact" },
        { type: "worktree_cleanup", value: "removed .northstar/runtime/worktrees/issue-44-release" },
      ],
    },
  });

  assert.equal(result.snapshot.lifecycle_state, "completed");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.at(-1)?.status, "succeeded");
  assert.equal(result.history.some((entry) => entry.event_type === "child_artifact_received"), true);
});

test("submit confirmed release maps sync worktree result into runtime event audit payload", () => {
  const snapshot = newIssueSnapshot("github:sync", {
    lifecycle_state: "release_pending",
    stage_cursor: "release",
  });

  const result = submitConfirmedRelease({
    snapshot,
    workflow,
    mergeSha: "merge-sync",
    now,
    syncWorktree: {
      status: "synced",
      path: "/repo/.northstar/runtime/sync-worktrees/main",
      headCommit: "merge-sync",
      expectedCommit: "merge-sync",
      code: "UNUSED_CODE",
      lastError: "unused",
      retryable: false,
    },
  });

  assert.deepEqual(result.snapshot.runtime_context_json.release?.sync_worktree_refresh, {
    status: "synced",
    path: "/repo/.northstar/runtime/sync-worktrees/main",
    head_commit: "merge-sync",
    expected_commit: "merge-sync",
    code: "UNUSED_CODE",
    last_error: "unused",
    retryable: false,
  });
  assert.equal(result.history.some((entry) => entry.event_type === "sync_worktree_refreshed"), true);
});

test("claim and start does not create duplicate child run when active lease already exists", () => {
  const snapshot = newIssueSnapshot("github:duplicate", {
    lifecycle_state: "running",
    owner_lease: {
      lease_id: "lease-existing",
      root_session_id: "root-existing",
      role: "implementation_agent",
      generation: 1,
      heartbeat_seq: 0,
      last_heartbeat_at: now,
      expires_at: "2026-05-30T00:10:00.000Z",
    },
    stage_cursor: "implementation",
    child_runs: [{
      child_run_id: "child-existing",
      lease_id: "lease-existing",
      root_session_id: "root-existing",
      role: "implementation_agent",
      status: "running",
      session_id: "session-existing",
      started_at: now,
      last_seen_at: now,
    }],
  });

  const result = claimAndStartStage({
    snapshot,
    workflow,
    stageName: "implementation",
    leaseId: "lease-new",
    rootSessionId: "root-new",
    childRunId: "child-new",
    sessionId: "session-new",
    now,
    ttlSeconds: 600,
  });

  assert.equal(result.snapshot.lifecycle_state, "running");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.length, 1);
  assert.equal(result.snapshot.runtime_context_json.child_runs?.[0]?.child_run_id, "child-existing");
  assert.equal(result.history.some((entry) => entry.event_type === "child_run_started"), false);
  assert.equal(result.operatorMessages.some((message) => message.code === "duplicate_owner_lease"), true);
});
