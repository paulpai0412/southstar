import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const syncModule = "../../skills/northstar/scripts/sync-global.mjs";

test("northstar skill sync overwrites global target", async () => {
  const { syncGlobalSkill } = await import(syncModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-sync-"));
  try {
    const source = join(dir, "source");
    const target = join(dir, "target");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Northstar Global Skill\n");
    await writeFile(join(target, "old.txt"), "old");

    const result = await syncGlobalSkill({ sourceDir: source, targetDir: target });

    assert.equal(result.skill_global_sync_overwrites_target, 1);
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "# Northstar Global Skill\n");
    await assert.rejects(() => readFile(join(target, "old.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar skill sync resolves target from home and platform", async () => {
  const { resolveSyncTarget } = await import(syncModule);

  assert.equal(resolveSyncTarget({ platform: "linux", home: "/home/alice" }), "/home/alice/.codex/skills/northstar");
  assert.equal(resolveSyncTarget({ platform: "win32", home: "C:\\Users\\Alice" }), "C:\\Users\\Alice\\.codex\\skills\\northstar");
});

test("northstar skill sync creates missing global skill parent directories", async () => {
  const { syncGlobalSkill } = await import(syncModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-sync-parent-"));

  try {
    const source = join(dir, "source");
    const target = join(dir, "fresh-home", ".codex", "skills", "northstar");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Northstar Global Skill\n");

    const result = await syncGlobalSkill({ sourceDir: source, targetDir: target });

    assert.equal(result.skill_global_sync_overwrites_target, 1);
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "# Northstar Global Skill\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar skill sync cli rejects missing target value", async () => {
  const { parseSyncGlobalArgs } = await import(syncModule);

  assert.throws(() => parseSyncGlobalArgs(["--target"]), /Missing value for --target/);
});

test("northstar skill sync cli rejects unknown arguments", async () => {
  const { parseSyncGlobalArgs } = await import(syncModule);

  assert.throws(() => parseSyncGlobalArgs(["--dry-run"]), /Unknown argument: --dry-run/);
});
