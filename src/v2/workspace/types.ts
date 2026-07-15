export type WorkspaceSnapshotRef = {
  provider: "git";
  repoRoot: string;
  commitSha: string;
  dirtyPatchRef?: string;
  reason: string;
};

export type WorkspaceForkRef = {
  provider: "git";
  repoRoot: string;
  worktreePath: string;
  snapshotRef: WorkspaceSnapshotRef;
};

export type WorkspaceRollbackResult = {
  provider: "git";
  repoRoot: string;
  restoredCommitSha: string;
};

export type WorkspaceSnapshotProvider = {
  snapshot(input: { repoRoot: string; reason: string }): WorkspaceSnapshotRef;
  fork(input: { repoRoot: string; snapshotRef: WorkspaceSnapshotRef; worktreeName: string }): WorkspaceForkRef;
  rollback(input: { repoRoot: string; snapshotRef: WorkspaceSnapshotRef }): WorkspaceRollbackResult;
};

/** How a task uses a shared workspace or another mutable resource. */
export type WorkspaceMutationMode = "read_only" | "shared_write" | "append_only";

export type WorkspaceMutationSpec = {
  mode: WorkspaceMutationMode;
  /** Runtime isolation requested for a mutable task. git_worktree is the first executable provider. */
  isolation?: "shared" | "git_worktree";
  /** Logical resources touched by the task; omitted means the whole workspace. */
  resourceKeys?: string[];
};
