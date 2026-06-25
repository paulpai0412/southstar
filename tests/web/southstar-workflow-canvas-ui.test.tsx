import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("shared workflow canvas uses React Flow and ELK", () => {
  assert.match(source("components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /@xyflow\/react/);
  assert.match(source("components/southstar/workflow-canvas/layout.ts"), /elkjs\/lib\/elk\.bundled\.js/);
  assert.match(source("components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /MiniMap/);
  assert.match(source("components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /Controls/);
  assert.match(source("components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /Background/);
});

test("workflow canvas centralizes node and edge status colors", () => {
  const colors = source("components/southstar/workflow-canvas/colors.ts");
  for (const token of ["pending", "queued", "scheduling", "running", "completed", "passed", "paused", "blocked", "exception", "failed", "cancelled"]) {
    assert.match(colors, new RegExp(token));
  }
  assert.match(colors, /edgeClassForStatus/);
  assert.match(colors, /blue animated/);
});

test("workflow task node renders agent library badges", () => {
  const node = source("components/southstar/workflow-canvas/WorkflowTaskNode.tsx");
  assert.match(node, /roleRef/);
  assert.match(node, /agentProfileRef/);
  assert.match(node, /artifactKind/);
  assert.match(node, /badges/);
  assert.match(node, /attention/);
});
