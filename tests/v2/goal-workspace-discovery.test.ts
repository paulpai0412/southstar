import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverGoalWorkspace } from "../../src/v2/orchestration/goal-workspace-discovery.ts";

test("workspace discovery returns bounded instruction and project metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-goal-discovery-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# Instructions\n\nUse the repo conventions.\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo", type: "module" }));
    await writeFile(join(root, "notes.md"), "ordinary notes");

    const discovery = await discoverGoalWorkspace(root);

    assert.equal(discovery.schemaVersion, "southstar.workspace_goal_discovery.v1");
    assert.equal(discovery.cwd, root);
    assert.equal(discovery.instructionDocuments[0]?.path, "AGENTS.md");
    assert.equal(discovery.projectMetadata[0]?.path, "package.json");
    assert.match(discovery.discoveryHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(discovery.entries.map((entry) => entry.path), [...discovery.entries.map((entry) => entry.path)].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace discovery ignores secrets, binaries, build directories, and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-goal-discovery-"));
  const outside = await mkdtemp(join(tmpdir(), "southstar-goal-discovery-outside-"));
  try {
    await writeFile(join(root, ".env"), "API_TOKEN=secret-value");
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(outside, "AGENTS.md"), "# Outside\n\nDo not read this.\n");
    await symlink(outside, join(root, "linked-outside"), "dir");

    const discovery = await discoverGoalWorkspace(root, { maxEntries: 20, maxDocumentBytes: 200, maxTotalBytes: 500 });
    const allDocumentText = [...discovery.instructionDocuments, ...discovery.projectMetadata]
      .map((document) => document.content)
      .join("\n");

    assert.equal(discovery.entries.some((entry) => entry.path.includes(".env")), false);
    assert.equal(discovery.entries.some((entry) => entry.path.includes("linked-outside")), false);
    assert.equal(allDocumentText.includes("secret-value"), false);
    assert.equal(allDocumentText.includes("Do not read this"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("workspace discovery marks truncation when limits are reached", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-goal-discovery-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# Instructions\n\nSmall.");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");

    const discovery = await discoverGoalWorkspace(root, { maxEntries: 1 });

    assert.equal(discovery.truncated, true);
    assert.equal(discovery.entries.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace discovery skips unreadable descendants and records an incomplete snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-goal-discovery-"));
  const privateDir = join(root, "private");
  try {
    await writeFile(join(root, "AGENTS.md"), "# Instructions\n\nReadable.");
    await mkdir(privateDir);
    await writeFile(join(privateDir, "hidden.txt"), "must not be discovered");
    await chmod(privateDir, 0o000);

    const discovery = await discoverGoalWorkspace(root);

    assert.equal(discovery.truncated, true);
    assert.equal(discovery.entries.some((entry) => entry.path === "private/hidden.txt"), false);
    assert.equal(discovery.instructionDocuments[0]?.path, "AGENTS.md");
  } finally {
    await chmod(privateDir, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
