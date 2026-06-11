import assert from "node:assert/strict";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { test } from "node:test";

import {
  emptyCompletedWorktreeCleanupMetrics,
  isManagedWorktreePath,
  planCompletedWorktreeCleanup,
  runCompletedWorktreeCleanup,
} from "../../src/orchestrator/worktree-cleanup.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";

const now = "2026-05-31T10:00:00.000Z";
const managedRoot = "/repo/.northstar/runtime/worktrees";

test("plans archive cleanup for confirmed completed managed worktree", () => {
  const plan = planCompletedWorktreeCleanup({
    now,
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    snapshot: newIssueSnapshot("issue-42", {
      lifecycle_state: "completed",
      worktree_path: "/repo/.northstar/runtime/worktrees/issue-42-build-report",
    }),
    policy: { completedWorktrees: "archive", keepLast: 0, failedOrQuarantined: "keep" },
  });

  assert.equal(plan.action, "archive");
  assert.equal(plan.worktreePath, "/repo/.northstar/runtime/worktrees/issue-42-build-report");
  assert.equal(
    plan.archivePath,
    "/repo/.northstar/runtime/archive/worktrees/issue-42-build-report-2026-05-31T10-00-00-000Z",
  );
  assert.equal(plan.history.event_type, "completed_worktree_cleanup_planned");
});

test("rejects cleanup planning for unmanaged completed worktree paths", () => {
  const metrics = emptyCompletedWorktreeCleanupMetrics();
  const plan = planCompletedWorktreeCleanup({
    now,
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    snapshot: newIssueSnapshot("issue-43", {
      lifecycle_state: "completed",
      worktree_path: "/tmp/issue-43-outside",
    }),
    policy: { completedWorktrees: "delete", keepLast: 0, failedOrQuarantined: "keep" },
    metrics,
  });

  assert.equal(plan.action, "skip");
  assert.equal(plan.reason, "unmanaged_worktree_path");
  assert.equal(metrics.cleanup_failures_retryable, 1);
  assert.equal(metrics.cleanup_completed_reversals, 0);
  assert.equal(plan.history.event_type, "completed_worktree_cleanup_failed_retryable");
});

test("skips cleanup planning for agent-owned worktree URIs", () => {
  const metrics = emptyCompletedWorktreeCleanupMetrics();
  const plan = planCompletedWorktreeCleanup({
    now,
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    snapshot: newIssueSnapshot("issue-44", {
      lifecycle_state: "completed",
      worktree_path: "agent-owned://codex/northstar-production/issue-44",
    }),
    policy: { completedWorktrees: "archive", keepLast: 0, failedOrQuarantined: "keep" },
    metrics,
  });

  assert.equal(plan.action, "skip");
  assert.equal(plan.reason, "agent_owned_worktree");
  assert.equal(metrics.cleanup_failures_retryable, 0);
  assert.equal(plan.history.event_type, "completed_worktree_cleanup_skipped");
});

test("managed worktree path validation accepts Windows child paths", () => {
  assert.equal(
    isManagedWorktreePath(
      "C:\\repo\\.northstar\\runtime\\worktrees",
      "C:\\repo\\.northstar\\runtime\\worktrees\\issue-50-safe",
      pathWin32,
    ),
    true,
  );
});

test("managed worktree path validation rejects Windows sibling prefixes", () => {
  assert.equal(
    isManagedWorktreePath(
      "C:\\repo\\.northstar\\runtime\\worktrees",
      "C:\\repo\\.northstar\\runtime\\worktrees-extra\\issue-50-unsafe",
      pathWin32,
    ),
    false,
  );
});

test("managed worktree path validation rejects POSIX sibling prefixes", () => {
  assert.equal(
    isManagedWorktreePath(
      "/repo/.northstar/runtime/worktrees",
      "/repo/.northstar/runtime/worktrees-extra/issue-50-unsafe",
      pathPosix,
    ),
    false,
  );
});

test("keep policy records no cleanup attempt", () => {
  const metrics = emptyCompletedWorktreeCleanupMetrics();
  const plan = planCompletedWorktreeCleanup({
    now,
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    snapshot: newIssueSnapshot("issue-44", {
      lifecycle_state: "completed",
      worktree_path: "/repo/.northstar/runtime/worktrees/issue-44-keep-me",
    }),
    policy: { completedWorktrees: "keep", keepLast: 0, failedOrQuarantined: "keep" },
    metrics,
  });

  assert.equal(plan.action, "keep");
  assert.equal(metrics.completed_worktree_cleanup_attempts, 0);
  assert.equal(metrics.completed_worktrees_archived_or_deleted, 0);
  assert.equal(plan.history.event_type, "completed_worktree_cleanup_kept");
});

test("cleanup failure records retryable history without reversing completed lifecycle", async () => {
  const metrics = emptyCompletedWorktreeCleanupMetrics();
  const snapshot = newIssueSnapshot("issue-45", {
    lifecycle_state: "completed",
    worktree_path: "/repo/.northstar/runtime/worktrees/issue-45-fails",
  });

  const result = await runCompletedWorktreeCleanup({
    now,
    snapshot,
    plan: planCompletedWorktreeCleanup({
      now,
      projectRoot: "/repo",
      worktreesDir: ".northstar/runtime/worktrees",
      snapshot,
      policy: { completedWorktrees: "archive", keepLast: 0, failedOrQuarantined: "keep" },
    }),
    cleanup: {
      archiveManagedWorktree: async () => {
        throw new Error("device busy");
      },
      deleteManagedWorktree: async () => assert.fail("delete should not run"),
    },
    metrics,
  });

  assert.equal(result.snapshot.lifecycle_state, "completed");
  assert.equal(result.history.event_type, "completed_worktree_cleanup_failed_retryable");
  assert.equal(result.history.payload.retryable, true);
  assert.equal(metrics.completed_worktree_cleanup_attempts, 1);
  assert.equal(metrics.cleanup_failures_retryable, 1);
  assert.equal(metrics.cleanup_completed_reversals, 0);
});

test("cleanup plans only after confirmed completed lifecycle", () => {
  const metrics = emptyCompletedWorktreeCleanupMetrics();
  const plan = planCompletedWorktreeCleanup({
    now,
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    snapshot: newIssueSnapshot("issue-46", {
      lifecycle_state: "verified",
      worktree_path: "/repo/.northstar/runtime/worktrees/issue-46-not-done",
    }),
    policy: { completedWorktrees: "archive", keepLast: 0, failedOrQuarantined: "keep" },
    metrics,
  });

  assert.equal(plan.action, "skip");
  assert.equal(plan.reason, "lifecycle_not_completed");
  assert.equal(metrics.completed_worktree_cleanup_attempts, 0);
  assert.equal(metrics.completed_worktrees_archived_or_deleted, 0);
  assert.equal(metrics.cleanup_completed_reversals, 0);
});

test("delete cleanup increments archived or deleted metric and preserves completed state", async () => {
  const metrics = emptyCompletedWorktreeCleanupMetrics();
  const snapshot = newIssueSnapshot("issue-47", {
    lifecycle_state: "completed",
    worktree_path: "/repo/.northstar/runtime/worktrees/issue-47-delete",
  });
  let deletedPath = "";

  const result = await runCompletedWorktreeCleanup({
    now,
    snapshot,
    plan: planCompletedWorktreeCleanup({
      now,
      projectRoot: "/repo",
      worktreesDir: ".northstar/runtime/worktrees",
      snapshot,
      policy: { completedWorktrees: "delete", keepLast: 0, failedOrQuarantined: "keep" },
    }),
    cleanup: {
      archiveManagedWorktree: async () => assert.fail("archive should not run"),
      deleteManagedWorktree: async (input) => {
        deletedPath = input.worktreePath;
      },
    },
    metrics,
  });

  assert.equal(deletedPath, "/repo/.northstar/runtime/worktrees/issue-47-delete");
  assert.equal(result.snapshot.lifecycle_state, "completed");
  assert.equal(metrics.completed_worktree_cleanup_attempts, 1);
  assert.equal(metrics.completed_worktrees_archived_or_deleted, 1);
  assert.equal(metrics.cleanup_completed_reversals, 0);
});

test("failed lifecycle follows failedOrQuarantined keep policy with compact history", () => {
  const metrics = emptyCompletedWorktreeCleanupMetrics();
  const plan = planCompletedWorktreeCleanup({
    now,
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    snapshot: newIssueSnapshot("issue-48", {
      lifecycle_state: "failed",
      worktree_path: `${managedRoot}/issue-48-failed`,
    }),
    policy: { completedWorktrees: "archive", keepLast: 0, failedOrQuarantined: "keep" },
    metrics,
  });

  assert.equal(plan.action, "keep");
  assert.equal(plan.reason, "failed_or_quarantined_policy_keep");
  assert.deepEqual(plan.history.payload, {
    worktree_path: `${managedRoot}/issue-48-failed`,
    lifecycle_state: "failed",
    policy: "keep",
  });
  assert.equal(metrics.completed_worktree_cleanup_attempts, 0);
  assert.equal(metrics.cleanup_completed_reversals, 0);
});

test("quarantined lifecycle follows failedOrQuarantined archive policy and remains quarantined", async () => {
  const metrics = emptyCompletedWorktreeCleanupMetrics();
  const snapshot = newIssueSnapshot("issue-49", {
    lifecycle_state: "quarantined",
    worktree_path: `${managedRoot}/issue-49-quarantined`,
  });
  const plan = planCompletedWorktreeCleanup({
    now,
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    snapshot,
    policy: { completedWorktrees: "delete", keepLast: 0, failedOrQuarantined: "archive" },
    metrics,
  });

  assert.equal(plan.action, "archive");
  assert.equal(plan.worktreePath, `${managedRoot}/issue-49-quarantined`);
  assert.equal(
    plan.archivePath,
    "/repo/.northstar/runtime/archive/worktrees/issue-49-quarantined-2026-05-31T10-00-00-000Z",
  );

  let archivedFrom = "";
  let archivedTo = "";
  const result = await runCompletedWorktreeCleanup({
    now,
    snapshot,
    plan,
    cleanup: {
      archiveManagedWorktree: async (input) => {
        archivedFrom = input.worktreePath;
        archivedTo = input.archivePath;
      },
      deleteManagedWorktree: async () => assert.fail("delete should not run"),
    },
    metrics,
  });

  assert.equal(archivedFrom, `${managedRoot}/issue-49-quarantined`);
  assert.equal(archivedTo, "/repo/.northstar/runtime/archive/worktrees/issue-49-quarantined-2026-05-31T10-00-00-000Z");
  assert.equal(result.snapshot.lifecycle_state, "quarantined");
  assert.equal(metrics.completed_worktree_cleanup_attempts, 1);
  assert.equal(metrics.completed_worktrees_archived_or_deleted, 1);
  assert.equal(metrics.cleanup_completed_reversals, 0);
});
