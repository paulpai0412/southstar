import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { redactSecrets } from "../../runtime/redaction.ts";
import { commandSpec } from "../platform/process.ts";
import type { GitCommand, GitCommandRunner } from "./executor.ts";
import { GitOperationError } from "./executor.ts";

interface PathImplementation {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

const defaultPath: PathImplementation = { resolve, relative, isAbsolute, sep };

export class SoftwareDevWorktreeOperator {
  private readonly options: {
    projectRoot: string;
    worktreesDir: string;
    syncWorktreeDir: string;
    baseBranch: string;
    runCommand: GitCommandRunner;
    pathExists: (path: string) => Promise<boolean>;
    ensureDirectory: (path: string) => Promise<void>;
  };

  constructor(options: {
    projectRoot: string;
    worktreesDir: string;
    syncWorktreeDir?: string;
    baseBranch: string;
    runCommand: GitCommandRunner;
    pathExists?: (path: string) => Promise<boolean>;
    ensureDirectory?: (path: string) => Promise<void>;
  }) {
    this.options = {
      ...options,
      syncWorktreeDir: options.syncWorktreeDir ?? ".northstar/runtime/sync-worktrees/main",
      pathExists: options.pathExists ?? defaultPathExists,
      ensureDirectory: options.ensureDirectory ?? defaultEnsureDirectory,
    };
  }

  async prepareIssueWorktree(input: { issueNumber: number; slug: string }): Promise<{ path: string; branch: string; reused: boolean; baseCommit: string }> {
    const safeSlug = sanitizeSlug(input.slug);
    const branch = `northstar/issue-${input.issueNumber}-${safeSlug}`;
    const path = resolve(this.options.projectRoot, this.options.worktreesDir, `issue-${input.issueNumber}-${safeSlug}`);
    const base = await this.syncBaseBranch();
    const attachedPath = await this.worktreePathForBranch(branch);
    if (attachedPath) {
      return { path: attachedPath, branch, reused: true, baseCommit: base.commitSha };
    }

    const branchExists = await this.branchExists(branch);
    const command = branchExists
      ? gitCommand(["-C", this.options.projectRoot, "worktree", "add", path, branch])
      : gitCommand(["-C", this.options.projectRoot, "worktree", "add", "-b", branch, path, base.commitSha]);
    const result = await this.options.runCommand(command);
    if (result.exitCode !== 0) {
      const recoveredPath = await this.worktreePathForBranch(branch);
      if (recoveredPath) {
        return { path: recoveredPath, branch, reused: true, baseCommit: base.commitSha };
      }
      throw new GitOperationError("WORKTREE_CREATE_FAILED", redactSecrets(result.stderr || result.stdout));
    }
    return { path, branch, reused: branchExists, baseCommit: base.commitSha };
  }

  async syncBaseBranch(): Promise<{ path: string; commitSha: string }> {
    const syncWorktreePath = resolve(this.options.projectRoot, this.options.syncWorktreeDir);
    const exists = await this.options.pathExists(syncWorktreePath);
    if (exists) {
      await this.assertCleanSyncWorktree(syncWorktreePath);
      await this.fetchSyncWorktree(syncWorktreePath);
      await this.fastForwardSyncWorktree(syncWorktreePath);
    } else {
      await this.createSyncWorktree(syncWorktreePath);
    }
    return { path: syncWorktreePath, commitSha: await this.readCommit(syncWorktreePath, "HEAD") };
  }

  async recoverSyncBaseBranch(input: { blockedErrorCode?: string } = {}): Promise<{ path: string; commitSha: string }> {
    const syncWorktreePath = resolve(this.options.projectRoot, this.options.syncWorktreeDir);
    const exists = await this.options.pathExists(syncWorktreePath);
    if (!exists) {
      await this.createSyncWorktree(syncWorktreePath);
      return { path: syncWorktreePath, commitSha: await this.readCommit(syncWorktreePath, "HEAD") };
    }

    if (input.blockedErrorCode === "SYNC_WORKTREE_DIRTY") {
      await this.resetDirtySyncWorktree(syncWorktreePath);
    }

    await this.assertCleanSyncWorktree(syncWorktreePath);
    await this.fetchSyncWorktree(syncWorktreePath);
    await this.fastForwardSyncWorktree(syncWorktreePath);
    return { path: syncWorktreePath, commitSha: await this.readCommit(syncWorktreePath, "HEAD") };
  }

  async commitAndPush(input: { worktreePath: string; branch: string; message: string }): Promise<{ pushed: true; commit_sha: string; reused?: true }> {
    const status = await this.options.runCommand(gitCommand(["-C", input.worktreePath, "status", "--porcelain"]));
    if (status.exitCode !== 0) {
      throw new GitOperationError("WORKTREE_STATUS_FAILED", redactSecrets(status.stderr));
    }
    if (status.stdout.trim().length === 0) {
      const head = await this.readCommit(input.worktreePath, "HEAD");
      const base = await this.readCommit(input.worktreePath, this.options.baseBranch);
      if (head === base) {
        throw new GitOperationError("WORKTREE_NO_CHANGES", "WORKTREE_NO_CHANGES");
      }
      const push = await this.options.runCommand(gitCommand(["-C", input.worktreePath, "push", "origin", input.branch]));
      if (push.exitCode !== 0) {
        if (isNonFastForwardPushRejection(push.stderr)) {
          return await this.reuseRemoteBranch(input.worktreePath, input.branch);
        }
        throw new GitOperationError("WORKTREE_GIT_FAILED", redactSecrets(push.stderr));
      }
      return { pushed: true, commit_sha: head, reused: true };
    }

    for (const command of [
      gitCommand(["-C", input.worktreePath, "add", "-A"]),
      gitCommand(["-C", input.worktreePath, "commit", "-m", input.message]),
      gitCommand(["-C", input.worktreePath, "push", "origin", input.branch]),
    ]) {
      const result = await this.options.runCommand(command);
      if (result.exitCode !== 0) {
        if (command.args.includes("push") && isNonFastForwardPushRejection(result.stderr)) {
          return await this.reuseRemoteBranch(input.worktreePath, input.branch);
        }
        throw new GitOperationError("WORKTREE_GIT_FAILED", redactSecrets(result.stderr));
      }
    }

    return { pushed: true, commit_sha: await this.readCommit(input.worktreePath, "HEAD") };
  }

  async archiveManagedWorktree(input: { worktreePath: string; archivePath: string }): Promise<{ archived: true; archivePath: string }> {
    this.assertManagedWorktreePath(input.worktreePath);
    this.assertArchivePath(input.archivePath);
    try {
      await mkdir(resolve(this.options.projectRoot, ".northstar/runtime/archive/worktrees"), { recursive: true });
      await rename(input.worktreePath, input.archivePath);
      return { archived: true, archivePath: input.archivePath };
    } catch (error) {
      throw new GitOperationError("WORKTREE_ARCHIVE_FAILED", redactSecrets(errorMessage(error)), { retryable: true });
    }
  }

  async deleteManagedWorktree(input: { worktreePath: string }): Promise<{ deleted: true }> {
    this.assertManagedWorktreePath(input.worktreePath);
    try {
      await rm(input.worktreePath, { recursive: true });
      return { deleted: true };
    } catch (error) {
      throw new GitOperationError("WORKTREE_DELETE_FAILED", redactSecrets(errorMessage(error)), { retryable: true });
    }
  }

  private async readCommit(worktreePath: string, ref: string): Promise<string> {
    const result = await this.options.runCommand(gitCommand(["-C", worktreePath, "rev-parse", ref]));
    if (result.exitCode !== 0) {
      throw new GitOperationError("WORKTREE_GIT_FAILED", redactSecrets(result.stderr));
    }
    return result.stdout.trim();
  }

  private async branchExists(branch: string): Promise<boolean> {
    const result = await this.options.runCommand(gitCommand([
      "-C",
      this.options.projectRoot,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]));
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitOperationError("WORKTREE_GIT_FAILED", redactSecrets(result.stderr || result.stdout));
  }

  private async worktreePathForBranch(branch: string): Promise<string | undefined> {
    const result = await this.options.runCommand(gitCommand(["-C", this.options.projectRoot, "worktree", "list", "--porcelain"]));
    if (result.exitCode !== 0) {
      throw new GitOperationError("WORKTREE_GIT_FAILED", redactSecrets(result.stderr || result.stdout));
    }
    const wantedRef = `refs/heads/${branch}`;
    const lines = result.stdout.split(/\r?\n/);
    let currentPath: string | undefined;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0) {
        currentPath = undefined;
        continue;
      }
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length).trim();
        continue;
      }
      if (line.startsWith("branch ") && currentPath) {
        const ref = line.slice("branch ".length).trim();
        if (ref === wantedRef) return currentPath;
      }
    }
    return undefined;
  }

  private async assertCleanSyncWorktree(syncWorktreePath: string): Promise<void> {
    const status = await this.options.runCommand(gitCommand(["-C", syncWorktreePath, "status", "--porcelain"]));
    if (status.exitCode !== 0) {
      throw new GitOperationError("SYNC_WORKTREE_STATUS_FAILED", redactSecrets(status.stderr), { retryable: true });
    }
    if (status.stdout.trim().length > 0) {
      throw new GitOperationError("SYNC_WORKTREE_DIRTY", "Sync worktree has uncommitted changes; refusing to dispatch issue worktree", { retryable: true });
    }
  }

  private async fetchSyncWorktree(syncWorktreePath: string): Promise<void> {
    const fetch = await this.options.runCommand(gitCommand(["-C", syncWorktreePath, "fetch", "origin", this.options.baseBranch]));
    if (fetch.exitCode !== 0) {
      throw new GitOperationError("SYNC_WORKTREE_FETCH_FAILED", redactSecrets(fetch.stderr), { retryable: true });
    }
  }

  private async fastForwardSyncWorktree(syncWorktreePath: string): Promise<void> {
    const merge = await this.options.runCommand(gitCommand(["-C", syncWorktreePath, "merge", "--ff-only", `origin/${this.options.baseBranch}`]));
    if (merge.exitCode !== 0) {
      throw new GitOperationError("SYNC_WORKTREE_FAST_FORWARD_FAILED", redactSecrets(merge.stderr), { retryable: true });
    }
  }

  private async createSyncWorktree(syncWorktreePath: string): Promise<void> {
    await this.options.ensureDirectory(dirname(syncWorktreePath));
    const fetch = await this.options.runCommand(gitCommand(["-C", this.options.projectRoot, "fetch", "origin", this.options.baseBranch]));
    if (fetch.exitCode !== 0) {
      throw new GitOperationError("SYNC_WORKTREE_FETCH_FAILED", redactSecrets(fetch.stderr), { retryable: true });
    }
    const add = await this.options.runCommand(gitCommand(["-C", this.options.projectRoot, "worktree", "add", "--detach", syncWorktreePath, `origin/${this.options.baseBranch}`]));
    if (add.exitCode !== 0) {
      throw new GitOperationError("SYNC_WORKTREE_CREATE_FAILED", redactSecrets(add.stderr), { retryable: true });
    }
  }

  private async resetDirtySyncWorktree(syncWorktreePath: string): Promise<void> {
    const reset = await this.options.runCommand(gitCommand(["-C", syncWorktreePath, "reset", "--hard", "HEAD"]));
    if (reset.exitCode !== 0) {
      throw new GitOperationError("SYNC_WORKTREE_RECOVERY_FAILED", redactSecrets(reset.stderr), { retryable: true });
    }
    const clean = await this.options.runCommand(gitCommand(["-C", syncWorktreePath, "clean", "-fd"]));
    if (clean.exitCode !== 0) {
      throw new GitOperationError("SYNC_WORKTREE_RECOVERY_FAILED", redactSecrets(clean.stderr), { retryable: true });
    }
  }

  private async reuseRemoteBranch(worktreePath: string, branch: string): Promise<{ pushed: true; commit_sha: string; reused: true }> {
    const remote = await this.options.runCommand(gitCommand(["-C", worktreePath, "ls-remote", "origin", `refs/heads/${branch}`]));
    if (remote.exitCode !== 0) {
      throw new GitOperationError("WORKTREE_GIT_FAILED", redactSecrets(remote.stderr));
    }
    const commitSha = remote.stdout.trim().split(/\s+/)[0] ?? "";
    if (!commitSha) {
      throw new GitOperationError("WORKTREE_GIT_FAILED", `Remote branch ${branch} was not found after push rejection`);
    }
    return { pushed: true, commit_sha: commitSha, reused: true };
  }

  private assertManagedWorktreePath(path: string): void {
    if (!isPathInside(resolve(this.options.projectRoot, this.options.worktreesDir), path)) {
      throw new GitOperationError("WORKTREE_UNMANAGED_PATH", "Worktree path is outside the managed worktrees directory");
    }
  }

  private assertArchivePath(path: string): void {
    if (!isPathInside(resolve(this.options.projectRoot, ".northstar/runtime/archive/worktrees"), path)) {
      throw new GitOperationError("WORKTREE_ARCHIVE_PATH_UNSAFE", "Archive path is outside the managed archive directory");
    }
  }
}

export function createIssueWorktreeCommandPlan(input: {
  projectRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): GitCommand[] {
  return [
    gitCommand(["-C", input.projectRoot, "fetch", "origin", input.baseBranch]),
    gitCommand(["-C", input.projectRoot, "worktree", "add", "-b", input.branch, input.worktreePath, `origin/${input.baseBranch}`]),
  ];
}

export function sanitizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "issue";
}

function gitCommand(args: string[]): GitCommand {
  const spec = commandSpec("git", args)
  const [command, ...safeArgs] = spec.argv;
  return { command, args: safeArgs };
}

export function isPathInside(root: string, path: string, pathImpl: PathImplementation = defaultPath): boolean {
  const resolvedRoot = pathImpl.resolve(root);
  const resolvedPath = pathImpl.resolve(path);
  const relativePath = pathImpl.relative(resolvedRoot, resolvedPath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${pathImpl.sep}`)
    && !pathImpl.isAbsolute(relativePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonFastForwardPushRejection(stderr: string): boolean {
  return /\[rejected\].*\(fetch first\)|non-fast-forward|Updates were rejected/i.test(stderr);
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultEnsureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
