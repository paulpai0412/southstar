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

test("workflow task node badge keys tolerate duplicate labels", () => {
  const node = source("web/components/workflow-canvas/WorkflowTaskNode.tsx");
  assert.doesNotMatch(node, /key=\{badge\.label\}/);
  assert.match(node, /badges\.map\(\(badge,\s*index\)/);
  assert.match(node, /badge\.label.*index|index.*badge\.label/s);
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
    runtimeHealth: { activeRunCount: 0, attentionCount: 0, blockedCount: 0 },
    attentionItems: [{ id: "attn-a", severity: "blocked", title: "Task blocked", runId: "run-a", taskId: "task-a" }],
  });
  assert.equal(overview.runs[0].runId, "run-a");
  assert.equal(overview.runtimeHealth.activeRunCount, 0);
  assert.equal(overview.runtimeHealth.attentionCount, 0);
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

test("SidecarShell supports shared Files History Live SSE Actions tabs with header icon controls", () => {
  const sidecar = source("web/components/SidecarShell.tsx");
  for (const token of ["floating", "pinned", "expanded", "hidden", "Files", "History", "Live SSE", "Actions"]) {
    assert.match(sidecar, new RegExp(token));
  }
  assert.doesNotMatch(sidecar, /Files DAG History/);
  assert.doesNotMatch(sidecar, /sidecar-mode-select/);
  assert.match(sidecar, /sidecar-icon-button/);
  assert.match(sidecar, /title="Hide sidecar"/);
  assert.match(sidecar, /title=\{mode === "hidden" \? "Show sidecar" : "Hide sidecar"\}/);
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
  assert.match(sidebar, /ProjectScopePicker/);
  assert.match(sidebar, /Running Workflow Runs/);
  assert.match(sidebar, /Completed Workflow Runs/);
  assert.match(sidebar, /compareRunUpdatedAt/);
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

test("Operator workspace defaults to state dashboard before opening selected workflow DAG", () => {
  const workspace = source("web/components/operator/OperatorWorkspace.tsx");
  assert.match(workspace, /OperatorStateDashboard/);
  assert.match(workspace, /WorkflowStateCard/);
  assert.match(workspace, /OperatorWorkflowProgress/);
  assert.match(workspace, /operatorStateBuckets/);
  assert.match(workspace, /selectedRunId \? overview\.runs\.find/);
  assert.doesNotMatch(workspace, /OperatorRuntimeStateCard/);
  assert.match(source("web/components/operator/OperatorWorkflowProgress.tsx"), /SouthstarWorkflowCanvas/);
  assert.match(source("web/components/operator/OperatorWorkflowProgress.tsx"), /direction="RIGHT"/);
  assert.doesNotMatch(source("web/components/operator/OperatorWorkflowProgress.tsx"), />Progress</);
  assert.doesNotMatch(source("web/components/operator/OperatorWorkflowProgress.tsx"), /setView\("progress"\)/);
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
  assert.match(shell, /operatorHistory/);
  assert.match(shell, /operatorStream/);
  assert.match(shell, /operatorActions/);
  assert.match(shell, /operatorArtifacts/);
  assert.doesNotMatch(shell, /operator-dag/);
  assert.match(shell, /setActiveSidecarTabId\(`operator-history:\$\{filePath\}`\)/);
  assert.match(shell, /current\.filter\(\(tab\) => !tab\.kind\?\.startsWith\("operator"\)\)/);
});

test("Operator task sidecar exposes History Live SSE Actions Artifacts tabs", () => {
  const tabs = source("web/components/operator/OperatorTaskTabs.tsx");
  for (const token of ["History", "Live SSE", "Actions", "Artifacts"]) {
    assert.match(tabs, new RegExp(token));
  }
  assert.match(tabs, /debugModel\.data\.actions/);
  assert.match(tabs, /mergeOperatorTaskCommands/);
  assert.doesNotMatch(tabs, /SouthstarWorkflowCanvas/);
  assert.doesNotMatch(tabs, /taskDagCanvasFromDebug/);
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

test("Operator mode surfaces overview errors and keeps dashboard until user selects a workflow", () => {
  const shell = source("web/components/AppShell.tsx");
  const sidebar = source("web/components/operator/OperatorSidebar.tsx");
  assert.match(shell, /operator\.error/);
  assert.match(shell, /defaultSelection/);
  assert.match(shell, /setOperatorSelectedRunId/);
  assert.match(shell, /setOperatorSelectedRunId\(null\)/);
  assert.doesNotMatch(shell, /runs\[0\]\?\.runId/);
  assert.match(sidebar, /error/);
  assert.match(sidebar, /Operator overview/);
});

test("AppShell keeps mode panels mounted but only mounts the active sidebar surface", () => {
  const shell = source("web/components/AppShell.tsx");

  assert.match(shell, /data-testid="chat-mode-panel"/);
  assert.match(shell, /data-testid="workflow-mode-panel"/);
  assert.match(shell, /data-testid="operator-mode-panel"/);
  assert.match(shell, /data-testid="chat-sidebar-panel"/);
  assert.match(shell, /data-testid="workflow-sidebar-panel"/);
  assert.match(shell, /data-testid="operator-sidebar-panel"/);
  assert.match(shell, /activeSidebarSurface === "operator" \?/);
  assert.match(shell, /activeSidebarSurface === "workflow" \?/);
  assert.match(shell, /activeSidebarSurface === "library" \?/);
  assert.doesNotMatch(shell, /sidebarPanelStyle\(activeSidebarSurface/);
  assert.match(shell, /key=\{`chat:\$\{sessionKey\}`\}/);
  assert.match(shell, /key=\{`workflow:\$\{workflowSessionKey\}`\}/);
  assert.doesNotMatch(shell, /key=\{`\$\{appMode\}:/);
});

test("Operator task debug clears stale model before fetching another task", () => {
  const hook = source("web/hooks/useOperatorTaskDebug.ts");
  assert.match(hook, /setModel\(null\);\s*setError\(null\);\s*const controller/s);
});

test("Operator actions only treat successful POST responses as completed", () => {
  const panel = source("web/components/operator/OperatorActionsPanel.tsx");
  const helper = source("web/lib/operator/invokeCommand.ts");
  assert.match(panel, /invokeOperatorCommand/);
  assert.match(helper, /const method = command\.method \|\| "POST"/);
  assert.match(helper, /if \(method !== "POST"\) throw new Error/);
  assert.match(helper, /fetch\("\/api\/operator\/command"/);
  assert.match(helper, /endpoint: command\.endpoint/);
  assert.match(helper, /if \(!response\.ok\) throw new Error/);
  assert.match(panel, /setActionError/);
  assert.doesNotMatch(panel, /disabled=\{!command\.enabled \|\| pendingCommandId === command\.id \|\| \(requiresReason/);
  assert.match(panel, /setActionError\(`Reason required before running \$\{command\.label\}`\)/);
});
