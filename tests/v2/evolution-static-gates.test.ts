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

test("sandbox workspace resources do not claim fixture-copy isolation", () => {
  const sandbox = source("src/v2/evolution/sandbox.ts");
  assert.doesNotMatch(sandbox, /temp-fixture-copy/);
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
    .filter((file) => /src\/v2\/(db|evolution|ui-api\/postgres|inspection\/postgres|read-models\/postgres|stores\/postgres)/.test(file))
    .filter((file) => sqlitePattern.test(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(forbiddenNewCode, []);
});

test("retired runtime compatibility paths stay out of active source and tests", () => {
  const removedFiles = [
    "src/v2/pi-web/operations-dashboard-renderer.ts",
  ];
  assert.deepEqual(removedFiles.filter((file) => productionFiles.includes(file)), []);

  const checkedFiles = sourceFiles.filter((file) => file !== "tests/v2/evolution-static-gates.test.ts");
  const retiredPattern =
    /pi-web\.operations-dashboard\.v1|canonicalizeCompactPiPlan|fixtureRepoMountFromGoal|callbackBindingExistsPg|software\.implementation|domainPackId/;
  assert.deepEqual(grep(checkedFiles, retiredPattern), []);
});

test("planner route surface stays in its focused route module", () => {
  assert.equal(productionFiles.includes("src/v2/server/planner-routes.ts"), true);

  const runtimeRoutes = source("src/v2/server/routes.ts");
  assert.doesNotMatch(runtimeRoutes, /"\/api\/v2\/run-goal"/);
  assert.doesNotMatch(runtimeRoutes, /\/api\\\/v2\\\/planner\\\/drafts/);
  assert.doesNotMatch(runtimeRoutes, /"\/api\/v2\/planner\/drafts/);
});

test("run read-model route surface stays in its focused route module", () => {
  assert.equal(productionFiles.includes("src/v2/server/run-read-routes.ts"), true);

  const runtimeRoutes = source("src/v2/server/routes.ts");
  assert.doesNotMatch(runtimeRoutes, /\/api\\\/v2\\\/read-models/);
  assert.doesNotMatch(runtimeRoutes, /\/api\\\/v2\\\/runs\\\/\(\[\^\/]\+\)\\\/events/);
  assert.doesNotMatch(runtimeRoutes, /artifacts\|sessions\|memory\|logs/);
  assert.doesNotMatch(runtimeRoutes, /"task-envelope"/);
});

test("recovery decision applier dispatches paths through a handler table", () => {
  const applier = source("src/v2/exceptions/recovery-decision-applier.ts");
  assert.match(applier, /type RecoveryPathHandler/);
  assert.match(applier, /const recoveryPathHandlers/);
  assert.match(applier, /recoveryPathHandlers\[input\.decision\.payload\.path\]/);
  assert.doesNotMatch(applier, /payload\.path === "wake-new-brain"/);
  assert.doesNotMatch(applier, /payload\.path === "reprovision-hand"/);
  assert.doesNotMatch(applier, /payload\.path !== "requeue-hand-execution"/);
});

test("runtime workflow projection stays in a focused read-model module", () => {
  assert.equal(productionFiles.includes("src/v2/read-models/runtime-workflow-projection.ts"), true);

  const workflowUi = source("src/v2/read-models/workflow-ui.ts");
  assert.match(workflowUi, /buildRuntimeWorkflowCanvasProjection/);
  assert.doesNotMatch(workflowUi, /function runtimeEdgeStatus/);
  assert.doesNotMatch(workflowUi, /function runtimeOverlaysByTask/);
  assert.doesNotMatch(workflowUi, /function attentionFromOverlays/);
});

test("operator overview delegates attention projection to focused read-model code", () => {
  assert.equal(productionFiles.includes("src/v2/read-models/operator-attention.ts"), true);

  const operatorOverview = source("src/v2/read-models/operator-overview.ts");
  assert.match(operatorOverview, /buildOperatorAttentionItems/);
  assert.doesNotMatch(operatorOverview, /function resourceAttentionItem/);
  assert.doesNotMatch(operatorOverview, /function taskAttentionItem/);
  assert.doesNotMatch(operatorOverview, /function compareAttention/);
});

test("composition compiler delegates library selection summaries to focused helper code", () => {
  assert.equal(productionFiles.includes("src/v2/orchestration/composition-selection-summary.ts"), true);

  const compiler = source("src/v2/orchestration/composition-compiler.ts");
  assert.match(compiler, /summarizeCandidates/);
  assert.match(compiler, /collectSelectedObjectVersionRefs/);
  assert.doesNotMatch(compiler, /function collectSelectedObjectVersionRefs/);
  assert.doesNotMatch(compiler, /function graphRefsByKind/);
});

test("agent session hook delegates pure session and message logic to a focused web module", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  const engine = source("web/lib/agent-session-engine.ts");

  assert.match(hook, /from "\@\/lib\/agent-session-engine"/);
  assert.match(engine, /export function buildSessionStats/);
  assert.match(engine, /export function latestWorkflowDraftId/);
  assert.match(engine, /export function readCompactResult/);
  assert.match(hook, /buildSessionStats\(/);
  assert.match(hook, /latestWorkflowDraftId\(/);
  assert.match(hook, /readCompactResult\(/);
  assert.doesNotMatch(hook, /const sessionStats = \(\(\) =>/);
  assert.doesNotMatch(hook, /function latestWorkflowDraftId/);
  assert.doesNotMatch(hook, /function readCompactResult/);
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
