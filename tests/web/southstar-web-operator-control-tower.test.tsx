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
