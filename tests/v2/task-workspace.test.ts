import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitWorkspaceSnapshotProvider } from "../../src/v2/workspace/git-provider.ts";
import { mergeGitWorktree } from "../../src/v2/workspace/task-workspace.ts";

test("successful Git worktree task changes are committed and merged back to the base workspace", () => {
  const repo = mkdtempSync(join(tmpdir(), "southstar-task-workspace-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "southstar@example.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Southstar"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "before\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });

  const snapshot = createGitWorkspaceSnapshotProvider().snapshot({ repoRoot: repo, reason: "parallel task" });
  const fork = createGitWorkspaceSnapshotProvider().fork({ repoRoot: repo, snapshotRef: snapshot, worktreeName: "task-a" });
  writeFileSync(join(fork.worktreePath, "README.md"), "after\n");

  const result = mergeGitWorktree({ repoRoot: repo, worktreePath: fork.worktreePath, taskId: "task-a" });

  assert.equal(result.changed, true);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "after\n");
  execFileSync("git", ["worktree", "remove", "--force", fork.worktreePath], { cwd: repo });
  assert.match(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), /^$/);
});

test("Git worktree merge refuses to overwrite unrelated dirty base changes", () => {
  const repo = mkdtempSync(join(tmpdir(), "southstar-task-workspace-dirty-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "southstar@example.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Southstar"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "before\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
  const snapshot = createGitWorkspaceSnapshotProvider().snapshot({ repoRoot: repo, reason: "parallel task" });
  const fork = createGitWorkspaceSnapshotProvider().fork({ repoRoot: repo, snapshotRef: snapshot, worktreeName: "task-b" });
  writeFileSync(join(fork.worktreePath, "README.md"), "task\n");
  writeFileSync(join(repo, "local-edit.txt"), "do not overwrite\n");

  assert.throws(
    () => mergeGitWorktree({ repoRoot: repo, worktreePath: fork.worktreePath, taskId: "task-b" }),
    /dirty base workspace/,
  );
  execFileSync("git", ["worktree", "remove", "--force", fork.worktreePath], { cwd: repo });
});

test("Git worktree merge aborts a conflicting base merge instead of leaving the base repository dirty", () => {
  const repo = mkdtempSync(join(tmpdir(), "southstar-task-workspace-conflict-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "southstar@example.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Southstar"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
  const snapshot = createGitWorkspaceSnapshotProvider().snapshot({ repoRoot: repo, reason: "parallel task" });
  const fork = createGitWorkspaceSnapshotProvider().fork({ repoRoot: repo, snapshotRef: snapshot, worktreeName: "task-c" });
  writeFileSync(join(fork.worktreePath, "README.md"), "task change\n");
  writeFileSync(join(repo, "README.md"), "base change\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base change"], { cwd: repo });

  assert.throws(
    () => mergeGitWorktree({ repoRoot: repo, worktreePath: fork.worktreePath, taskId: "task-c" }),
    /git merge/,
  );
  assert.match(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }), /^$/);
  execFileSync("git", ["worktree", "remove", "--force", fork.worktreePath], { cwd: repo });
});
