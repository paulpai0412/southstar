import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");
const firstPartyWebRoots = ["web/app", "web/components", "web/hooks", "web/lib"];

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function webUiSources(dir: string): string[] {
  const absolute = join(root, dir);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name);
    const repoPath = relative(root, child);
    if (entry.isDirectory()) return webUiSources(repoPath);
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    return [repoPath];
  });
}

test("WorkflowDagBlock uses web-local workflow canvas imports", () => {
  const block = source("web/components/WorkflowDagBlock.tsx");
  assert.match(block, /from "\.\/workflow-canvas\/SouthstarWorkflowCanvas"/);
  assert.match(block, /from "\.\/workflow-canvas\/types"/);
  assert.doesNotMatch(block, /\.\.\/\.\.\/components\/southstar\/workflow-canvas/);
});

test("active web UI files do not import retired root Southstar UI folders", () => {
  const offenders = firstPartyWebRoots.flatMap((dir) => webUiSources(dir)).filter((path) => {
    const text = source(path);
    return /from\s+["'](?:\.\.\/)+components\/southstar(?:\/|["'])/.test(text)
      || /import\(["'](?:\.\.\/)+components\/southstar(?:\/|["'])/.test(text);
  });

  assert.deepEqual(offenders, []);
});

test("web-local workflow canvas keeps React Flow and ELK behavior", () => {
  const files = [
    "SouthstarWorkflowCanvas.tsx",
    "WorkflowDependencyEdge.tsx",
    "WorkflowTaskNode.tsx",
    "colors.ts",
    "layout.ts",
    "types.ts",
  ];

  for (const file of files) {
    assert.equal(existsSync(join(root, "web/components/workflow-canvas", file)), true, `${file} should exist`);
  }

  const packageJson = JSON.parse(source("web/package.json")) as { dependencies?: Record<string, string> };
  assert.equal(packageJson.dependencies?.["@xyflow/react"], "^12.11.1");
  assert.equal(packageJson.dependencies?.elkjs, "^0.11.1");

  const canvas = source("web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx");
  const layout = source("web/components/workflow-canvas/layout.ts");
  assert.match(canvas, /@xyflow\/react/);
  assert.match(canvas, /MiniMap/);
  assert.match(canvas, /Controls/);
  assert.match(canvas, /Background/);
  assert.match(layout, /elkjs\/lib\/elk\.bundled\.js/);
});

test("web operator API proxies route to v2 runtime endpoints", () => {
  assert.match(source("web/app/api/operator/overview/route.ts"), /\/api\/v2\/ui\/operator-overview/);
  assert.match(source("web/app/api/operator/task-debug/route.ts"), /\/api\/v2\/ui\/operator-task-debug/);
  assert.match(source("web/app/api/operator/runs/[runId]/events/stream/route.ts"), /events\/stream/);
  assert.match(source("web/app/api/operator/runs/[runId]/events/stream/route.ts"), /taskId/);
  const commandRoute = source("web/app/api/operator/command/route.ts");
  assert.match(commandRoute, /endpoint\.startsWith\("\/api\/v2\/"\)/);
  assert.match(commandRoute, /upstreamUrl\.pathname\.startsWith\("\/api\/v2\/"\)/);
});

test("web operator helpers normalize overview and build stream urls", async () => {
  const normalizers = await import("../../web/lib/operator/normalizers.ts");
  const sse = await import("../../web/lib/operator/sse.ts");
  assert.equal(typeof normalizers.normalizeOperatorOverview, "function");
  assert.equal(typeof sse.parseSseBuffer, "function");
  assert.equal(typeof sse.operatorRuntimeEventStreamUrl, "function");

  const overview = normalizers.normalizeOperatorOverview({
    activeRuns: [{ runId: "run-a", status: "running", title: "Build", cwd: "/repo/a" }],
    attentionItems: [{ id: "attn-a", severity: "blocked", title: "Task blocked", runId: "run-a", taskId: "task-a" }],
  });
  assert.equal(overview.runs[0].runId, "run-a");
  assert.equal(overview.attentionItems[0].taskId, "task-a");
  assert.equal(
    sse.operatorRuntimeEventStreamUrl({ runId: "run-a", taskId: "task-a", after: "12" }),
    "/api/operator/runs/run-a/events/stream?closeOnTerminal=false&taskId=task-a&after=12",
  );
});

test("operator repo filter includes project-root parent and child matches", async () => {
  const progress = await import("../../web/lib/operator/progress.ts");
  assert.equal(
    progress.runMatchesCwd({ runId: "run-a", status: "running", title: "Root run", projectRoot: "/repo" }, "/repo/apps/southstar"),
    true,
  );
  assert.equal(
    progress.runMatchesCwd({ runId: "run-b", status: "running", title: "Child run", projectRoot: "/repo/apps/southstar" }, "/repo"),
    true,
  );
});

test("AppShell uses shared floating sidecar instead of mode-specific fixed file panel", () => {
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /SidecarShell/);
  assert.match(shell, /sidecarTabs/);
  assert.match(shell, /sidecarMode/);
  assert.match(shell, /openSidecarTab/);
  assert.doesNotMatch(shell, /right-panel-container\$\{rightPanelOpen/);
});

test("SidecarShell supports shared Files DAG History Live SSE Actions tabs", () => {
  const sidecar = source("web/components/SidecarShell.tsx");
  for (const token of ["floating", "pinned", "expanded", "hidden", "Files", "DAG", "History", "Live SSE", "Actions"]) {
    assert.match(sidecar, new RegExp(token));
  }
  assert.match(sidecar, /data-testid="sidecar-shell"/);
});

test("Sidecar resize cleans up pointer listeners on cancel and mode changes", () => {
  const sidecar = source("web/components/SidecarShell.tsx");
  assert.match(sidecar, /pointercancel/);
  assert.match(sidecar, /resizeCleanupRef/);
  assert.match(sidecar, /removeEventListener\("pointermove"/);
  assert.match(sidecar, /onWidthCommit/);
});

test("AppShell restores sidecar width without persisting on every width state change", () => {
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /localStorage\.getItem\(SIDECAR_WIDTH_STORAGE_KEY\)/);
  assert.match(shell, /handleSidecarWidthCommit/);
  assert.doesNotMatch(
    shell,
    /useEffect\(\(\) => \{\s*window\.localStorage\.setItem\(SIDECAR_WIDTH_STORAGE_KEY, String\(sidecarWidth\)\);\s*\}, \[sidecarWidth\]\);/s,
  );
});

test("Operator mode is enabled in the live web AppModeRail", () => {
  const rail = source("web/components/AppModeRail.tsx");
  assert.doesNotMatch(rail, /disabled=\{item\.id === "operator"\}/);
  assert.doesNotMatch(rail, /Operator mode is outside this implementation cycle/);
});

test("AppShell renders Operator sidebar and workspace from the live web folder", () => {
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /OperatorSidebar/);
  assert.match(shell, /OperatorWorkspace/);
  assert.match(shell, /appMode === "operator"/);
});

test("Operator sidebar keeps project scope above operator focus", () => {
  const sidebar = source("web/components/operator/OperatorSidebar.tsx");
  assert.match(sidebar, /Project Scope/);
  assert.match(sidebar, /Operator Focus/);
  assert.match(sidebar, /ProjectScopePicker/);
  assert.match(sidebar, /Attention/);
  assert.match(sidebar, /Running Workflows/);
});

test("Workflow sidebar project selector accepts custom cwd input", () => {
  const sidebar = source("web/components/WorkflowSidebar.tsx");
  const shell = source("web/components/AppShell.tsx");

  assert.match(sidebar, /onCwdChange/);
  assert.match(sidebar, /customPathValue/);
  assert.match(sidebar, /\/api\/cwd\/validate/);
  assert.match(sidebar, /data-testid="workflow-project-custom-path"/);
  assert.match(sidebar, /onChange=\{\(event\) => setCustomPathValue\(event\.currentTarget\.value\)\}/);
  assert.match(shell, /onCwdChange=\{handleCwdChange\}/);
});

test("Operator workspace includes state board and selected workflow progress with DAG toggle", () => {
  assert.match(source("web/components/operator/OperatorWorkspace.tsx"), /OperatorStateBoard/);
  assert.match(source("web/components/operator/OperatorWorkspace.tsx"), /OperatorWorkflowProgress/);
  assert.match(source("web/components/operator/OperatorWorkflowProgress.tsx"), /DAG/);
  assert.match(source("web/components/operator/OperatorWorkflowProgress.tsx"), /Progress/);
});

test("Operator state board exposes counts, age, and attention severity", () => {
  const board = source("web/components/operator/OperatorStateBoard.tsx");
  assert.match(board, /attentionItems/);
  assert.match(board, /operator-state-count/);
  assert.match(board, /formatRunAge/);
  assert.match(board, /operator-run-severity/);
});

test("Operator overview polling is gated to Operator mode", () => {
  const shell = source("web/components/AppShell.tsx");
  const hook = source("web/hooks/useOperatorOverview.ts");
  assert.match(shell, /useOperatorOverview\(activeCwd, appMode === "operator"\)/);
  assert.match(hook, /enabled = true/);
  assert.match(hook, /if \(!enabled\) return;/);
});

test("Operator task sidecar opens debug tabs with History selected", () => {
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /openOperatorTaskSidecar/);
  assert.match(shell, /operatorDag/);
  assert.match(shell, /operatorHistory/);
  assert.match(shell, /operatorStream/);
  assert.match(shell, /operatorActions/);
  assert.match(shell, /operatorArtifacts/);
  assert.match(shell, /setActiveSidecarTabId\(`operator-history:\$\{filePath\}`\)/);
});

test("Operator task sidecar exposes DAG History Live SSE Actions Artifacts tabs", () => {
  const tabs = source("web/components/operator/OperatorTaskTabs.tsx");
  for (const token of ["DAG", "History", "Live SSE", "Actions", "Artifacts"]) {
    assert.match(tabs, new RegExp(token));
  }
  assert.match(tabs, /debugModel\.data\.actions/);
  assert.match(tabs, /mergeOperatorTaskCommands/);
  assert.match(tabs, /SouthstarWorkflowCanvas/);
  assert.match(tabs, /taskDagCanvasFromDebug/);
  assert.doesNotMatch(tabs, /JSON\.stringify\(debug\.model\.data\.task/);
  assert.match(source("web/components/operator/OperatorHistoryPanel.tsx"), /history/);
  assert.match(source("web/components/operator/OperatorLiveStream.tsx"), /Task stream/);
  assert.match(source("web/components/operator/OperatorLiveStream.tsx"), /Run stream/);
});

test("AppShell renders operator task tabs into the shared sidecar", () => {
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /OperatorTaskTabs/);
  assert.match(shell, /activeSidecarTab\.kind/);
  assert.match(shell, /commands=\{/);
  assert.match(shell, /commandResults=\{operator\.model\.commandResults\}/);
  assert.match(shell, /onCommandComplete=\{operator\.refresh\}/);
});

test("Operator mode surfaces overview errors and applies default selection", () => {
  const shell = source("web/components/AppShell.tsx");
  const sidebar = source("web/components/operator/OperatorSidebar.tsx");
  assert.match(shell, /operator\.error/);
  assert.match(shell, /defaultSelection/);
  assert.match(shell, /setOperatorSelectedRunId/);
  assert.match(sidebar, /error/);
  assert.match(sidebar, /Operator overview/);
});

test("Operator task debug clears stale model before fetching another task", () => {
  const hook = source("web/hooks/useOperatorTaskDebug.ts");
  assert.match(hook, /setModel\(null\);\s*setError\(null\);\s*const controller/s);
});

test("Operator actions only treat successful POST responses as completed", () => {
  const panel = source("web/components/operator/OperatorActionsPanel.tsx");
  assert.match(panel, /const method = command\.method \|\| "POST"/);
  assert.match(panel, /if \(method !== "POST"\) throw new Error/);
  assert.match(panel, /fetch\("\/api\/operator\/command"/);
  assert.match(panel, /endpoint: command\.endpoint/);
  assert.match(panel, /if \(!response\.ok\) throw new Error/);
  assert.match(panel, /setActionError/);
});
