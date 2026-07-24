import type { WorkspaceMutationSpec } from "./types.ts";

export type WorkspaceTaskConcurrencyState = {
  id: string;
  status: string;
  workspaceMutation?: WorkspaceMutationSpec;
};

export type WorkspaceClaimStrategy = "parallel_read" | "parallel_append" | "parallel_isolated" | "serialized_write" | "missing_contract";

export type WorkspaceClaimDecision = {
  allowed: boolean;
  strategy: WorkspaceClaimStrategy;
  reason?: string;
};

const ACTIVE_STATUSES = new Set(["claimed", "queued", "running"]);

/**
 * Decide whether a pending task may claim a slot while other tasks are active.
 * Explicit shared writes are serialized, append-only writes are parallel only
 * when their namespaces are disjoint. Missing mutation metadata blocks the
 * claim so persisted legacy manifests cannot silently run under an unknown
 * concurrency policy.
 */
export function decideWorkspaceClaim(
  candidate: WorkspaceTaskConcurrencyState,
  activeTasks: WorkspaceTaskConcurrencyState[],
): WorkspaceClaimDecision {
  const candidateMutation = candidate.workspaceMutation;
  if (!candidateMutation) {
    return {
      allowed: false,
      strategy: "missing_contract",
      reason: `task ${candidate.id} is missing workspaceMutation metadata`,
    };
  }

  const active = activeTasks.filter((task) => task.id !== candidate.id && ACTIVE_STATUSES.has(task.status));
  const activeMissingContract = active.find((task) => !task.workspaceMutation);
  if (activeMissingContract) {
    return {
      allowed: false,
      strategy: "missing_contract",
      reason: `active task ${activeMissingContract.id} is missing workspaceMutation metadata`,
    };
  }
  const activeWithMutation = active.filter((task): task is WorkspaceTaskConcurrencyState & { workspaceMutation: WorkspaceMutationSpec } => Boolean(task.workspaceMutation));
  if (candidateMutation.mode === "read_only") {
    const conflictingWriter = activeWithMutation.find((task) => {
      const mutation = task.workspaceMutation;
      return mutation.mode !== "read_only"
        && mutation.isolation !== "git_worktree"
        && resourcesOverlap(candidateMutation, mutation);
    });
    if (conflictingWriter) {
      return {
        allowed: false,
        strategy: "serialized_write",
        reason: `read task ${candidate.id} overlaps active writer ${conflictingWriter.id}`,
      };
    }
    return { allowed: true, strategy: "parallel_read" };
  }

  const conflictingTask = activeWithMutation.find((task) => {
    const mutation = task.workspaceMutation;
    return mutation.mode !== "read_only" && resourcesOverlap(candidateMutation, mutation);
  });
  if (conflictingTask) {
    return {
      allowed: false,
      strategy: "serialized_write",
      reason: `write task ${candidate.id} overlaps active writer ${conflictingTask.id} on ${overlapDescription(candidateMutation, conflictingTask.workspaceMutation!)}`,
    };
  }

  return {
    allowed: true,
    strategy: candidateMutation.mode === "append_only"
      ? "parallel_append"
      : candidateMutation.isolation === "git_worktree"
        ? "parallel_isolated"
        : "serialized_write",
  };
}

function resourcesOverlap(left: WorkspaceMutationSpec, right: WorkspaceMutationSpec): boolean {
  const leftKeys = normalizeResourceKeys(left.resourceKeys);
  const rightKeys = normalizeResourceKeys(right.resourceKeys);
  if (leftKeys.length === 0 || rightKeys.length === 0) return true;
  const rightSet = new Set(rightKeys);
  return leftKeys.some((key) => rightSet.has(key));
}

function normalizeResourceKeys(keys: string[] | undefined): string[] {
  return [...new Set((keys ?? []).filter((key) => typeof key === "string" && key.trim().length > 0).map((key) => key.trim()))];
}

function overlapDescription(left: WorkspaceMutationSpec, right: WorkspaceMutationSpec): string {
  const leftKeys = normalizeResourceKeys(left.resourceKeys);
  const rightKeys = new Set(normalizeResourceKeys(right.resourceKeys));
  if (leftKeys.length === 0 || rightKeys.size === 0) return "workspace";
  return leftKeys.filter((key) => rightKeys.has(key)).join(", ");
}
