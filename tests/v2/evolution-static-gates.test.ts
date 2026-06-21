import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
const sourceFiles = listFiles(["src", "tests"], /\.(ts|tsx)$/);
const productionFiles = sourceFiles.filter((path) => path.startsWith("src/"));

test("Southstar evolution code does not directly SQL-couple to tork schema", () => {
  const matches = grep(sourceFiles, /\b(from|join|insert\s+into|update|delete\s+from)\s+tork\s*\.|set\s+search_path\s+.*\btork\b/i);
  assert.deepEqual(matches, []);
});

test("simplified evolution storage does not create dedicated wiki, delta, sandbox, or asset tables", () => {
  const matches = grep(sourceFiles, /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:southstar\.)?(knowledge_wiki_pages|knowledge_wiki_links|asset_versions|delta_proposals|sandbox_experiments)\b/i);
  assert.deepEqual(matches, []);
});

test("production evolution routes do not include test-only seed shortcuts", () => {
  const matches = grep(productionFiles, /e2e\/seed|test-only|fake executor|mock executor/i);
  assert.deepEqual(matches, []);
});

test("canonical v2 test index and CLI tests do not import legacy SQLite-backed tests", () => {
  const index = readFileSync(join(root, "tests/v2/index.test.ts"), "utf8");
  const legacyImports = [...index.matchAll(/import\("\.\/(.+?)"\)/g)]
    .map((match) => `tests/v2/${match[1]}`)
    .filter((file) => isLegacySqliteTest(file));
  assert.deepEqual(legacyImports, []);

  const cliTests = ["tests/v2/cli.test.ts", "tests/v2/cli-operations.test.ts"];
  assert.deepEqual(cliTests.filter(isLegacySqliteTest), []);
});

test("active root-session artifact gate stays pure and legacy DB-backed loop is removed", () => {
  const activeRootSession = source("src/v2/agent-runner/root-session.ts");
  assert.doesNotMatch(activeRootSession, /runRootSessionTask|stores\/sqlite|appendHistoryEvent|upsertRuntimeResource|\.prepare\(/);
});

test("active v2 runtime entrypoints do not import legacy SQLite/local API modules", () => {
  const activeEntrypoints = productionFiles.filter((file) =>
    file === "src/v2/cli.ts" ||
    file.startsWith("src/v2/server/") ||
    file.startsWith("src/v2/db/") ||
    file.startsWith("src/v2/evolution/") ||
    file.startsWith("src/v2/stores/postgres") ||
    file.startsWith("src/v2/ui-api/postgres") ||
    file.startsWith("src/v2/context/postgres") ||
    file.startsWith("src/v2/inspection/postgres") ||
    file.startsWith("src/v2/read-models/postgres") ||
    file.startsWith("src/v2/executor/postgres") ||
    file.startsWith("src/v2/session-recovery/postgres")
  );
  const forbidden = /from\s+["'][^"']*(?:stores\/sqlite|ui-api\/local-api|context\/builder|inspection\/inspect-run|read-models\/registry|session-graph\/sqlite-provider)[^"']*["']/;
  const matches = activeEntrypoints.filter((file) => forbidden.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(matches, []);
});

test("Southstar v2 production no longer carries SQLite/local API source", () => {
  const removedFiles = [
    "src/v2/inspection/inspect-run.ts",
    "src/v2/legacy/sqlite/root-session.ts",
    "src/v2/memory/sqlite-provider.ts",
    "src/v2/session-graph/sqlite-provider.ts",
    "src/v2/stores/history-store.ts",
    "src/v2/stores/resource-store.ts",
    "src/v2/stores/run-store.ts",
    "src/v2/stores/sqlite.ts",
    "src/v2/stores/task-store.ts",
    "src/v2/ui-api/local-api.ts",
  ];
  assert.deepEqual(removedFiles.filter((file) => productionFiles.includes(file)), []);

  const sqlitePattern = /node:sqlite|sqlite-provider|createSqliteSessionGraphProvider|\.prepare\(|openSouthstarDb\(\":memory:\"/;
  const matches = grep(productionFiles, sqlitePattern);
  assert.deepEqual(matches, []);

  const forbiddenNewCode = productionFiles
    .filter((file) => /src\/v2\/(db|evolution|context\/postgres-builder|ui-api\/postgres|inspection\/postgres|read-models\/postgres|stores\/postgres)/.test(file))
    .filter((file) => sqlitePattern.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(forbiddenNewCode, []);
});

function source(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

function isLegacySqliteTest(file: string): boolean {
  if (file === "tests/v2/evolution-static-gates.test.ts") return false;
  const content = readFileSync(join(root, file), "utf8");
  return /openSouthstarDb\(\":memory:\"|src\/v2\/stores\/sqlite|\.\.\/\.\.\/src\/v2\/stores\/sqlite/.test(content);
}

function grep(files: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(root, file), "utf8");
    if (pattern.test(content)) hits.push(file);
  }
  return hits;
}

function listFiles(dirs: string[], pattern: RegExp): string[] {
  const results: string[] = [];
  for (const dir of dirs) walk(dir, results, pattern);
  return results.sort();
}

function walk(relativeDir: string, results: string[], pattern: RegExp): void {
  const absolute = join(root, relativeDir);
  for (const entry of readdirSync(absolute)) {
    if (["node_modules", ".next", ".git", ".git-local"].includes(entry)) continue;
    const relative = join(relativeDir, entry);
    const absoluteEntry = join(root, relative);
    const stat = statSync(absoluteEntry);
    if (stat.isDirectory()) walk(relative, results, pattern);
    else if (pattern.test(relative)) results.push(relative);
  }
}
