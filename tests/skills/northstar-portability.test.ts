import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const platformLib = "../../skills/northstar/scripts/lib/platform.mjs";
const skillRoot = join(repoRoot, "skills/northstar");
const scannedSourceExtensions = new Set([".json", ".md", ".mjs", ".ts", ".yaml", ".yml"]);

function isScannedSourceFile(file: string): boolean {
  return [...scannedSourceExtensions].some((extension) => file.endsWith(extension));
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      return listFiles(entryPath);
    }
    return [entryPath];
  }));

  return files.flat();
}

test("northstar global skill dir fixtures are portable across supported platforms", async () => {
  const { globalSkillDirForHome } = await import(platformLib);

  assert.equal(globalSkillDirForHome({ platform: "linux", home: "/home/alice" }), "/home/alice/.codex/skills/northstar");
  assert.equal(globalSkillDirForHome({ platform: "darwin", home: "/Users/alice" }), "/Users/alice/.codex/skills/northstar");
  assert.equal(
    globalSkillDirForHome({ platform: "win32", home: "C:\\Users\\Alice" }),
    "C:\\Users\\Alice\\.codex\\skills\\northstar",
  );
  assert.equal(
    globalSkillDirForHome({ platform: "linux", home: "/home/alice/Dev Projects" }),
    "/home/alice/Dev Projects/.codex/skills/northstar",
  );
  assert.equal(
    globalSkillDirForHome({ platform: "darwin", home: "/Users/alice/Work Projects" }),
    "/Users/alice/Work Projects/.codex/skills/northstar",
  );
  assert.equal(
    globalSkillDirForHome({ platform: "win32", home: "C:\\Users\\Alice Smith" }),
    "C:\\Users\\Alice Smith\\.codex\\skills\\northstar",
  );
  assert.equal(
    globalSkillDirForHome({ platform: "win32", home: "\\\\server\\share\\Alice" }),
    "\\\\server\\share\\Alice\\.codex\\skills\\northstar",
  );
});

test("northstar skill sources avoid host-specific paths and shell script references", async () => {
  const forbidden = [
    { label: "/home/timmypai/apps/northstar", regex: /\/home\/timmypai\/apps\/northstar/ },
    { label: "/tmp/northstar", regex: /\/tmp\/northstar/ },
    { label: "/bin/sh", regex: /\/bin\/sh/ },
    { label: ".sh", regex: /\.sh\b/ },
  ];

  const files = (await listFiles(skillRoot)).filter(isScannedSourceFile);
  const violations: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.regex.test(content)) {
        violations.push(`${file.replace(`${repoRoot}/`, "")}: ${pattern.label}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
