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
  assert.match(colors, /normalizeWorkflowStatus/);
  assert.match(colors, /statusColorFor/);
});

test("workflow task node renders agent library badges", () => {
  const node = source("components/southstar/workflow-canvas/WorkflowTaskNode.tsx");
  assert.match(node, /roleRef/);
  assert.match(node, /agentProfileRef/);
  assert.match(node, /artifactKind/);
  assert.match(node, /badges/);
  assert.match(node, /attention/);
});

test("workflow workbench includes structured planner inputs and data-driven create or revise wiring", () => {
  const workbench = source("components/southstar/workflow/WorkflowWorkbench.tsx");
  assert.match(workbench, /domainPack/);
  assert.match(workbench, /cwdHint/);
  assert.match(workbench, /orchestrationMode/);
  assert.match(workbench, /composerMode/);
  assert.match(workbench, /libraryHints/);
  assert.match(workbench, /api\.command\(\"\/api\/v2\/planner\/drafts\"/);
  assert.match(workbench, /api\.reviseDraft/);
});

test("definition inspector renders validation repair planner trace and revise action", () => {
  const inspector = source("components/southstar/workflow/DefinitionInspector.tsx");
  assert.match(inspector, /Validation issues/i);
  assert.match(inspector, /Repair attempts/i);
  assert.match(inspector, /Planner trace refs/i);
  assert.match(inspector, /onReviseDraft/);
  assert.match(inspector, /Revise draft/);
});

test("agent library panel renders policy context memory and candidate reasons from model", () => {
  const panel = source("components/southstar/workflow/AgentLibraryPanel.tsx");
  assert.match(panel, /agentLibrarySummary/);
  assert.match(panel, /selectedDefinition/);
  assert.match(panel, /contextMemory/i);
  assert.match(panel, /selectionReasons|candidateReasons/);
  assert.match(panel, /toolGrantRefs|mcpGrantRefs|skillRefs/);
  assert.doesNotMatch(panel, /Southstar will select agents/);
});
