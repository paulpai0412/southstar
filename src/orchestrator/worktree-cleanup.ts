import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { HistoryEntry, IssueSnapshot } from "../types/control-plane.ts";

export interface CompletedWorktreeCleanupPolicy {
  completedWorktrees: "archive" | "delete" | "keep";
  keepLast: number;
  failedOrQuarantined: "keep" | "archive";
}

export interface CompletedWorktreeCleanupMetrics {
  completed_worktree_cleanup_attempts: number;
  completed_worktrees_archived_or_deleted: number;
  cleanup_failures_retryable: number;
  cleanup_completed_reversals: number;
}

export type CompletedWorktreeCleanupPlan =
  | {
      action: "archive";
      worktreePath: string;
      archivePath: string;
      history: HistoryEntry;
    }
  | {
      action: "delete";
      worktreePath: string;
      history: HistoryEntry;
    }
  | {
      action: "keep" | "skip";
      reason: string;
      history: HistoryEntry;
    };

export interface ManagedWorktreeCleanup {
  archiveManagedWorktree(input: { worktreePath: string; archivePath: string }): Promise<unknown>;
  deleteManagedWorktree(input: { worktreePath: string }): Promise<unknown>;
}

interface PathImplementation {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

const defaultPath: PathImplementation = { resolve, relative, isAbsolute, sep };

export function emptyCompletedWorktreeCleanupMetrics(): CompletedWorktreeCleanupMetrics {
  return {
    completed_worktree_cleanup_attempts: 0,
    completed_worktrees_archived_or_deleted: 0,
    cleanup_failures_retryable: 0,
    cleanup_completed_reversals: 0,
  };
}

export function planCompletedWorktreeCleanup(input: {
  now: string;
  projectRoot: string;
  worktreesDir: string;
  snapshot: IssueSnapshot;
  policy: CompletedWorktreeCleanupPolicy;
  completedWorktreeAgeRank?: number;
  metrics?: CompletedWorktreeCleanupMetrics;
}): CompletedWorktreeCleanupPlan {
  const cleanupLifecycle = input.snapshot.lifecycle_state;
  if (!isCleanupLifecycle(cleanupLifecycle)) {
    return skipPlan(input.now, "lifecycle_not_completed");
  }

  const worktreePath = input.snapshot.worktree_path;
  if (!worktreePath) {
    return skipPlan(input.now, "missing_worktree_path");
  }

  if (worktreePath.startsWith("agent-owned://")) {
    return skipPlan(input.now, "agent_owned_worktree");
  }

  if (!isManagedWorktreePath(resolve(input.projectRoot, input.worktreesDir), worktreePath)) {
    input.metrics && (input.metrics.cleanup_failures_retryable += 1);
    return failedRetryablePlan(input.now, worktreePath, "unmanaged_worktree_path");
  }

  const policy = cleanupLifecycle === "completed"
    ? input.policy.completedWorktrees
    : input.policy.failedOrQuarantined;

  if (policy === "keep") {
    return {
      action: "keep",
      reason: cleanupLifecycle === "completed" ? "policy_keep" : "failed_or_quarantined_policy_keep",
      history: history(input.now, "completed_worktree_cleanup_kept", {
        worktree_path: worktreePath,
        lifecycle_state: cleanupLifecycle,
        policy,
      }),
    };
  }

  if (
    cleanupLifecycle === "completed"
    && typeof input.completedWorktreeAgeRank === "number"
    && input.completedWorktreeAgeRank < input.policy.keepLast
  ) {
    return {
      action: "keep",
      reason: "within_keep_last",
      history: history(input.now, "completed_worktree_cleanup_kept", {
        worktree_path: worktreePath,
        lifecycle_state: cleanupLifecycle,
        policy,
        keep_last: input.policy.keepLast,
      }),
    };
  }

  if (policy === "delete") {
    return {
      action: "delete",
      worktreePath,
      history: history(input.now, "completed_worktree_cleanup_planned", {
        action: "delete",
        worktree_path: worktreePath,
        lifecycle_state: cleanupLifecycle,
      }),
    };
  }

  const issueSlug = basename(worktreePath);
  return {
    action: "archive",
    worktreePath,
    archivePath: resolve(
      input.projectRoot,
      ".northstar/runtime/archive/worktrees",
      `${issueSlug}-${archiveTimestamp(input.now)}`,
    ),
    history: history(input.now, "completed_worktree_cleanup_planned", {
      action: "archive",
      worktree_path: worktreePath,
      lifecycle_state: cleanupLifecycle,
    }),
  };
}

export async function runCompletedWorktreeCleanup(input: {
  now: string;
  snapshot: IssueSnapshot;
  plan: CompletedWorktreeCleanupPlan;
  cleanup: ManagedWorktreeCleanup;
  metrics?: CompletedWorktreeCleanupMetrics;
}): Promise<{ snapshot: IssueSnapshot; history: HistoryEntry }> {
  const snapshot = cloneSnapshot(input.snapshot);
  if (!isCleanupLifecycle(snapshot.lifecycle_state)) {
    const skipped = skipPlan(input.now, "lifecycle_not_completed").history;
    return { snapshot: recordCleanupResult(snapshot, skipped), history: skipped };
  }

  if (input.plan.action !== "archive" && input.plan.action !== "delete") {
    return { snapshot: recordCleanupResult(snapshot, input.plan.history), history: input.plan.history };
  }

  input.metrics && (input.metrics.completed_worktree_cleanup_attempts += 1);
  try {
    if (input.plan.action === "archive") {
      await input.cleanup.archiveManagedWorktree({
        worktreePath: input.plan.worktreePath,
        archivePath: input.plan.archivePath,
      });
    } else {
      await input.cleanup.deleteManagedWorktree({ worktreePath: input.plan.worktreePath });
    }
    input.metrics && (input.metrics.completed_worktrees_archived_or_deleted += 1);
    const succeeded = history(input.now, "completed_worktree_cleanup_succeeded", {
        action: input.plan.action,
        worktree_path: input.plan.worktreePath,
        archive_path: input.plan.action === "archive" ? input.plan.archivePath : undefined,
      });
    return { snapshot: recordCleanupResult(snapshot, succeeded), history: succeeded };
  } catch (error) {
    input.metrics && (input.metrics.cleanup_failures_retryable += 1);
    const failed = failedRetryablePlan(input.now, input.plan.worktreePath, errorMessage(error)).history;
    return { snapshot: recordCleanupResult(snapshot, failed), history: failed };
  }
}

function skipPlan(now: string, reason: string): CompletedWorktreeCleanupPlan {
  return {
    action: "skip",
    reason,
    history: history(now, "completed_worktree_cleanup_skipped", { reason }),
  };
}

function failedRetryablePlan(now: string, worktreePath: string, reason: string): CompletedWorktreeCleanupPlan {
  return {
    action: "skip",
    reason,
    history: history(now, "completed_worktree_cleanup_failed_retryable", {
      worktree_path: worktreePath,
      reason,
      retryable: true,
    }),
  };
}

function history(now: string, eventType: string, payload: Record<string, unknown>): HistoryEntry {
  return {
    event_type: eventType,
    payload: Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)),
    created_at: now,
  };
}

export function isManagedWorktreePath(root: string, path: string, pathImpl: PathImplementation = defaultPath): boolean {
  const resolvedRoot = pathImpl.resolve(root);
  const resolvedPath = pathImpl.resolve(path);
  const relativePath = pathImpl.relative(resolvedRoot, resolvedPath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${pathImpl.sep}`)
    && !pathImpl.isAbsolute(relativePath);
}

function isCleanupLifecycle(value: IssueSnapshot["lifecycle_state"]): boolean {
  return value === "completed" || value === "cancelled" || value === "failed" || value === "quarantined";
}

function archiveTimestamp(now: string): string {
  return now.replace(/[:.]/g, "-");
}

function cloneSnapshot(snapshot: IssueSnapshot): IssueSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as IssueSnapshot;
}

function recordCleanupResult(snapshot: IssueSnapshot, entry: HistoryEntry): IssueSnapshot {
  const statusByEvent: Record<string, string> = {
    completed_worktree_cleanup_succeeded: "succeeded",
    completed_worktree_cleanup_failed_retryable: "failed_retryable",
    completed_worktree_cleanup_kept: "kept",
    completed_worktree_cleanup_skipped: "skipped",
  };
  snapshot.runtime_context_json.cleanup = {
    status: statusByEvent[entry.event_type] ?? entry.event_type,
    ...entry.payload,
    at: entry.created_at,
  };
  return snapshot;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
