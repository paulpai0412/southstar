import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, posix as pathPosix, win32 as pathWin32 } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  createIssueWorktreeCommandPlan,
  isPathInside,
  SoftwareDevWorktreeOperator,
} from "../../src/adapters/git/software-dev-worktree.ts";

test("plans issue worktree outside consumer root and uses argv arrays", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    pathExists: async () => true,
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("rev-parse")) return { exitCode: 0, stdout: "origin-main-sha\n", stderr: "" };
      if (command.args.includes("show-ref")) return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const worktree = await operator.prepareIssueWorktree({ issueNumber: 42, slug: "build-report" });

  assert.equal(worktree.path, "/repo/.northstar/runtime/worktrees/issue-42-build-report");
  assert.equal(worktree.branch, "northstar/issue-42-build-report");
  assert.deepEqual(calls[0], {
    command: "git",
    args: ["-C", "/repo/.northstar/runtime/sync-worktrees/main", "status", "--porcelain"],
  });
  assert.deepEqual(calls[1], {
    command: "git",
    args: ["-C", "/repo/.northstar/runtime/sync-worktrees/main", "fetch", "origin", "main"],
  });
  assert.deepEqual(calls[2], {
    command: "git",
    args: ["-C", "/repo/.northstar/runtime/sync-worktrees/main", "merge", "--ff-only", "origin/main"],
  });
  assert.deepEqual(calls[3], {
    command: "git",
    args: ["-C", "/repo/.northstar/runtime/sync-worktrees/main", "rev-parse", "HEAD"],
  });
  assert.deepEqual(calls[4], {
    command: "git",
    args: ["-C", "/repo", "worktree", "list", "--porcelain"],
  });
  assert.deepEqual(calls[5], {
    command: "git",
    args: ["-C", "/repo", "show-ref", "--verify", "--quiet", "refs/heads/northstar/issue-42-build-report"],
  });
  assert.deepEqual(calls[6], {
    command: "git",
    args: ["-C", "/repo", "worktree", "add", "-b", "northstar/issue-42-build-report", "/repo/.northstar/runtime/worktrees/issue-42-build-report", "origin-main-sha"],
  });
  assert.equal(worktree.baseCommit, "origin-main-sha");
});

test("prepare issue worktree creates missing sync worktree before using its head", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    pathExists: async () => false,
    ensureDirectory: async () => {},
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("rev-parse")) return { exitCode: 0, stdout: "fresh-origin-main\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const worktree = await operator.prepareIssueWorktree({ issueNumber: 43, slug: "missing sync" });

  assert.deepEqual(calls.slice(0, 3), [
    { command: "git", args: ["-C", "/repo", "fetch", "origin", "main"] },
    { command: "git", args: ["-C", "/repo", "worktree", "add", "--detach", "/repo/.northstar/runtime/sync-worktrees/main", "origin/main"] },
    { command: "git", args: ["-C", "/repo/.northstar/runtime/sync-worktrees/main", "rev-parse", "HEAD"] },
  ]);
  assert.equal(worktree.baseCommit, "fresh-origin-main");
});

test("prepare issue worktree surfaces base sync failures", async () => {
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    pathExists: async () => true,
    runCommand: async (command) => {
      if (command.args.includes("fetch")) return { exitCode: 1, stdout: "", stderr: "fatal ghp_abcdefghijklmnop1234" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () => operator.prepareIssueWorktree({ issueNumber: 1, slug: "base sync" }),
    (error) => error instanceof Error && "code" in error && error.code === "SYNC_WORKTREE_FETCH_FAILED" && !/ghp_/.test(error.message),
  );
});

test("prepare issue worktree blocks dispatch when sync worktree is dirty", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    pathExists: async () => true,
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("status")) return { exitCode: 0, stdout: " M package.json\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () => operator.prepareIssueWorktree({ issueNumber: 44, slug: "dirty sync" }),
    (error) => error instanceof Error && "code" in error && error.code === "SYNC_WORKTREE_DIRTY",
  );
  assert.equal(calls.some((command) => command.args.includes("worktree") && command.args.includes("add") && command.args.includes("-b")), false);
});

test("recover sync base branch discards dirty sync worktree before refresh", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    pathExists: async () => true,
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("status")) return { exitCode: 0, stdout: "", stderr: "" };
      if (command.args.includes("rev-parse")) return { exitCode: 0, stdout: "recovered-main\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const recovered = await operator.recoverSyncBaseBranch({ blockedErrorCode: "SYNC_WORKTREE_DIRTY" });

  assert.equal(recovered.commitSha, "recovered-main");
  assert.deepEqual(calls.map((command) => command.args.join(" ")), [
    "-C /repo/.northstar/runtime/sync-worktrees/main reset --hard HEAD",
    "-C /repo/.northstar/runtime/sync-worktrees/main clean -fd",
    "-C /repo/.northstar/runtime/sync-worktrees/main status --porcelain",
    "-C /repo/.northstar/runtime/sync-worktrees/main fetch origin main",
    "-C /repo/.northstar/runtime/sync-worktrees/main merge --ff-only origin/main",
    "-C /repo/.northstar/runtime/sync-worktrees/main rev-parse HEAD",
  ]);
});

test("prepare issue worktree blocks dispatch when sync worktree cannot fast-forward", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    pathExists: async () => true,
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("merge")) return { exitCode: 1, stdout: "", stderr: "fatal: Not possible to fast-forward" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () => operator.prepareIssueWorktree({ issueNumber: 45, slug: "ff failure" }),
    (error) => error instanceof Error && "code" in error && error.code === "SYNC_WORKTREE_FAST_FORWARD_FAILED",
  );
  assert.equal(calls.some((command) => command.args.includes("worktree") && command.args.includes("add") && command.args.includes("-b")), false);
});

test("commit and push rejects empty unchanged branch", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    baseBranch: "main",
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("status")) return { exitCode: 0, stdout: "", stderr: "" };
      if (command.args.includes("rev-parse") && command.args.includes("HEAD")) return { exitCode: 0, stdout: "abc\n", stderr: "" };
      if (command.args.includes("rev-parse") && command.args.includes("main")) return { exitCode: 0, stdout: "abc\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(() => operator.commitAndPush({
    worktreePath: "/repo/.northstar/runtime/worktrees/issue-42-build-report",
    branch: "northstar/issue-42-build-report",
    message: "northstar issue 42",
  }), /WORKTREE_NO_CHANGES/);
  assert.deepEqual(calls[0], {
    command: "git",
    args: ["-C", "/repo/.northstar/runtime/worktrees/issue-42-build-report", "status", "--porcelain"],
  });
});

test("commit and push returns existing commit sha for clean branch ahead of base", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    baseBranch: "main",
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("status")) return { exitCode: 0, stdout: "", stderr: "" };
      if (command.args.includes("rev-parse") && command.args.includes("HEAD")) return { exitCode: 0, stdout: "commit-ahead\n", stderr: "" };
      if (command.args.includes("rev-parse") && command.args.includes("main")) return { exitCode: 0, stdout: "base-commit\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const result = await operator.commitAndPush({
    worktreePath: "/repo/.northstar/runtime/worktrees/issue-42-build-report",
    branch: "northstar/issue-42-build-report",
    message: "northstar issue 42",
  });

  assert.deepEqual(result, { pushed: true, commit_sha: "commit-ahead", reused: true });
  assert.equal(calls.some((command) => command.args.includes("commit")), false);
  assert.equal(calls.some((command) => command.args.includes("push")), true);
});

test("commit and push reuses remote branch when worker already pushed", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    baseBranch: "main",
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("status")) return { exitCode: 0, stdout: " M file.txt\n", stderr: "" };
      if (command.args.includes("push")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: [
            " ! [rejected] northstar/issue-42-change -> northstar/issue-42-change (fetch first)",
            "error: failed to push some refs",
          ].join("\n"),
        };
      }
      if (command.args.includes("ls-remote")) {
        return { exitCode: 0, stdout: "remote-worker-commit\trefs/heads/northstar/issue-42-change\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const result = await operator.commitAndPush({
    worktreePath: "/repo/.northstar/runtime/worktrees/issue-42-change",
    branch: "northstar/issue-42-change",
    message: "northstar issue 42",
  });

  assert.deepEqual(result, { pushed: true, commit_sha: "remote-worker-commit", reused: true });
  assert.ok(calls.some((command) => command.args.join(" ") === "-C /repo/.northstar/runtime/worktrees/issue-42-change ls-remote origin refs/heads/northstar/issue-42-change"));
});

test("prepare issue worktree reuses existing worktree mapped to issue branch", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    pathExists: async () => true,
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("rev-parse")) return { exitCode: 0, stdout: "base-sha\n", stderr: "" };
      if (command.args.includes("worktree") && command.args.includes("list")) {
        return {
          exitCode: 0,
          stdout: [
            "worktree /repo/.northstar/runtime/worktrees/issue-7-existing-branch",
            "HEAD 1234567",
            "branch refs/heads/northstar/issue-7-existing-branch",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const worktree = await operator.prepareIssueWorktree({ issueNumber: 7, slug: "Existing Branch!" });

  assert.equal(worktree.reused, true);
  assert.equal(worktree.path, "/repo/.northstar/runtime/worktrees/issue-7-existing-branch");
  assert.equal(calls.some((command) => command.args.includes("worktree") && command.args.includes("add")), false);
});

test("prepare issue worktree attaches existing branch without creating a new branch", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    pathExists: async () => true,
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("rev-parse")) return { exitCode: 0, stdout: "base-sha\n", stderr: "" };
      if (command.args.includes("worktree") && command.args.includes("list")) return { exitCode: 0, stdout: "", stderr: "" };
      if (command.args.includes("show-ref")) return { exitCode: 0, stdout: "", stderr: "" };
      if (command.args.includes("worktree") && command.args.includes("add")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const worktree = await operator.prepareIssueWorktree({ issueNumber: 69, slug: "Task 1" });

  assert.equal(worktree.reused, true);
  assert.ok(calls.some((command) => command.args.join(" ") === "-C /repo worktree add /repo/.northstar/runtime/worktrees/issue-69-task-1 northstar/issue-69-task-1"));
  assert.equal(calls.some((command) => command.args.includes("-b") && command.args.includes("northstar/issue-69-task-1")), false);
});

test("worktree command failures are redacted and surfaced with stable codes", async () => {
  const createFailure = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    pathExists: async () => true,
    runCommand: async (command) => {
      if (command.args.includes("rev-parse")) return { exitCode: 0, stdout: "base-sha\n", stderr: "" };
      if (command.args.includes("worktree") && command.args.includes("add")) return { exitCode: 1, stdout: "", stderr: "fatal ghp_abcdefghijklmnop1234" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () => createFailure.prepareIssueWorktree({ issueNumber: 8, slug: "" }),
    (error) => error instanceof Error && "code" in error && error.code === "WORKTREE_CREATE_FAILED" && !/ghp_/.test(error.message),
  );

  const statusFailure = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    baseBranch: "main",
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "fatal github_pat_abcdefghijklmnop1234" }),
  });

  await assert.rejects(
    () => statusFailure.commitAndPush({ worktreePath: "/repo/.northstar/runtime/worktrees/issue-8-issue", branch: "northstar/issue-8-issue", message: "msg" }),
    (error) => error instanceof Error && "code" in error && error.code === "WORKTREE_STATUS_FAILED" && !/github_pat_/.test(error.message),
  );
});

test("commit and push runs add commit push and returns commit sha", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    baseBranch: "main",
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("status")) return { exitCode: 0, stdout: " M file.txt\n", stderr: "" };
      if (command.args.includes("rev-parse") && command.args.includes("HEAD")) return { exitCode: 0, stdout: "new-commit-sha\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const result = await operator.commitAndPush({ worktreePath: "/repo/wt", branch: "northstar/issue-9-change", message: "northstar issue 9" });

  assert.deepEqual(result, { pushed: true, commit_sha: "new-commit-sha" });
  assert.deepEqual(calls[1], { command: "git", args: ["-C", "/repo/wt", "add", "-A"] });
  assert.deepEqual(calls[2], { command: "git", args: ["-C", "/repo/wt", "commit", "-m", "northstar issue 9"] });
  assert.deepEqual(calls[3], { command: "git", args: ["-C", "/repo/wt", "push", "origin", "northstar/issue-9-change"] });
});

test("commit and push redacts git failure", async () => {
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    baseBranch: "main",
    runCommand: async (command) => {
      if (command.args.includes("status")) return { exitCode: 0, stdout: " M file.txt\n", stderr: "" };
      if (command.args.includes("commit")) return { exitCode: 1, stdout: "", stderr: "remote xoxb_abcdefghijklmnop1234" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () => operator.commitAndPush({ worktreePath: "/repo/wt", branch: "northstar/issue-9-change", message: "northstar issue 9" }),
    (error) => error instanceof Error && "code" in error && error.code === "WORKTREE_GIT_FAILED" && !/xoxb_/.test(error.message),
  );
});

test("root worktree never receives checkout or switch main", () => {
  const commands = createIssueWorktreeCommandPlan({
    projectRoot: "/repo",
    worktreePath: "/repo/.northstar/runtime/worktrees/issue-1-a",
    branch: "northstar/issue-1-a",
    baseBranch: "main",
  });

  assert.equal(commands.some((command) => command.args.join(" ").includes("checkout main")), false);
  assert.equal(commands.some((command) => command.args.join(" ").includes("switch main")), false);
  assert.equal(commands[1].args.includes("origin/main"), true);
});

test("path containment accepts Windows child paths", () => {
  assert.equal(
    isPathInside(
      "C:\\repo\\.northstar\\runtime\\worktrees",
      "C:\\repo\\.northstar\\runtime\\worktrees\\issue-50-safe",
      pathWin32,
    ),
    true,
  );
});

test("path containment rejects Windows sibling prefixes", () => {
  assert.equal(
    isPathInside(
      "C:\\repo\\.northstar\\runtime\\worktrees",
      "C:\\repo\\.northstar\\runtime\\worktrees-extra\\issue-50-unsafe",
      pathWin32,
    ),
    false,
  );
});

test("path containment rejects POSIX sibling prefixes", () => {
  assert.equal(
    isPathInside(
      "/repo/.northstar/runtime/worktrees",
      "/repo/.northstar/runtime/worktrees-extra/issue-50-unsafe",
      pathPosix,
    ),
    false,
  );
});

test("archive managed worktree validates source and destination before rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-worktree-archive-"));
  try {
    const worktree = join(dir, ".northstar/runtime/worktrees/issue-50-safe");
    const archive = join(dir, ".northstar/runtime/archive/worktrees/issue-50-safe-2026-05-31T10-00-00-000Z");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "note.txt"), "archived");
    const operator = new SoftwareDevWorktreeOperator({
      projectRoot: dir,
      worktreesDir: ".northstar/runtime/worktrees",
      baseBranch: "main",
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    const result = await operator.archiveManagedWorktree({ worktreePath: worktree, archivePath: archive });

    assert.deepEqual(result, { archived: true, archivePath: archive });
    assert.equal(await readFile(join(archive, "note.txt"), "utf8"), "archived");
    const secondWorktree = join(dir, ".northstar/runtime/worktrees/issue-50-second");
    await mkdir(secondWorktree, { recursive: true });
    await assert.rejects(
      () => operator.archiveManagedWorktree({ worktreePath: join(dir, "outside"), archivePath: archive }),
      (error) => error instanceof Error && "code" in error && error.code === "WORKTREE_UNMANAGED_PATH",
    );
    await assert.rejects(
      () => operator.archiveManagedWorktree({ worktreePath: secondWorktree, archivePath: join(dir, ".northstar/runtime/worktrees/bad") }),
      (error) => error instanceof Error && "code" in error && error.code === "WORKTREE_ARCHIVE_PATH_UNSAFE",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete managed worktree validates path before rm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-worktree-delete-"));
  try {
    const worktree = join(dir, ".northstar/runtime/worktrees/issue-51-safe");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "note.txt"), "delete me");
    const operator = new SoftwareDevWorktreeOperator({
      projectRoot: dir,
      worktreesDir: ".northstar/runtime/worktrees",
      baseBranch: "main",
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    const result = await operator.deleteManagedWorktree({ worktreePath: worktree });

    assert.deepEqual(result, { deleted: true });
    await assert.rejects(() => stat(worktree));
    await assert.rejects(
      () => operator.deleteManagedWorktree({ worktreePath: join(dir, ".northstar/runtime/worktrees/../sync-worktrees/main") }),
      (error) => error instanceof Error && "code" in error && error.code === "WORKTREE_UNMANAGED_PATH",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive and delete failures are retryable git operation errors with redacted messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-worktree-failure-"));
  try {
    const source = join(dir, ".northstar/runtime/worktrees/issue-52-failure");
    const archive = join(dir, ".northstar/runtime/archive/worktrees/issue-52-failure-2026-05-31T10-00-00-000Z");
    await mkdir(source, { recursive: true });
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "existing.txt"), "occupied");
    const operator = new SoftwareDevWorktreeOperator({
      projectRoot: dir,
      worktreesDir: ".northstar/runtime/worktrees",
      baseBranch: "main",
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await assert.rejects(
      () => operator.archiveManagedWorktree({ worktreePath: source, archivePath: archive }),
      (error) => error instanceof Error
        && "code" in error
        && error.code === "WORKTREE_ARCHIVE_FAILED"
        && "retryable" in error
        && error.retryable === true,
    );

    await assert.rejects(
      () => operator.deleteManagedWorktree({ worktreePath: join(dir, ".northstar/runtime/worktrees/missing-delete-target") }),
      (error) => error instanceof Error
        && "code" in error
        && error.code === "WORKTREE_DELETE_FAILED"
        && "retryable" in error
        && error.retryable === true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
