import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const platformLib = "../../skills/northstar/scripts/lib/platform.mjs";

async function assertNoOverwriteSiblings(parent: string, targetName: string) {
  const entries = await readdir(parent);
  assert.deepEqual(
    entries.filter((entry) => entry.startsWith(`.${targetName}.tmp-`) || entry.startsWith(`.${targetName}.backup-`)),
    [],
  );
}

test("northstar skill platform helpers resolve global skill dir by platform", async () => {
  const { globalSkillDirForHome } = await import(platformLib);

  assert.equal(globalSkillDirForHome({ platform: "linux", home: "/home/alice" }), "/home/alice/.codex/skills/northstar");
  assert.equal(globalSkillDirForHome({ platform: "darwin", home: "/Users/alice" }), "/Users/alice/.codex/skills/northstar");
  assert.equal(globalSkillDirForHome({ platform: "win32", home: "C:\\Users\\Alice" }), "C:\\Users\\Alice\\.codex\\skills\\northstar");
});

test("northstar skill platform helpers reject shell-chain command specs", async () => {
  const { commandSpec } = await import(platformLib);

  assert.deepEqual(commandSpec("git", ["status"]), { command: "git", args: ["status"] });
  assert.throws(() => commandSpec("git", ["status", "&&", "echo bad"]), /NORTHSTAR_SKILL_SHELL_CHAIN/);
  assert.throws(() => commandSpec("cmd && bad", []), /NORTHSTAR_SKILL_SHELL_CHAIN/);
});

test("northstar skill platform helpers copy directories by overwrite", async () => {
  const { copyDirectoryOverwrite } = await import(platformLib);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-platform-"));
  const source = join(dir, "source");
  const target = join(dir, "target");

  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "a.txt"), "source");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old");

    await copyDirectoryOverwrite(source, target);

    assert.equal(await readFile(join(target, "a.txt"), "utf8"), "source");
    await assert.rejects(() => access(join(target, "old.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar skill platform helpers keep target intact when replacement copy fails", async () => {
  const { copyDirectoryOverwrite } = await import(platformLib);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-platform-"));
  const source = join(dir, "missing-source");
  const target = join(dir, "target");

  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old");

    await assert.rejects(() => copyDirectoryOverwrite(source, target));

    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "old");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar skill platform helpers clean temp siblings when replacement copy fails", async () => {
  const { copyDirectoryOverwrite } = await import(platformLib);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-platform-"));
  const source = join(dir, "source");
  const target = join(dir, "target");

  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "a.txt"), "source");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old");

    await assert.rejects(
      () => copyDirectoryOverwrite(source, target, {
        fs: {
          cp: async () => {
            throw new Error("copy failed after temp creation");
          },
          mkdtemp,
          rename,
          rm,
        },
      }),
      /copy failed after temp creation/,
    );

    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "old");
    await assertNoOverwriteSiblings(dir, "target");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar skill platform helpers preserve copy failure when temp cleanup fails", async () => {
  const { copyDirectoryOverwrite } = await import(platformLib);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-platform-"));
  const source = join(dir, "source");
  const target = join(dir, "target");

  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "a.txt"), "source");

    await assert.rejects(
      () => copyDirectoryOverwrite(source, target, {
        fs: {
          cp: async () => {
            throw new Error("copy failed before replacement");
          },
          mkdtemp,
          rename,
          rm: async () => {
            throw new Error("cleanup failed");
          },
        },
      }),
      /copy failed before replacement/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar skill platform helpers restore target when final replacement rename fails", async () => {
  const { copyDirectoryOverwrite } = await import(platformLib);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-platform-"));
  const source = join(dir, "source");
  const target = join(dir, "target");

  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "a.txt"), "source");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old");

    await assert.rejects(
      () => copyDirectoryOverwrite(source, target, {
        fs: {
          cp,
          mkdtemp,
          rename: async (from: string, to: string) => {
            if (from.includes(".target.tmp-") && to === target) {
              throw new Error("final rename failed");
            }
            await rename(from, to);
          },
          rm,
        },
      }),
      /final rename failed/,
    );

    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "old");
    await assert.rejects(() => access(join(target, "a.txt")));
    await assertNoOverwriteSiblings(dir, "target");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar skill platform helpers preserve backup when final rename and rollback fail", async () => {
  const { copyDirectoryOverwrite } = await import(platformLib);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-platform-"));
  const source = join(dir, "source");
  const target = join(dir, "target");

  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "a.txt"), "source");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "old.txt"), "old");

    let backupPath: string | undefined;
    let finalRenameFailed = false;

    await assert.rejects(
      () => copyDirectoryOverwrite(source, target, {
        fs: {
          cp,
          mkdtemp,
          rename: async (from: string, to: string) => {
            if (from === target && to.includes(".target.backup-")) {
              backupPath = to;
            }
            if (from.includes(".target.tmp-") && to === target) {
              finalRenameFailed = true;
              throw new Error("final rename failed");
            }
            if (finalRenameFailed && from === backupPath && to === target) {
              throw new Error("rollback rename failed");
            }
            await rename(from, to);
          },
          rm,
        },
      }),
      (error: Error & { backupPath?: string }) => {
        assert.match(error.message, /final rename failed/);
        assert.equal(error.backupPath, backupPath);
        return true;
      },
    );

    assert.ok(backupPath);
    assert.equal(await readFile(join(backupPath, "old.txt"), "utf8"), "old");
    await assert.rejects(() => access(target));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar skill platform helpers capture command stdout and stderr", async () => {
  const { runCommand } = await import(platformLib);

  const result = await runCommand({
    command: "printf",
    args: ["out"],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "");
  assert.equal(result.errorCode, undefined);
});

test("northstar skill platform helpers propagate non-zero command exit codes", async () => {
  const { runCommand } = await import(platformLib);

  const result = await runCommand({
    command: "ls",
    args: [join(tmpdir(), "northstar-definitely-missing-path")],
  });

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /northstar-definitely-missing-path/);
  assert.equal(result.errorCode, undefined);
});

test("northstar skill platform helpers report missing command diagnostics", async () => {
  const { runCommand } = await import(platformLib);

  const result = await runCommand({
    command: join(tmpdir(), "northstar-definitely-missing-command"),
    args: [],
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.errorCode, "ENOENT");
  assert.match(result.message, /ENOENT/);
  assert.match(result.stderr, /ENOENT/);
});
