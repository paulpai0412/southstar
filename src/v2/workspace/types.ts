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
