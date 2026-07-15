import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { SouthstarDb } from "../db/postgres.ts";
import type { TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { WorkspaceMutationSpec } from "./types.ts";
import { createGitWorkspaceSnapshotProvider } from "./git-provider.ts";
import { assertWorkspaceMountAllowed } from "./workspace-mount-policy.ts";

const WORKSPACE_ALLOCATION_SCHEMA_VERSION = "southstar.workspace_allocation.v1";

export type PreparedTaskWorkspace = {
  resourceKey: string;
  workspace: NonNullable<TaskEnvelopeV2["workspace"]>;
  repoRoot: string;
  worktreePath: string;
};

export type TaskWorkspaceFinalization =
  | { status: "none" | "merged" | "discarded" | "abandoned" }
  | {
      status: "merge_conflict";
      resourceKey: string;
      repoRoot: string;
      worktreePath: string;
      errorMessage: string;
    };

/** Allocate a real Git worktree only for an explicit, supported isolation request. */
export async function prepareTaskWorkspacePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    mutation?: WorkspaceMutationSpec;
  },
): Promise<PreparedTaskWorkspace | null> {
  if (input.mutation?.isolation !== "git_worktree") return null;
  if (input.mutation.mode === "read_only") {
    throw new Error(`git_worktree isolation is only valid for a mutable task ${input.taskId}`);
  }

  const run = await db.maybeOne<{ runtime_context_json: unknown }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [input.runId],
  );
  const projectRoot = stringValue(asRecord(run?.runtime_context_json).projectRoot)
    ?? stringValue(asRecord(run?.runtime_context_json).cwd);
  if (!projectRoot) throw new Error(`git_worktree isolation requires a workspace cwd for task ${input.taskId}`);
  assertWorkspaceMountAllowed(projectRoot);

  const provider = createGitWorkspaceSnapshotProvider();
  const snapshot = provider.snapshot({ repoRoot: projectRoot, reason: `parallel task ${input.taskId}` });
  if (snapshot.dirtyPatchRef) {
    throw new Error(`git_worktree isolation requires a clean workspace before task ${input.taskId}`);
  }
  const resourceKey = `workspace_allocation:${input.runId}:${input.taskId}:${input.attemptId}`;
  const fork = provider.fork({
    repoRoot: snapshot.repoRoot,
    snapshotRef: snapshot,
    worktreeName: `${input.runId}-${input.taskId}-${input.attemptId}`,
  });
  try {
    assertWorkspaceMountAllowed(fork.worktreePath);
    await upsertRuntimeResourcePg(db, {
      id: resourceKey,
      resourceType: "workspace_allocation",
      resourceKey,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: "workspace",
      status: "allocated",
      title: `Git worktree for ${input.taskId}`,
      payload: {
        schemaVersion: WORKSPACE_ALLOCATION_SCHEMA_VERSION,
        provider: "git_worktree",
        repoRoot: snapshot.repoRoot,
        worktreePath: fork.worktreePath,
        baseSnapshot: snapshot,
        mutation: input.mutation,
        allocatedAt: new Date().toISOString(),
      },
      summary: { provider: "git_worktree", repoRoot: snapshot.repoRoot, worktreePath: fork.worktreePath },
    });
  } catch (error) {
    removeGitWorktree(snapshot.repoRoot, fork.worktreePath);
    throw error;
  }

  return {
    resourceKey,
    repoRoot: snapshot.repoRoot,
    worktreePath: fork.worktreePath,
    workspace: {
      handle: {
        repoRoot: "/workspace/repo",
        worktreePath: "/workspace/repo",
        hostMountPath: fork.worktreePath,
      },
      baseSnapshotRef: {
        provider: "git",
        repoRoot: "/workspace/repo",
        commitSha: snapshot.commitSha,
        ref: resourceKey,
      },
    },
  };
}

/** Merge a successful isolated task back to its base branch; preserve conflicts for operator resolution. */
export async function finalizeTaskWorkspacePg(
  db: SouthstarDb,
  input: { runId: string; taskId: string; accepted: boolean },
): Promise<TaskWorkspaceFinalization> {
  const resource = await latestWorkspaceAllocation(db, input);
  if (!resource) return { status: "none" };
  const payload = asRecord(resource.payload);
  const repoRoot = stringValue(payload.repoRoot);
  const worktreePath = stringValue(payload.worktreePath);
  if (!repoRoot || !worktreePath) throw new Error(`workspace allocation is missing Git paths for ${input.taskId}`);
  if (["merged", "discarded", "abandoned"].includes(resource.status)) return { status: resource.status as "merged" | "discarded" | "abandoned" };
  if (resource.status === "merge_conflict") {
    return {
      status: "merge_conflict",
      resourceKey: resource.resourceKey,
      repoRoot,
      worktreePath,
      errorMessage: stringValue(payload.mergeError) ?? "workspace merge conflict requires operator resolution",
    };
  }

  if (!input.accepted) {
    removeGitWorktree(repoRoot, worktreePath);
    await updateAllocationStatus(db, resource.resourceKey, "discarded", { discardedAt: new Date().toISOString() });
    return { status: "discarded" };
  }

  const retryLimit = await workspaceMergeRetryLimitPg(db, input.runId);
  const previousAttempts = numberValue(payload.mergeAttempts) ?? 0;
  let merge: ReturnType<typeof mergeGitWorktree> | undefined;
  let lastMergeError: string | undefined;
  for (let attempt = previousAttempts; attempt <= retryLimit; attempt += 1) {
    try {
      merge = mergeGitWorktree({ repoRoot, worktreePath, taskId: input.taskId });
      break;
    } catch (error) {
      lastMergeError = error instanceof Error ? error.message : String(error);
      if (attempt >= retryLimit) break;
    }
  }
  if (!merge) {
    const mergeAttempts = Math.max(previousAttempts, retryLimit + 1);
    await updateAllocationStatus(db, resource.resourceKey, "merge_conflict", {
      mergeConflictAt: new Date().toISOString(),
      mergeError: lastMergeError ?? "workspace merge failed",
      mergeAttempts,
      mergeRetryLimit: retryLimit,
      operatorAction: "resolve_workspace_merge",
      worktreePreserved: true,
    });
    return {
      status: "merge_conflict",
      resourceKey: resource.resourceKey,
      repoRoot,
      worktreePath,
      errorMessage: lastMergeError ?? "workspace merge failed",
    };
  }
  removeGitWorktree(repoRoot, worktreePath);
  await updateAllocationStatus(db, resource.resourceKey, "merged", {
    mergedAt: new Date().toISOString(),
    mergeCommitSha: merge.commitSha,
    changed: merge.changed,
  });
  return { status: "merged" };
}

/** Best-effort cleanup when preparation fails before the hand is accepted. */
export async function abandonTaskWorkspacePg(db: SouthstarDb, allocation: PreparedTaskWorkspace | null): Promise<void> {
  if (!allocation) return;
  removeGitWorktree(allocation.repoRoot, allocation.worktreePath);
  await updateAllocationStatus(db, allocation.resourceKey, "abandoned", { abandonedAt: new Date().toISOString() });
}

export function mergeGitWorktree(input: { repoRoot: string; worktreePath: string; taskId: string }): { commitSha?: string; changed: boolean } {
  const baseStatus = git(input.repoRoot, ["status", "--porcelain"]);
  if (baseStatus.length > 0) throw new Error(`cannot merge task worktree into dirty base workspace: ${input.repoRoot}`);

  const worktreeStatus = git(input.worktreePath, ["status", "--porcelain"]);
  let commitSha = git(input.worktreePath, ["rev-parse", "HEAD"]);
  const hadUncommittedChanges = worktreeStatus.length > 0;
  if (hadUncommittedChanges) {
    git(input.worktreePath, ["add", "--all"]);
    execFileSync("git", ["-c", "user.name=Southstar", "-c", "user.email=southstar@local", "commit", "-m", `Southstar task ${input.taskId}`], {
      cwd: input.worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    commitSha = git(input.worktreePath, ["rev-parse", "HEAD"]);
  }

  const alreadyMerged = execFileResult(input.repoRoot, ["merge-base", "--is-ancestor", commitSha, "HEAD"]) === 0;
  const requiresMerge = !alreadyMerged;
  if (requiresMerge) {
    try {
      execFileSync("git", ["merge", "--no-ff", "--no-edit", commitSha], {
        cwd: input.repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      execFileResult(input.repoRoot, ["merge", "--abort"]);
      throw error;
    }
  }
  return { changed: hadUncommittedChanges || requiresMerge, ...(requiresMerge ? { commitSha } : {}) };
}

async function workspaceMergeRetryLimitPg(db: SouthstarDb, runId: string): Promise<number> {
  const row = await db.maybeOne<{ runtime_context_json: unknown }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  // A run-specific policy wins; the environment value is the operator-level default.
  const configured = asRecord(row?.runtime_context_json).workspaceMergeRetryLimit ?? process.env.SOUTHSTAR_WORKSPACE_MERGE_RETRY_LIMIT;
  const value = typeof configured === "number" ? configured : Number(configured);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

async function latestWorkspaceAllocation(db: SouthstarDb, input: { runId: string; taskId: string }) {
  const row = await db.maybeOne<{ resource_key: string }>(
    `select resource_key
       from southstar.runtime_resources
      where resource_type = 'workspace_allocation'
        and run_id = $1
        and task_id = $2
      order by created_at desc
      limit 1`,
    [input.runId, input.taskId],
  );
  return row ? await getResourceByKeyPg(db, "workspace_allocation", row.resource_key) : null;
}

async function updateAllocationStatus(db: SouthstarDb, resourceKey: string, status: string, patch: Record<string, unknown>): Promise<void> {
  await db.query(
    `update southstar.runtime_resources
        set status = $2,
            payload_json = payload_json || $3::jsonb,
            updated_at = now()
      where resource_type = 'workspace_allocation' and resource_key = $1`,
    [resourceKey, status, JSON.stringify(patch)],
  );
}

function removeGitWorktree(repoRoot: string, worktreePath: string): void {
  if (!existsSync(worktreePath)) return;
  execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function execFileResult(cwd: string, args: string[]): number {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return 0;
  } catch {
    return 1;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
