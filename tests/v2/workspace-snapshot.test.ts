import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitWorkspaceSnapshotProvider } from "../../src/v2/workspace/git-provider.ts";

test("snapshots, forks and rolls back a real Git workspace", () => {
  const repo = mkdtempSync(join(tmpdir(), "southstar-workspace-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "southstar@example.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Southstar"], { cwd: repo });
  writeFileSync(join(repo, "file.txt"), "one\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });

  const provider = createGitWorkspaceSnapshotProvider();
  const start = provider.snapshot({ repoRoot: repo, reason: "task start" });
  writeFileSync(join(repo, "file.txt"), "two\n");
  writeFileSync(join(repo, "notes.txt"), "untracked note\n");
  const dirty = provider.snapshot({ repoRoot: repo, reason: "dirty attempt" });
  const fork = provider.fork({ repoRoot: repo, snapshotRef: dirty, worktreeName: "retry-a" });
  const rolledBack = provider.rollback({ repoRoot: repo, snapshotRef: dirty });

  assert.equal(start.provider, "git");
  assert.match(start.commitSha, /^[0-9a-f]{40}$/);
  assert.equal(typeof dirty.dirtyPatchRef, "string");
  assert.match(fork.worktreePath, /retry-a/);
  assert.equal(readFileSync(join(fork.worktreePath, "file.txt"), "utf8"), "two\n");
  assert.equal(readFileSync(join(fork.worktreePath, "notes.txt"), "utf8"), "untracked note\n");
  assert.equal(rolledBack.repoRoot, repo);
  assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "two\n");
  assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "untracked note\n");
  assert.match(execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }), /file\.txt/);
  assert.match(execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }), /notes\.txt/);
});
