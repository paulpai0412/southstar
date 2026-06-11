import test from "node:test";
import assert from "node:assert/strict";
import { inspectSnapshot } from "../../src/runtime/inspect.ts";
import { releaseActiveRuntimeOwnership, repairSnapshot } from "../../src/runtime/repair.ts";
import { createOwnerLease, newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import { loadWorkflow } from "../../src/types/workflow.ts";

const now = "2026-05-29T03:00:00.000Z";
const lease = createOwnerLease({
  lease_id: "lease-1",
  root_session_id: "root-1",
  role: "issue_worker",
  now,
  ttl_seconds: 180,
});
const workflow = loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml");

test("repair releases active issue without valid owner lease into exception", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-1", { lifecycle_state: "running" }), now);

  assert.equal(repaired.snapshot.lifecycle_state, "exception");
  assert.equal(repaired.history[0].event_type, "admin_action");
  assert.equal(repaired.history[0].payload.action, "release_active_runtime_ownership");
});

test("runtime ownership release removes only host liveness blocker", () => {
  const released = releaseActiveRuntimeOwnership(newIssueSnapshot("repair-host-blocker-1", {
    lifecycle_state: "running",
    current_session_id: "root-1",
    owner_lease: lease,
    runtime_context_json: {
      blocked_by: ["host_liveness", "dependency:39:quarantined"],
      last_error: "host liveness lost",
    },
  }), workflow, {
    now,
    reasonCode: "host_liveness_lost",
  });

  assert.deepEqual(released.snapshot.runtime_context_json.blocked_by, ["dependency:39:quarantined"]);
});

test("runtime ownership release clears singleton host blocker and stage cursor on ready recovery", () => {
  const released = releaseActiveRuntimeOwnership(newIssueSnapshot("repair-host-blocker-2", {
    lifecycle_state: "failed",
    stage_cursor: "verification",
    current_session_id: "root-2",
    owner_lease: lease,
    runtime_context_json: {
      blocked_by: ["host_liveness"],
      last_error: "host liveness lost",
    },
  }), workflow, {
    now,
    reasonCode: "host_liveness_lost",
  });

  assert.equal(released.snapshot.lifecycle_state, "ready");
  assert.equal(released.snapshot.runtime_context_json.blocked_by, undefined);
  assert.equal(released.snapshot.runtime_context_json.stage_cursor, undefined);
});

test("runtime ownership release removes empty blocked list", () => {
  const released = releaseActiveRuntimeOwnership(newIssueSnapshot("repair-host-blocker-3", {
    lifecycle_state: "failed",
    runtime_context_json: {
      blocked_by: [],
    },
  }), workflow, {
    now,
    reasonCode: "host_liveness_lost",
  });

  assert.equal(released.snapshot.runtime_context_json.blocked_by, undefined);
});

test("repair clears terminal stale session projections", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-2", {
    lifecycle_state: "completed",
    current_session_id: "stale-root",
    stage_cursor: "release",
  }), now);

  assert.equal(repaired.snapshot.current_session_id, undefined);
  assert.equal(repaired.snapshot.runtime_context_json.stage_cursor, undefined);
});

test("repair clears ready stale session fence", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-3", {
    lifecycle_state: "ready",
    current_session_id: "old-root",
  }), now);

  assert.equal(repaired.snapshot.current_session_id, undefined);
});

test("repair clears verified stale implementation lease and running child runs", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-verified-stale-lease", {
    lifecycle_state: "verified",
    current_session_id: "root-implementation",
    owner_lease: lease,
    stage_cursor: "verification",
    child_runs: [{
      child_run_id: "child-implementation",
      lease_id: "lease-1",
      root_session_id: "root-1",
      role: "issue_worker",
      status: "running",
      session_id: "session-implementation",
      started_at: now,
      last_seen_at: now,
    }],
  }), now);

  assert.equal(repaired.snapshot.lifecycle_state, "verified");
  assert.equal(repaired.snapshot.current_session_id, undefined);
  assert.equal(repaired.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(repaired.snapshot.runtime_context_json.child_runs?.[0]?.status, "succeeded");
  assert.equal(
    repaired.history.some((entry) => entry.payload.action === "clear_verified_stale_session_projection"),
    true,
  );
});

test("repair backfills child run root session binding from owner lease", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-binding-1", {
    lifecycle_state: "running",
    owner_lease: lease,
    child_runs: [{
      child_run_id: "child-1",
      lease_id: "lease-1",
      role: "issue_worker",
      status: "running",
      session_id: "child-session-1",
      started_at: now,
      last_seen_at: now,
    }],
  }), now);

  assert.equal(repaired.snapshot.runtime_context_json.child_runs?.[0]?.root_session_id, "root-1");
  assert.equal(
    repaired.history.some((entry) => entry.payload.action === "backfill_child_root_session_binding"),
    true,
  );
});

test("repair preserves completed after confirmed merge with failed local sync", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-4", {
    lifecycle_state: "failed",
    runtime_context_json: {
      release: { pr_merged: true },
      projection_sync: [{ projection_target: "local_main_sync", status: "failed" }],
    },
  }), now);

  assert.equal(repaired.snapshot.lifecycle_state, "completed");
  assert.equal(repaired.history.some((entry) => entry.event_type === "admin_action"), true);
});

test("vocab1 issue 35 style repair does not oscillate over three cycles", () => {
  let snapshot = newIssueSnapshot("repair-35", {
    lifecycle_state: "running",
    stage_cursor: "implementation",
    runtime_context_json: { child_runs: [] },
  });
  const states: string[] = [];

  for (let index = 0; index < 3; index++) {
    const repaired = repairSnapshot(snapshot, now);
    snapshot = repaired.snapshot;
    states.push(snapshot.lifecycle_state);
  }

  assert.deepEqual(states, ["exception", "exception", "exception"]);
});

test("vocab1 issue 64 style release/local-sync failure preserves completed", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-64", {
    lifecycle_state: "releasing",
    owner_lease: { ...lease, role: "release_worker" },
    runtime_context_json: {
      release: { pr_merged: true },
      projection_sync: [{ projection_target: "local_main_sync", status: "failed" }],
    },
  }), now);

  assert.equal(repaired.snapshot.lifecycle_state, "completed");
});

test("repair releases running issue missing expected child run into exception", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-missing-child-1", {
    lifecycle_state: "running",
    current_session_id: "root-missing",
    owner_lease: { ...lease, lease_id: "lease-missing", root_session_id: "root-missing" },
    stage_cursor: "implementation",
    child_runs: [],
  }), now, workflow);

  assert.equal(repaired.snapshot.lifecycle_state, "exception");
  assert.equal(repaired.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(repaired.snapshot.current_session_id, undefined);
  assert.equal(
    repaired.history.some((entry) =>
      entry.payload.action === "release_active_runtime_ownership" &&
      entry.payload.reason_code === "active_issue_missing_child_run"
    ),
    true,
  );
});

test("repair releases running issue with wrong stage child and marks stale child lost", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-missing-child-2", {
    lifecycle_state: "running",
    current_session_id: "root-impl",
    owner_lease: { ...lease, lease_id: "lease-wrong", root_session_id: "root-impl" },
    stage_cursor: "implementation",
    child_runs: [{
      child_run_id: "child-verifier",
      lease_id: "lease-wrong",
      root_session_id: "root-impl",
      role: "pr_verifier",
      status: "running",
      session_id: "session-verifier",
      started_at: now,
      last_seen_at: now,
    }],
  }), now, workflow);

  assert.equal(repaired.snapshot.lifecycle_state, "exception");
  assert.equal(repaired.snapshot.runtime_context_json.child_runs?.[0]?.status, "lost");
  assert.equal(
    repaired.history.some((entry) =>
      entry.payload.action === "release_active_runtime_ownership" &&
      entry.payload.reason_code === "active_issue_missing_child_run"
    ),
    true,
  );
});

test("repair releases stale release owner into exception for policy-driven retry", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-release-owner-1", {
    lifecycle_state: "releasing",
    current_session_id: "root-release",
    owner_lease: {
      ...lease,
      lease_id: "lease-release",
      root_session_id: "root-release",
      role: "release_worker",
      expires_at: "2026-05-29T02:59:00.000Z",
    },
    stage_cursor: "release",
    child_runs: [{
      child_run_id: "child-release",
      lease_id: "lease-release",
      root_session_id: "root-release",
      role: "release_worker",
      status: "running",
      session_id: "session-release",
      started_at: now,
      last_seen_at: now,
    }],
  }), now, workflow);

  assert.equal(repaired.snapshot.lifecycle_state, "exception");
  assert.equal(repaired.snapshot.runtime_context_json.stage_cursor, "release");
  assert.equal(repaired.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(repaired.snapshot.current_session_id, undefined);
  assert.equal(repaired.snapshot.runtime_context_json.child_runs?.[0]?.status, "lost");
});

test("repair leaves manual release approval pending without runtime ownership", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-release-pending-manual-1", {
    lifecycle_state: "release_pending",
    stage_cursor: "release",
  }), now, workflow);

  assert.equal(repaired.snapshot.lifecycle_state, "release_pending");
  assert.deepEqual(repaired.history, []);
});

test("repair starts a fresh runtime invariant attempt after unrelated resolved exception", () => {
  const repaired = repairSnapshot(newIssueSnapshot("repair-release-owner-after-verifier-1", {
    lifecycle_state: "releasing",
    current_session_id: "root-release",
    owner_lease: {
      ...lease,
      lease_id: "lease-release",
      root_session_id: "root-release",
      role: "release_worker",
      expires_at: "2026-05-29T02:59:00.000Z",
    },
    stage_cursor: "release",
    runtime_context_json: {
      exception: {
        id: "exc-verifier",
        state: "resolved",
        source_stage: "verification",
        artifact_kind: "verification_result",
        status: "failed_retryable",
        attempt_count: 1,
        resolved_action: "return_to_stage",
      },
      exception_carry_forward: {
        feedback_for_release: ["PR is draft."],
      },
    },
  }), now, workflow);

  assert.equal(repaired.snapshot.lifecycle_state, "exception");
  assert.equal(repaired.snapshot.runtime_context_json.exception?.summary, "active_issue_invalid_owner_lease");
  assert.equal(repaired.snapshot.runtime_context_json.exception?.source_stage, "release");
  assert.equal(repaired.snapshot.runtime_context_json.exception?.attempt_count, 1);
  assert.deepEqual(repaired.snapshot.runtime_context_json.exception_carry_forward, {
    feedback_for_release: ["PR is draft."],
  });
});

test("inspect separates lifecycle, lease, child runs, and projection sync", () => {
  const report = inspectSnapshot(newIssueSnapshot("inspect-1", {
    lifecycle_state: "running",
    owner_lease: lease,
    child_runs: [{ child_run_id: "child-1", lease_id: "lease-1", role: "issue_worker", status: "running", session_id: "s1", started_at: now, last_seen_at: now }],
    runtime_context_json: {
      projection_sync: [{ projection_target: "label", status: "failed", last_error: "rate limited" }],
    },
  }), now);

  assert.match(report, /Lifecycle/);
  assert.match(report, /Lease/);
  assert.match(report, /Child Runs/);
  assert.match(report, /root=root-1/);
  assert.match(report, /Projection Sync/);
  assert.match(report, /Invariant Violations/);
});

test("inspect renders none sections when child runs and projections are absent", () => {
  const report = inspectSnapshot(newIssueSnapshot("inspect-empty", {
    lifecycle_state: "ready",
  }), now);

  assert.match(report, /Child Runs\n  none/);
  assert.match(report, /Projection Sync\n  none/);
  assert.match(report, /Invariant Violations\n  none/);
});

test("inspect reports unknown child root and redacts projection secrets", () => {
  const secret = "ghp_1234567890ABCDEFGHIJ";
  const report = inspectSnapshot(newIssueSnapshot("inspect-redaction", {
    lifecycle_state: "running",
    child_runs: [{
      child_run_id: "child-unknown",
      lease_id: "other-lease",
      role: "implementation_agent",
      status: "running",
      session_id: "session-unknown",
      started_at: now,
      last_seen_at: now,
    }],
    runtime_context_json: {
      projection_sync: [{ projection_target: "label", status: "failed", last_error: `token ${secret}` }],
    },
  }), now);

  assert.match(report, /child-unknown: implementation_agent running root=unknown/);
  assert.match(report, /\[REDACTED\]/);
  assert.doesNotMatch(report, new RegExp(secret));
  assert.match(report, /Invariant Violations\n  active_issue_missing_owner_lease/);
});
