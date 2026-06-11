import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeLifecycleStates,
  applyRuntimeEvents,
  createOwnerLease,
  inspectInvariantViolations,
  newIssueSnapshot,
} from "../../src/runtime/state-machine.ts";
import { loadWorkflow } from "../../src/types/workflow.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml"));
const noReleaseWorkflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/issue-to-done.yaml"));
const now = "2026-05-29T03:00:00.000Z";

const lease = createOwnerLease({
  lease_id: "lease-1",
  root_session_id: "root-1",
  role: "implementation_agent",
  now,
  ttl_seconds: 180,
});

const transitionCases = [
  {
    name: "ready issue can acquire owner lease",
    snapshot: newIssueSnapshot("1"),
    events: [{ type: "claim_owner_lease", lease }],
    expectedLifecycle: "claimed",
    expectedHistory: "owner_lease_acquired",
  },
  {
    name: "duplicate active owner lease acquisition fails",
    snapshot: newIssueSnapshot("2", { lifecycle_state: "running", owner_lease: lease }),
    events: [{ type: "claim_owner_lease", lease: { ...lease, lease_id: "lease-2" } }],
    expectedLifecycle: "running",
    expectedMessage: "duplicate_owner_lease",
  },
  {
    name: "terminal issue cannot acquire owner lease",
    snapshot: newIssueSnapshot("2b", { lifecycle_state: "completed" }),
    events: [{ type: "claim_owner_lease", lease }],
    expectedLifecycle: "completed",
    expectedMessage: "terminal_owner_lease",
  },
  {
    name: "heartbeat increments owner lease sequence",
    snapshot: newIssueSnapshot("3", { lifecycle_state: "running", owner_lease: lease }),
    events: [{ type: "heartbeat", lease_id: "lease-1", at: "2026-05-29T03:00:30.000Z", ttl_seconds: 180 }],
    expectedLifecycle: "running",
    expectedHeartbeatSeq: 1,
  },
  {
    name: "heartbeat from unknown lease is rejected",
    snapshot: newIssueSnapshot("4", { lifecycle_state: "running", owner_lease: lease }),
    events: [{ type: "heartbeat", lease_id: "missing", at: now, ttl_seconds: 180 }],
    expectedLifecycle: "running",
    expectedMessage: "unknown_owner_lease",
  },
  {
    name: "heartbeat for inactive issue is rejected",
    snapshot: newIssueSnapshot("5", { lifecycle_state: "completed", owner_lease: lease }),
    events: [{ type: "heartbeat", lease_id: "lease-1", at: now, ttl_seconds: 180 }],
    expectedLifecycle: "completed",
    expectedMessage: "inactive_heartbeat",
  },
  {
    name: "artifact submission does not refresh heartbeat",
    snapshot: newIssueSnapshot("6", { lifecycle_state: "running", owner_lease: lease }),
    events: [{ type: "artifact_submitted", artifact_history_id: 99, at: "2026-05-29T04:00:00.000Z" }],
    expectedLifecycle: "running",
    expectedHeartbeatSeq: 0,
  },
  {
    name: "stage start records background child run",
    snapshot: newIssueSnapshot("7", { lifecycle_state: "claimed", owner_lease: lease, stage_cursor: "implementation" }),
    events: [{ type: "start_stage", child_run_id: "child-1", session_id: "child-session-1", at: now }],
    expectedLifecycle: "running",
    expectedChildStatus: "running",
    expectedChildRootSessionId: "root-1",
  },
  {
    name: "child success advances implementation to verification",
    snapshot: newIssueSnapshot("8", {
      lifecycle_state: "running",
      owner_lease: lease,
      stage_cursor: "implementation",
      child_runs: [{ child_run_id: "child-1", lease_id: "lease-1", role: "implementation_agent", status: "running", session_id: "s1", started_at: now, last_seen_at: now }],
    }),
    events: [{ type: "child_artifact", child_run_id: "child-1", status: "succeeded", artifact_history_id: 10, at: now }],
    expectedLifecycle: "verifying",
    expectedStage: "verification",
    expectedOwnerLeaseReleased: true,
  },
  {
    name: "child blocked enters exception lifecycle",
    snapshot: newIssueSnapshot("9", { lifecycle_state: "running", owner_lease: lease, stage_cursor: "implementation" }),
    events: [{ type: "child_artifact", child_run_id: "missing", status: "blocked", artifact_history_id: 11, at: now }],
    expectedLifecycle: "exception",
  },
  {
    name: "retryable child failure enters exception lifecycle",
    snapshot: newIssueSnapshot("10", { lifecycle_state: "running", owner_lease: lease, stage_cursor: "implementation" }),
    events: [{ type: "child_artifact", child_run_id: "missing", status: "failed_retryable", artifact_history_id: 12, at: now }],
    expectedLifecycle: "exception",
  },
  {
    name: "terminal child failure enters exception lifecycle",
    snapshot: newIssueSnapshot("11", { lifecycle_state: "running", owner_lease: lease, stage_cursor: "implementation" }),
    events: [{ type: "child_artifact", child_run_id: "missing", status: "failed_terminal", artifact_history_id: 13, at: now }],
    expectedLifecycle: "exception",
  },
  {
    name: "projection failure does not change lifecycle",
    snapshot: newIssueSnapshot("12", { lifecycle_state: "verifying", owner_lease: lease, stage_cursor: "verification" }),
    events: [{ type: "projection_result", projection_target: "label", status: "failed", last_error: "rate limited", next_retry_at: "2026-05-29T03:05:00.000Z" }],
    expectedLifecycle: "verifying",
    expectedHistory: "projection_failed",
  },
  {
    name: "release merge success completes issue",
    snapshot: newIssueSnapshot("13", { lifecycle_state: "releasing", owner_lease: { ...lease, role: "release_agent" }, stage_cursor: "release" }),
    events: [{ type: "release_result", status: "success", pr_merged: true, at: now }],
    expectedLifecycle: "completed",
  },
  {
    name: "release success without merge confirmation is rejected",
    snapshot: newIssueSnapshot("14", { lifecycle_state: "releasing", owner_lease: { ...lease, role: "release_agent" }, stage_cursor: "release" }),
    events: [{ type: "release_result", status: "success", pr_merged: false, at: now }],
    expectedLifecycle: "releasing",
    expectedMessage: "release_merge_not_confirmed",
  },
  {
    name: "local sync failure after completion remains completed",
    snapshot: newIssueSnapshot("15", { lifecycle_state: "completed" }),
    events: [{ type: "effect_result", effect_type: "local_main_sync", status: "failed", last_error: "network", next_retry_at: "2026-05-29T03:05:00.000Z" }],
    expectedLifecycle: "completed",
    expectedHistory: "effect_failed_retryable",
  },
  {
    name: "worktree cleanup failure after completion remains completed",
    snapshot: newIssueSnapshot("16", { lifecycle_state: "completed" }),
    events: [{ type: "effect_result", effect_type: "worktree_cleanup", status: "failed", last_error: "busy", next_retry_at: "2026-05-29T03:05:00.000Z" }],
    expectedLifecycle: "completed",
    expectedHistory: "effect_failed_retryable",
  },
  {
    name: "resume quarantined without lease is rejected",
    snapshot: newIssueSnapshot("17", { lifecycle_state: "quarantined", stage_cursor: "implementation" }),
    events: [{ type: "resume_quarantined" }],
    expectedLifecycle: "quarantined",
    expectedMessage: "resume_requires_owner_lease",
  },
  {
    name: "resume quarantined with new lease succeeds",
    snapshot: newIssueSnapshot("18", { lifecycle_state: "quarantined", stage_cursor: "implementation" }),
    events: [{ type: "resume_quarantined", lease }],
    expectedLifecycle: "running",
    expectedHistory: "owner_lease_acquired",
  },
  {
    name: "resume quarantined with host-confirmed live lease succeeds",
    snapshot: newIssueSnapshot("19", { lifecycle_state: "quarantined", owner_lease: lease, stage_cursor: "implementation" }),
    events: [{ type: "resume_quarantined", host_liveness: "live" }],
    expectedLifecycle: "running",
    expectedHistory: "issue_resumed",
  },
  {
    name: "resume quarantined with unknown host liveness is rejected",
    snapshot: newIssueSnapshot("19b", { lifecycle_state: "quarantined", owner_lease: lease, stage_cursor: "implementation" }),
    events: [{ type: "resume_quarantined", host_liveness: "unknown" }],
    expectedLifecycle: "quarantined",
    expectedMessage: "resume_requires_owner_lease",
  },
  {
    name: "operator resume to ready succeeds from quarantined",
    snapshot: newIssueSnapshot("19c", { lifecycle_state: "quarantined", owner_lease: lease, stage_cursor: "implementation" }),
    events: [{ type: "operator_resume_to_ready", reason: "runtime fixed", target: "ready" }],
    expectedLifecycle: "ready",
    expectedHistory: "operator_resume",
  },
  {
    name: "unknown child artifact is auditable without crashing",
    snapshot: newIssueSnapshot("20", { lifecycle_state: "running", owner_lease: lease, stage_cursor: "implementation" }),
    events: [{ type: "child_artifact", child_run_id: "unknown", status: "succeeded", artifact_history_id: 20, at: now }],
    expectedLifecycle: "verifying",
    expectedHistory: "child_run_lost",
  },
  {
    name: "verification pass advances release workflow to verified",
    snapshot: newIssueSnapshot("21", { lifecycle_state: "verifying", owner_lease: lease, stage_cursor: "verification" }),
    events: [{ type: "gate_result", status: "pass", at: now }],
    expectedLifecycle: "verified",
  },
  {
    name: "verified issue cannot enter release pending without release owner lease",
    snapshot: newIssueSnapshot("21b", { lifecycle_state: "verified", stage_cursor: "release" }),
    events: [{ type: "start_release", at: now }],
    expectedLifecycle: "verified",
    expectedMessage: "release_requires_owner_lease",
  },
  {
    name: "verified issue enters releasing with release owner lease",
    snapshot: newIssueSnapshot("21c", {
      lifecycle_state: "verified",
      owner_lease: { ...lease, role: "release_agent" },
      stage_cursor: "release",
    }),
    events: [{ type: "start_release", at: now }],
    expectedLifecycle: "releasing",
    expectedHistory: "release_started",
  },
  {
    name: "verified issue can wait for manual release approval",
    snapshot: newIssueSnapshot("21d", {
      lifecycle_state: "verified",
      stage_cursor: "verification",
    }),
    events: [{ type: "release_approval_required", at: now }],
    expectedLifecycle: "release_pending",
    expectedStage: "release",
    expectedHistory: "release_approval_required",
  },
  {
    name: "verification pass completes no-release workflow",
    workflow: noReleaseWorkflow,
    snapshot: newIssueSnapshot("22", { lifecycle_state: "verifying", owner_lease: lease, stage_cursor: "acceptance" }),
    events: [{ type: "gate_result", status: "pass", at: now }],
    expectedLifecycle: "completed",
  },
  {
    name: "verification retryable gate result without fail transition stays verifying",
    snapshot: newIssueSnapshot("23", { lifecycle_state: "verifying", owner_lease: lease, stage_cursor: "verification" }),
    events: [{ type: "gate_result", status: "fail_retryable", at: now }],
    expectedLifecycle: "verifying",
  },
  {
    name: "verification terminal gate result without fail transition stays verifying",
    snapshot: newIssueSnapshot("24", { lifecycle_state: "verifying", owner_lease: lease, stage_cursor: "verification" }),
    events: [{ type: "gate_result", status: "fail_terminal", at: now }],
    expectedLifecycle: "verifying",
  },
  {
    name: "operator quarantine moves active issue to quarantined",
    snapshot: newIssueSnapshot("25", { lifecycle_state: "running", owner_lease: lease, stage_cursor: "implementation" }),
    events: [{ type: "operator_quarantine", reason: "manual check" }],
    expectedLifecycle: "quarantined",
    expectedHistory: "operator_quarantine",
  },
];

for (const transitionCase of transitionCases) {
  test(transitionCase.name, () => {
    const result = applyRuntimeEvents(
      transitionCase.snapshot,
      transitionCase.workflow ?? workflow,
      transitionCase.events,
    );

    assert.equal(result.snapshot.lifecycle_state, transitionCase.expectedLifecycle);
    if (transitionCase.expectedStage) {
      assert.equal(result.snapshot.runtime_context_json.stage_cursor, transitionCase.expectedStage);
    }
    if (transitionCase.expectedHistory) {
      assert.equal(result.history.some((entry) => entry.event_type === transitionCase.expectedHistory), true);
    }
    if (transitionCase.expectedMessage) {
      assert.equal(result.operatorMessages.some((message) => message.code === transitionCase.expectedMessage), true);
    }
    if (transitionCase.expectedHeartbeatSeq !== undefined) {
      assert.equal(result.snapshot.runtime_context_json.owner_lease?.heartbeat_seq, transitionCase.expectedHeartbeatSeq);
    }
    if (transitionCase.expectedChildStatus) {
      assert.equal(result.snapshot.runtime_context_json.child_runs?.[0]?.status, transitionCase.expectedChildStatus);
    }
    if (transitionCase.expectedChildRootSessionId) {
      assert.equal(
        result.snapshot.runtime_context_json.child_runs?.[0]?.root_session_id,
        transitionCase.expectedChildRootSessionId,
      );
    }
    if (transitionCase.expectedOwnerLeaseReleased) {
      assert.equal(result.snapshot.current_session_id, undefined);
      assert.equal(result.snapshot.runtime_context_json.owner_lease, undefined);
    }
  });
}

test("operator resume to ready clears quarantined runtime fences", () => {
  const snapshot = newIssueSnapshot("resume-clear", {
    lifecycle_state: "quarantined",
    owner_lease: lease,
    stage_cursor: "implementation",
    child_runs: [{
      child_run_id: "child-resume-clear",
      lease_id: lease.lease_id,
      root_session_id: lease.root_session_id,
      role: "implementation_agent",
      status: "blocked",
      session_id: "session-resume-clear",
      started_at: now,
      last_seen_at: now,
    }],
    runtime_context_json: {
      blocked_by: ["host_liveness"],
      last_error: "Host root liveness is missing",
      current_stage: "implementation",
      exception: { id: "exc-1" },
      exception_carry_forward: { reason: "temporary" },
      runtime_recovery: { reason_code: "host_liveness_lost" },
    },
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "operator_resume_to_ready",
    reason: "runtime bug fixed",
    target: "running",
  }]);

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.current_session_id, undefined);
  assert.equal(result.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, undefined);
  assert.equal(result.snapshot.runtime_context_json.current_stage, undefined);
  assert.equal(result.snapshot.runtime_context_json.blocked_by, undefined);
  assert.equal(result.snapshot.runtime_context_json.last_error, undefined);
  assert.equal(result.snapshot.runtime_context_json.exception, undefined);
  assert.equal(result.snapshot.runtime_context_json.exception_carry_forward, undefined);
  assert.equal(result.snapshot.runtime_context_json.runtime_recovery, undefined);
  assert.equal(result.snapshot.runtime_context_json.child_runs, undefined);
  const resumeHistory = result.history.find((entry) => entry.event_type === "operator_resume");
  assert.equal(resumeHistory?.payload.reason, "runtime bug fixed");
  assert.equal(resumeHistory?.payload.target, "running");
});

test("operator resume routes release cleanup exceptions back to release stage", () => {
  const snapshot = newIssueSnapshot("19d", {
    lifecycle_state: "quarantined",
    stage_cursor: "release",
    runtime_context_json: {
      exception: {
        id: "exc-release",
        source_stage: "release",
        artifact_kind: "release_result",
        status: "blocked",
        summary: "PR #6 is already merged but local sync and worktree cleanup are incomplete.",
        payload: {
          release: {
            merge_commit: "merge-sha-6",
            local_sync: {
              base_branch: "main",
              local_head: "old-main",
              remote_head: "merge-sha-6",
              matches_remote: false,
            },
            worktree_cleanup: {
              path: ".northstar/runtime/worktrees/issue-6",
              removed: false,
            },
          },
        },
      },
      child_runs: [{ child_run_id: "child-release", lease_id: "lease-release", root_session_id: "root-release", role: "release_agent", status: "blocked" }],
    },
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "operator_resume_to_ready",
    reason: "release prompt fixed",
    target: "ready",
  }]);

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "release");
  assert.equal(result.snapshot.runtime_context_json.exception, undefined);
  assert.equal(result.snapshot.runtime_context_json.child_runs, undefined);
  assert.deepEqual(result.snapshot.runtime_context_json.exception_carry_forward, {
    error: "PR #6 is already merged but local sync and worktree cleanup are incomplete.",
    release_context: {
      merge_commit: "merge-sha-6",
      local_head: "old-main",
      remote_head: "merge-sha-6",
      worktree_cleanup_path: ".northstar/runtime/worktrees/issue-6",
    },
  });
});

test("operator resume routes verifier retryable failures back to implementation with feedback", () => {
  const snapshot = newIssueSnapshot("19e", {
    lifecycle_state: "quarantined",
    stage_cursor: "verification",
    runtime_context_json: {
      exception: {
        id: "exc-verifier",
        source_stage: "verification",
        artifact_kind: "verification_result",
        status: "failed_retryable",
        summary: "Verifier found incomplete filter behavior.",
        payload: {
          feedback_for_implementation: ["Fix completed filter.", "Add reload persistence evidence."],
        },
      },
      child_runs: [{ child_run_id: "child-verifier", lease_id: "lease-verifier", root_session_id: "root-verifier", role: "verifier_agent", status: "failed" }],
    },
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "operator_resume_to_ready",
    reason: "implementation can fix verifier feedback",
    target: "ready",
  }]);

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.deepEqual(result.snapshot.runtime_context_json.exception_carry_forward, {
    error: "Verifier found incomplete filter behavior.",
    feedback_for_implementation: ["Fix completed filter.", "Add reload persistence evidence."],
  });
});

test("operator resume routes verifier release-owned readiness failures to release", () => {
  const snapshot = newIssueSnapshot("19f", {
    lifecycle_state: "quarantined",
    stage_cursor: "verification",
    runtime_context_json: {
      exception: {
        id: "exc-verifier-release",
        source_stage: "verification",
        artifact_kind: "verification_result",
        status: "failed_retryable",
        summary: "Functional verification passed, but GitHub reports PR #4 mergeable=false because the branch is behind main.",
        payload: {
          failure_owner: "release",
          feedback_for_release: ["Update PR #4 branch onto current main and continue release readiness checks."],
        },
      },
      child_runs: [{ child_run_id: "child-verifier-release", lease_id: "lease-verifier", root_session_id: "root-verifier", role: "verifier_agent", status: "failed" }],
    },
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "operator_resume_to_ready",
    reason: "release worker owns mergeability recovery",
    target: "ready",
  }]);

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "release");
  assert.deepEqual(result.snapshot.runtime_context_json.exception_carry_forward, {
    error: "Functional verification passed, but GitHub reports PR #4 mergeable=false because the branch is behind main.",
    feedback_for_release: ["Update PR #4 branch onto current main and continue release readiness checks."],
  });
});

test("child run binding explicitly records root session, lease, and stage role", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("binding-1", { lifecycle_state: "claimed", owner_lease: lease, stage_cursor: "implementation" }),
    workflow,
    [{ type: "start_stage", child_run_id: "child-binding-1", session_id: "child-session-binding-1", at: now }],
  );

  assert.deepEqual(result.snapshot.runtime_context_json.child_runs?.[0], {
    child_run_id: "child-binding-1",
    lease_id: "lease-1",
    root_session_id: "root-1",
    role: "implementation_agent",
    status: "running",
    session_id: "child-session-binding-1",
    started_at: now,
    last_seen_at: now,
  });
});

test("start stage records optional host capability report on child run", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("42", { lifecycle_state: "claimed", owner_lease: lease }),
    workflow,
    [{
      type: "start_stage",
      child_run_id: "child-capability-1",
      session_id: "session-capability-1",
      at: now,
      capability_report: {
        host: "pi",
        applied: ["model"],
        defaulted: ["agent"],
        unsupported: ["load_skills", "mcp_servers"],
      },
    }],
  );

  assert.deepEqual(result.snapshot.runtime_context_json.child_runs?.[0]?.capability_report, {
    host: "pi",
    applied: ["model"],
    defaulted: ["agent"],
    unsupported: ["load_skills", "mcp_servers"],
  });
});

test("stream session recording preserves planned runtime ownership ids", () => {
  const started = applyRuntimeEvents(
    newIssueSnapshot("stream-binding-1", { lifecycle_state: "claimed", owner_lease: lease, stage_cursor: "implementation" }),
    workflow,
    [{ type: "start_stage", child_run_id: "planned-child-1", session_id: "planned-root-1", at: now }],
  );

  const result = applyRuntimeEvents(started.snapshot, workflow, [{
    type: "record_stream_session",
    child_run_id: "planned-child-1",
    stream_adapter: "codex",
    stream_session_id: "codex-real-session-1",
    stream_root_session_id: "codex-real-session-1",
    stream_child_run_id: "codex-real-session-1:implement",
    at: "2026-05-29T00:01:00.000Z",
  }]);

  const child = result.snapshot.runtime_context_json.child_runs?.[0];
  assert.equal(child?.root_session_id, "root-1");
  assert.equal(child?.session_id, "planned-root-1");
  assert.equal(child?.stream_adapter, "codex");
  assert.equal(child?.stream_session_id, "codex-real-session-1");
  assert.equal(child?.stream_child_run_id, "codex-real-session-1:implement");
  assert.equal(result.history[0]?.event_type, "host_stream_session_recorded");
});

test("child artifact submission records artifact history id on the child run", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("artifact-binding-1", {
      lifecycle_state: "running",
      owner_lease: lease,
      stage_cursor: "implementation",
      child_runs: [{
        child_run_id: "child-1",
        lease_id: "lease-1",
        root_session_id: "root-1",
        role: "implementation_agent",
        status: "running",
        session_id: "child-session-1",
        started_at: now,
        last_seen_at: now,
      }],
    }),
    workflow,
    [{ type: "child_artifact", child_run_id: "child-1", status: "succeeded", artifact_history_id: 42, at: now }],
  );

  assert.equal(result.snapshot.runtime_context_json.child_runs?.[0]?.artifact_history_id, 42);
});

test("invalid child artifact records rejection and raises exception", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("artifact-reject-1", {
      lifecycle_state: "running",
      stage_cursor: "implementation",
      child_runs: [{
        child_run_id: "child-1",
        lease_id: "lease-1",
        root_session_id: "root-1",
        role: "implementation_agent",
        status: "running",
        session_id: "session-1",
        started_at: now,
        last_seen_at: now,
      }],
    }),
    workflow,
    [{
      type: "child_artifact",
      child_run_id: "child-1",
      role: "implementation_agent",
      artifact_kind: "worker_result",
      status: "succeeded",
      artifact_history_id: 999,
      at: now,
      observed_at: now,
      payload: { artifact_kind: "worker_result", status: "success" },
    }],
  );

  assert.equal(result.snapshot.lifecycle_state, "exception");
  assert.equal(result.history.some((entry) => entry.event_type === "artifact_rejected"), true);
  assert.equal(result.history.some((entry) => entry.event_type === "exception_raised"), true);
  assert.equal(result.snapshot.runtime_context_json.child_runs?.[0]?.status, "failed");
});

test("child artifact validation keeps runtime envelope fields canonical over worker payload aliases", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("artifact-canonical-1", {
      lifecycle_state: "running",
      stage_cursor: "implementation",
      runtime_context_json: {
        issue_packet: {
          issue_number: "39",
          title: "Canonical artifact",
          raw_text: "Acceptance: validate artifact aliases",
          source_url: "https://github.test/owner/repo/issues/39",
        },
      },
      child_runs: [{
        child_run_id: "child-1",
        lease_id: "lease-1",
        root_session_id: "root-1",
        role: "implementation_agent",
        status: "running",
        session_id: "session-1",
        started_at: now,
        last_seen_at: now,
      }],
    }),
    workflow,
    [{
      type: "child_artifact",
      child_run_id: "child-1",
      role: "implementation_agent",
      artifact_kind: "worker_result",
      status: "succeeded",
      artifact_history_id: 1000,
      at: now,
      observed_at: now,
      summary: "worker finished",
      payload: {
        artifact_kind: "northstar_worker_result",
        status: "success",
        branch: "northstar/issue-39",
        base_branch: "main",
        commit_sha: "head-39",
        changed_files: ["README.md"],
        commands_run: [{ command: "npm test", status: "passed" }],
        test_summary: { status: "passed" },
        self_check_summary: "browser tests passed",
      },
    }],
  );

  assert.equal(result.snapshot.lifecycle_state, "verifying");
  assert.equal(result.history.some((entry) => entry.event_type === "artifact_rejected"), false);
  assert.equal(result.history.some((entry) => entry.event_type === "child_artifact_received"), true);
});

test("child artifact history preserves artifact status separately from child status", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("artifact-status-1", {
      lifecycle_state: "running",
      stage_cursor: "implementation",
      runtime_context_json: {
        issue_packet: {
          issue_number: "41",
          title: "Artifact status",
          raw_text: "Acceptance: preserve artifact status",
          source_url: "https://github.test/owner/repo/issues/41",
        },
      },
      child_runs: [{
        child_run_id: "child-1",
        lease_id: "lease-1",
        root_session_id: "root-1",
        role: "implementation_agent",
        status: "running",
        session_id: "session-1",
        started_at: now,
        last_seen_at: now,
      }],
    }),
    workflow,
    [{
      type: "child_artifact",
      child_run_id: "child-1",
      role: "implementation_agent",
      artifact_kind: "implementation_result",
      status: "succeeded",
      artifact_history_id: 1001,
      at: now,
      observed_at: now,
      summary: "implementation finished",
      retryable: false,
      payload: {
        schema_version: "1.0",
        artifact_kind: "implementation_result",
        issue_number: 41,
        role: "implementation_agent",
        status: "ready_for_verification",
        observed_at: now,
        summary: "implementation finished",
        retryable: false,
        pr: { url: "https://github.test/owner/repo/pull/41", number: 41 },
        changed_files: ["src/main.ts"],
        commands_run: [{ command: "npm test", status: "passed" }],
        self_check_summary: "contract checked",
        evidence: [{ type: "test", value: "npm test" }],
        workspace_evidence: {
          path_checked: ".northstar/runtime/worktrees/issue-41-artifact-status",
          base_source: "origin/main",
          base_commit: "base-sha-41",
          expected_branch: "northstar/41",
          observed_branch: "northstar/41",
          expected_head_sha: "head-sha-41",
          observed_head_sha: "head-sha-41",
          matches_expected: true,
        },
      },
    }],
  );

  const received = result.history.find((entry) => entry.event_type === "child_artifact_received");
  assert.equal(received?.payload.status, "ready_for_verification");
  assert.equal(received?.payload.child_status, "succeeded");
});

test("child artifact validation rejects explicit payload issue mismatch", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("github:42", {
      lifecycle_state: "running",
      stage_cursor: "implementation",
      runtime_context_json: {
        issue_packet: {
          issue_number: "42",
          title: "Reject mismatched artifact",
          raw_text: "Acceptance: validate artifact binding",
          source_url: "https://github.test/owner/repo/issues/42",
        },
        child_runs: [{
          child_run_id: "child-42",
          lease_id: "lease-42",
          root_session_id: "root-42",
          role: "implementation_agent",
          status: "running",
          session_id: "session-42",
          started_at: now,
          last_seen_at: now,
        }],
      },
    }),
    workflow,
    [{
      type: "child_artifact",
      child_run_id: "child-42",
      role: "implementation_agent",
      artifact_kind: "worker_result",
      status: "succeeded",
      artifact_history_id: 1042,
      at: now,
      observed_at: now,
      summary: "worker finished",
      payload: {
        schema_version: "1.0",
        artifact_kind: "worker_result",
        issue_number: 99,
        role: "implementation_agent",
        status: "success",
        observed_at: now,
        summary: "wrong issue",
        retryable: false,
        branch: "northstar/issue-42",
        base_branch: "main",
        commit_sha: "head-42",
        changed_files: ["README.md"],
        commands_run: [{ command: "npm test", status: "passed" }],
        test_summary: { status: "passed" },
        self_check_summary: "npm test passed",
      },
    }],
  );

  assert.equal(result.snapshot.lifecycle_state, "exception");
  assert.equal(result.history.some((entry) => entry.event_type === "artifact_rejected"), true);
  assert.equal(result.history.some((entry) => entry.event_type === "exception_raised"), true);
  assert.equal(result.snapshot.runtime_context_json.child_runs?.[0]?.status, "failed");
});

test("active lifecycle states are stable", () => {
  assert.deepEqual(activeLifecycleStates, ["claimed", "running", "verifying", "releasing"]);
});

test("external closed GitHub issue becomes cancelled terminal runtime", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("github:13", {
      lifecycle_state: "ready",
      stage_cursor: "implementation",
      current_session_id: "stale-session",
      child_runs: [{
        child_run_id: "child-1",
        lease_id: "lease-1",
        root_session_id: "root-1",
        role: "implementation_agent",
        status: "running",
        session_id: "session-1",
        started_at: now,
        last_seen_at: now,
      }],
    }),
    workflow,
    [{
      type: "external_issue_closed_detected",
      issue_number: 13,
      state_reason: "not_planned",
      closed_at: "2026-06-01T11:48:12Z",
      labels: ["northstar:ready"],
      at: now,
    }],
  );

  assert.equal(result.snapshot.lifecycle_state, "cancelled");
  assert.equal(result.snapshot.current_session_id, undefined);
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, undefined);
  assert.equal(result.snapshot.runtime_context_json.child_runs?.[0]?.status, "blocked");
  assert.deepEqual(result.snapshot.runtime_context_json.github_issue_state, {
    state: "closed",
    issue_number: 13,
    state_reason: "not_planned",
    closed_at: "2026-06-01T11:48:12Z",
    labels: ["northstar:ready"],
  });
  assert.equal(result.history.at(-1)?.event_type, "external_issue_closed_detected");
});

test("active issue without lease reports invariant violation", () => {
  const violations = inspectInvariantViolations(newIssueSnapshot("26", { lifecycle_state: "running" }), now);

  assert.deepEqual(violations, ["active_issue_missing_owner_lease"]);
});

test("expired lease reports invariant violation", () => {
  const expiredLease = { ...lease, expires_at: "2026-05-29T02:59:59.000Z" };
  const violations = inspectInvariantViolations(
    newIssueSnapshot("27", { lifecycle_state: "running", owner_lease: expiredLease }),
    now,
  );

  assert.deepEqual(violations, ["active_issue_expired_owner_lease"]);
});

test("domain workflow advances by canonical child artifacts without coding role chains", () => {
  const domainWorkflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/content-creation-publish.yaml"));
  const domainLease = createOwnerLease({
    lease_id: "lease-domain",
    root_session_id: "root-domain",
    role: "content_coordinator",
    now: "2026-05-29T00:00:00.000Z",
    ttl_seconds: 60,
  });
  const snapshot = newIssueSnapshot("content-1", {
    lifecycle_state: "running",
    owner_lease: domainLease,
    stage_cursor: "draft",
  });

  const result = applyRuntimeEvents(snapshot, domainWorkflow, [
    { type: "start_stage", child_run_id: "child-draft", session_id: "session-draft", at: "2026-05-29T00:00:01.000Z" },
    { type: "child_artifact", child_run_id: "child-draft", status: "succeeded", artifact_history_id: 101, at: "2026-05-29T00:00:02.000Z" },
  ]);

  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "editorial_review");
  assert.equal(result.snapshot.lifecycle_state, "verifying");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.[0]?.role, "writer");
});

test("retryable verification failure raises exception instead of immediate stage retry", () => {
  const snapshot = newIssueSnapshot("retry-budget-1", {
    lifecycle_state: "verifying",
    owner_lease: { ...lease, role: "verifier_agent" },
    stage_cursor: "verification",
    child_runs: [{
      child_run_id: "verify-child-1",
      lease_id: "lease-1",
      root_session_id: "root-1",
      role: "verifier_agent",
      status: "running",
      session_id: "verify-session-1",
      started_at: now,
      last_seen_at: now,
    }],
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "child_artifact",
    child_run_id: "verify-child-1",
    status: "failed_retryable",
    artifact_history_id: 201,
    at: now,
  }]);

  assert.equal(result.snapshot.lifecycle_state, "exception");
  assert.equal(result.snapshot.runtime_context_json.exception?.attempt_count, 1);
  assert.equal(result.history.some((entry) => entry.event_type === "exception_raised"), true);
});

test("retryable verification failure increments exception attempts across repeated raises", () => {
  const snapshot = newIssueSnapshot("retry-budget-2", {
    lifecycle_state: "verifying",
    owner_lease: { ...lease, role: "verifier_agent" },
    stage_cursor: "verification",
    runtime_context_json: {
      exception: {
        id: "exc-old",
        attempt_count: 1,
      },
    },
    child_runs: [{
      child_run_id: "verify-child-2",
      lease_id: "lease-1",
      root_session_id: "root-1",
      role: "verifier_agent",
      status: "running",
      session_id: "verify-session-2",
      started_at: now,
      last_seen_at: now,
    }],
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "child_artifact",
    child_run_id: "verify-child-2",
    status: "failed_retryable",
    artifact_history_id: 202,
    at: now,
  }]);

  assert.equal(result.snapshot.lifecycle_state, "exception");
  assert.equal(result.snapshot.runtime_context_json.exception?.attempt_count, 2);
  assert.equal(result.history.some((entry) => entry.event_type === "exception_raised"), true);
});

test("domain workflow records gate, heartbeat, projection, and effect facts through canonical events", () => {
  const domainWorkflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/content-creation-publish.yaml"));
  const domainLease = createOwnerLease({
    lease_id: "lease-domain",
    root_session_id: "root-domain",
    role: "content_coordinator",
    now: "2026-05-29T00:00:00.000Z",
    ttl_seconds: 60,
  });
  const snapshot = newIssueSnapshot("content-2", {
    lifecycle_state: "verifying",
    owner_lease: domainLease,
    stage_cursor: "approval",
  });

  const result = applyRuntimeEvents(snapshot, domainWorkflow, [
    { type: "heartbeat", lease_id: "lease-domain", at: "2026-05-29T00:00:03.000Z", ttl_seconds: 60 },
    { type: "gate_result", status: "pass", at: "2026-05-29T00:00:04.000Z" },
    {
      type: "projection_result",
      projection_target: "content_calendar",
      status: "failed",
      attempt: 1,
      last_error: "calendar unavailable",
      next_retry_at: "2026-05-29T00:05:00.000Z",
      payload: { workflow_id: "content_creation_publish" },
    },
    {
      type: "effect_result",
      effect_type: "publish_content",
      status: "failed",
      last_error: "cms unavailable",
      next_retry_at: "2026-05-29T00:05:00.000Z",
    },
  ]);

  assert.equal(result.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "publish");
  assert.equal(result.snapshot.lifecycle_state, "releasing");
  assert.equal(result.history.some((entry) => entry.event_type === "owner_heartbeat"), true);
  assert.match(JSON.stringify(result.history), /content_calendar/);
  assert.match(JSON.stringify(result.history), /publish_content/);
});

test("validated child artifacts derive issue number from intake packet for prefixed issue ids", () => {
  const snapshot = newIssueSnapshot("local:1001", {
    lifecycle_state: "running",
    owner_lease: createOwnerLease({
      lease_id: "lease-prefixed-1",
      root_session_id: "root-prefixed-1",
      role: "implementation_agent",
      now,
      ttl_seconds: 180,
    }),
    stage_cursor: "implementation",
    runtime_context_json: {
      issue_packet: { issue_number: "1001" },
      child_runs: [{
        child_run_id: "child-prefixed-1",
        lease_id: "lease-prefixed-1",
        root_session_id: "root-prefixed-1",
        role: "implementation_agent",
        status: "running",
        session_id: "session-prefixed-1",
        started_at: now,
        last_seen_at: now,
      }],
      projection_sync: [],
    },
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "child_artifact",
    child_run_id: "child-prefixed-1",
    status: "succeeded",
    artifact_history_id: 1,
    at: now,
    artifact_kind: "worker_result",
    schema_version: "1.0",
    summary: "Implementation complete",
    retryable: false,
    payload: {
      branch: "northstar/e2e",
      base_branch: "main",
      commit_sha: "abc123",
      changed_files: ["src/example.ts"],
      commands_run: [{ command: "npm test", status: "passed" }],
      test_summary: { passed: 1, failed: 0 },
      self_check_summary: "npm test passed",
    },
  }]);

  assert.equal(result.snapshot.lifecycle_state, "verifying");
  assert.equal(result.history.some((entry) => entry.event_type === "artifact_rejected"), false);
});

test("verified issue can acquire release owner lease without leaving verified", () => {
  const snapshot = newIssueSnapshot("release-lease-1", {
    lifecycle_state: "verified",
    stage_cursor: "release",
  });
  const releaseLease = createOwnerLease({
    lease_id: "release-lease-1",
    root_session_id: "release-root-1",
    role: "release_agent",
    now,
    ttl_seconds: 180,
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{ type: "claim_owner_lease", lease: releaseLease }]);

  assert.equal(result.snapshot.lifecycle_state, "verified");
  assert.equal(result.snapshot.runtime_context_json.owner_lease?.role, "release_agent");
  assert.equal(result.history.at(-1)?.event_type, "owner_lease_acquired");
});

test("terminal lifecycle clears active runtime ownership and resolves running children", () => {
  const snapshot = newIssueSnapshot("terminal-cleanup-1", {
    lifecycle_state: "running",
    current_session_id: "root-1",
    owner_lease: lease,
    stage_cursor: "implementation",
    child_runs: [{
      child_run_id: "child-1",
      lease_id: "lease-1",
      root_session_id: "root-1",
      role: "implementation_agent",
      status: "running",
      session_id: "session-1",
      started_at: now,
      last_seen_at: now,
    }],
  });

  const completed = applyRuntimeEvents(snapshot, workflow, [
    { type: "release_result", status: "success", pr_merged: true, merge_sha: "merge-1", at: now },
  ]);

  assert.equal(completed.snapshot.lifecycle_state, "completed");
  assert.equal(completed.snapshot.current_session_id, undefined);
  assert.equal(completed.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(completed.snapshot.runtime_context_json.stage_cursor, undefined);
  assert.equal(completed.snapshot.runtime_context_json.child_runs?.[0]?.status, "succeeded");

  const quarantined = applyRuntimeEvents(snapshot, workflow, [
    { type: "operator_quarantine", reason: "operator stopped stale active run" },
  ]);

  assert.equal(quarantined.snapshot.lifecycle_state, "quarantined");
  assert.equal(quarantined.snapshot.current_session_id, undefined);
  assert.equal(quarantined.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(quarantined.snapshot.runtime_context_json.stage_cursor, undefined);
  assert.equal(quarantined.snapshot.runtime_context_json.child_runs?.[0]?.status, "blocked");
});

test("completed release child artifact forces terminal completion even from stale stage cursor", () => {
  const releaseLease = createOwnerLease({
    lease_id: "lease-release-13",
    root_session_id: "root-release-13",
    role: "release_agent",
    now,
    ttl_seconds: 180,
  });
  const snapshot = newIssueSnapshot("github:13", {
    lifecycle_state: "verifying",
    current_session_id: "root-release-13",
    runtime_context_json: {
      issue_packet: { issue_number: "13" },
    },
    owner_lease: releaseLease,
    stage_cursor: "verification",
    child_runs: [{
      child_run_id: "child-release-13",
      lease_id: "lease-release-13",
      root_session_id: "root-release-13",
      role: "release_agent",
      status: "running",
      session_id: "root-release-13",
      started_at: now,
      last_seen_at: now,
    }],
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "child_artifact",
    child_run_id: "child-release-13",
    status: "succeeded",
    artifact_history_id: 42,
    artifact_kind: "release_result",
    role: "release_agent",
    at: now,
    payload: {
      schema_version: "1.0",
      artifact_kind: "release_result",
      issue_number: 13,
      role: "release_agent",
      status: "completed",
      observed_at: now,
      summary: "release completed",
      retryable: false,
      release: {
        confirmed: true,
        merge_commit: "merge-13",
        local_sync: {
          base_branch: "main",
          synced: true,
          local_head: "merge-13",
          remote_head: "merge-13",
          matches_remote: true,
        },
        repo_root_sync: {
          status: "skipped",
          reason: "repo_root_dirty",
        },
        worktree_cleanup: {
          path: ".northstar/runtime/worktrees/issue-13",
          removed: true,
        },
      },
      issue_update: {
        comment_summary: "Released via PR #14.",
        close_issue: true,
        labels_to_add: ["northstar:released"],
        labels_to_remove: ["northstar:ready"],
      },
      evidence: [
        { type: "merge_commit", value: "merge-13" },
        { type: "local_remote_sync", value: "sync worktree at merge-13" },
        { type: "worktree_cleanup", value: "removed .northstar/runtime/worktrees/issue-13" },
      ],
    },
  }]);

  assert.equal(result.snapshot.lifecycle_state, "completed");
  assert.equal(result.snapshot.current_session_id, undefined);
  assert.equal(result.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, undefined);
  assert.equal(result.snapshot.runtime_context_json.child_runs?.[0]?.status, "succeeded");
  assert.equal(result.snapshot.runtime_context_json.release?.pr_merged, true);
  assert.equal(result.snapshot.runtime_context_json.release?.merge_sha, "merge-13");
  assert.deepEqual(result.snapshot.runtime_context_json.release?.local_sync, {
    base_branch: "main",
    synced: true,
    local_head: "merge-13",
    remote_head: "merge-13",
    matches_remote: true,
  });
  assert.deepEqual(result.snapshot.runtime_context_json.release?.worktree_cleanup, {
    path: ".northstar/runtime/worktrees/issue-13",
    removed: true,
  });
});

test("release result records successful sync worktree refresh audit after completion", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("sync-worktree-success-1", {
      lifecycle_state: "release_pending",
      owner_lease: { ...lease, role: "release_agent" },
      stage_cursor: "release",
    }),
    workflow,
    [{
      type: "release_result",
      status: "success",
      pr_merged: true,
      merge_sha: "merge-sync-1",
      at: now,
      sync_worktree: {
        status: "synced",
        path: "/repo/.northstar/runtime/sync-worktrees/main",
        head_commit: "merge-sync-1",
        expected_commit: "merge-sync-1",
      },
    }],
  );

  assert.equal(result.snapshot.lifecycle_state, "completed");
  assert.deepEqual(result.snapshot.runtime_context_json.release?.sync_worktree_refresh, {
    status: "synced",
    path: "/repo/.northstar/runtime/sync-worktrees/main",
    head_commit: "merge-sync-1",
    expected_commit: "merge-sync-1",
  });
  assert.equal(result.history.some((entry) => entry.event_type === "sync_worktree_refreshed"), true);
});

test("external merge recovery records successful sync worktree refresh audit after completion", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("external-sync-worktree-success-1", {
      lifecycle_state: "running",
      owner_lease: lease,
      stage_cursor: "implementation",
    }),
    workflow,
    [{
      type: "external_merge_detected",
      pr_number: 99,
      pr_url: "https://github.test/owner/repo/pull/99",
      head_commit: "head-99",
      merge_sha: "merge-sync-external-1",
      at: now,
      sync_worktree: {
        status: "synced",
        path: "/repo/.northstar/runtime/sync-worktrees/main",
        head_commit: "merge-sync-external-1",
        expected_commit: "merge-sync-external-1",
      },
    }],
  );

  assert.equal(result.snapshot.lifecycle_state, "completed");
  assert.deepEqual(result.snapshot.runtime_context_json.release?.sync_worktree_refresh, {
    status: "synced",
    path: "/repo/.northstar/runtime/sync-worktrees/main",
    head_commit: "merge-sync-external-1",
    expected_commit: "merge-sync-external-1",
  });
  assert.equal(result.history.some((entry) => entry.event_type === "external_merge_detected"), true);
  assert.equal(result.history.some((entry) => entry.event_type === "sync_worktree_refreshed"), true);
});

test("release result records failed sync worktree refresh as recoverable audit without reversing completion", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("sync-worktree-failed-1", {
      lifecycle_state: "release_pending",
      owner_lease: { ...lease, role: "release_agent" },
      stage_cursor: "release",
    }),
    workflow,
    [{
      type: "release_result",
      status: "success",
      pr_merged: true,
      merge_sha: "merge-sync-2",
      at: now,
      sync_worktree: {
        status: "failed",
        path: "/repo/.northstar/runtime/sync-worktrees/main",
        head_commit: "stale-main",
        expected_commit: "merge-sync-2",
        code: "SYNC_WORKTREE_HEAD_MISMATCH",
        last_error: "sync worktree HEAD stale-main does not match merged main merge-sync-2",
        retryable: true,
      },
    }],
  );

  assert.equal(result.snapshot.lifecycle_state, "completed");
  assert.equal(result.snapshot.runtime_context_json.last_error, "sync worktree HEAD stale-main does not match merged main merge-sync-2");
  assert.deepEqual(result.snapshot.runtime_context_json.blocked_by, ["sync_worktree"]);
  assert.equal(result.history.some((entry) => entry.event_type === "sync_worktree_refresh_failed"), true);
});

test("sync worktree refresh blocker does not overwrite unrelated blockers", () => {
  const failed = applyRuntimeEvents(
    newIssueSnapshot("sync-worktree-blocker-merge-1", {
      lifecycle_state: "completed",
      runtime_context_json: {
        blocked_by: ["operator"],
        last_error: "operator review pending",
      },
    }),
    workflow,
    [{
      type: "sync_worktree_refresh_result",
      at: now,
      sync_worktree: {
        status: "failed",
        path: "/repo/.northstar/runtime/sync-worktrees/main",
        head_commit: "stale-main",
        expected_commit: "merge-sync-2",
        code: "SYNC_WORKTREE_HEAD_MISMATCH",
        last_error: "sync worktree HEAD stale-main does not match merged main merge-sync-2",
        retryable: true,
      },
    }],
  );

  assert.deepEqual(failed.snapshot.runtime_context_json.blocked_by, ["operator", "sync_worktree"]);

  const synced = applyRuntimeEvents(
    failed.snapshot,
    workflow,
    [{
      type: "sync_worktree_refresh_result",
      at: now,
      sync_worktree: {
        status: "synced",
        path: "/repo/.northstar/runtime/sync-worktrees/main",
        head_commit: "merge-sync-2",
        expected_commit: "merge-sync-2",
      },
    }],
  );

  assert.deepEqual(synced.snapshot.runtime_context_json.blocked_by, ["operator"]);
});

test("release result records skipped sync worktree refresh audit after completion", () => {
  const result = applyRuntimeEvents(
    newIssueSnapshot("sync-worktree-skipped-1", {
      lifecycle_state: "release_pending",
      owner_lease: { ...lease, role: "release_agent" },
      stage_cursor: "release",
    }),
    workflow,
    [{
      type: "release_result",
      status: "success",
      pr_merged: true,
      merge_sha: "merge-sync-3",
      at: now,
      sync_worktree: {
        status: "skipped",
        expected_commit: "merge-sync-3",
      },
    }],
  );

  assert.equal(result.snapshot.lifecycle_state, "completed");
  assert.equal(result.snapshot.runtime_context_json.last_error, undefined);
  assert.equal(result.history.some((entry) => entry.event_type === "sync_worktree_refresh_skipped"), true);
});
