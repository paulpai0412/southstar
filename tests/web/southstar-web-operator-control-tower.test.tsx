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
