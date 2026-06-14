import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { WorkspaceSnapshotProvider } from "./types.ts";

export function createGitWorkspaceSnapshotProvider(): WorkspaceSnapshotProvider {
  return {
    snapshot(input) {
      assertGitWorkspace(input.repoRoot);
      const commitSha = git(input.repoRoot, ["rev-parse", "HEAD"]);
      const trackedPatch = gitRaw(input.repoRoot, ["diff", "--binary", "HEAD"]);
      const untrackedFiles = gitRaw(input.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter((entry) => entry.length > 0)
        .filter(shouldSnapshotUntrackedFile);
      const dirtyPatchRef = trackedPatch.length > 0 || untrackedFiles.length > 0
        ? writeDirtyBundle(input.repoRoot, commitSha, trackedPatch, untrackedFiles)
        : undefined;
      return {
        provider: "git",
        repoRoot: input.repoRoot,
        commitSha,
        reason: input.reason,
        dirtyPatchRef,
      };
    },
    fork(input) {
      assertGitWorkspace(input.repoRoot);
      const parent = join(input.repoRoot, "..");
      const worktreePath = join(parent, `${basename(input.repoRoot)}-${safeWorktreeName(input.worktreeName)}`);
      git(input.repoRoot, ["worktree", "add", "--detach", worktreePath, input.snapshotRef.commitSha]);
      restoreDirtyBundle(worktreePath, input.snapshotRef.dirtyPatchRef);
      return {
        provider: "git",
        repoRoot: input.repoRoot,
        worktreePath,
        snapshotRef: input.snapshotRef,
      };
    },
    rollback(input) {
      assertGitWorkspace(input.repoRoot);
      git(input.repoRoot, ["reset", "--hard", input.snapshotRef.commitSha]);
      git(input.repoRoot, ["clean", "-fd"]);
      restoreDirtyBundle(input.repoRoot, input.snapshotRef.dirtyPatchRef);
      return {
        provider: "git",
        repoRoot: input.repoRoot,
        restoredCommitSha: input.snapshotRef.commitSha,
      };
    },
  };
}

function assertGitWorkspace(repoRoot: string): void {
  git(repoRoot, ["rev-parse", "--show-toplevel"]);
}

function writeDirtyBundle(repoRoot: string, commitSha: string, patch: string, untrackedFiles: string[]): string {
  const hash = createHash("sha256");
  hash.update(patch);
  for (const file of untrackedFiles) {
    hash.update(file);
    hash.update(readFileSync(join(repoRoot, file)));
  }
  const snapshotRoot = join(git(repoRoot, ["rev-parse", "--absolute-git-dir"]), "southstar-snapshots");
  const bundleDir = join(snapshotRoot, `${commitSha.slice(0, 12)}-${hash.digest("hex").slice(0, 16)}`);
  mkdirSync(bundleDir, { recursive: true });
  if (patch.length > 0) writeFileSync(join(bundleDir, "tracked.patch"), patch);
  for (const file of untrackedFiles) {
    const target = join(bundleDir, "untracked", file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repoRoot, file), target, { recursive: true });
  }
  return bundleDir;
}

function restoreDirtyBundle(repoRoot: string, dirtyPatchRef?: string): void {
  if (!dirtyPatchRef) return;
  const patchPath = join(dirtyPatchRef, "tracked.patch");
  if (existsSync(patchPath)) {
    git(repoRoot, ["apply", "--whitespace=nowarn", patchPath]);
  }
  const untrackedRoot = join(dirtyPatchRef, "untracked");
  if (existsSync(untrackedRoot)) {
    cpSync(untrackedRoot, repoRoot, { recursive: true });
  }
}

const GENERATED_UNTRACKED_SEGMENTS = new Set([
  ".cache",
  ".git",
  ".next",
  ".nuxt",
  ".pnpm",
  ".turbo",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

function shouldSnapshotUntrackedFile(file: string): boolean {
  return !file.split("/").some((segment) => GENERATED_UNTRACKED_SEGMENTS.has(segment));
}

function safeWorktreeName(name: string): string {
  const safe = basename(name).replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safe || safe === "." || safe === "..") throw new Error(`invalid worktree name: ${name}`);
  return safe;
}

function git(repoRoot: string, args: string[]): string {
  return gitRaw(repoRoot, args).trim();
}

function gitRaw(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
