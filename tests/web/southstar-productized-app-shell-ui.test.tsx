import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string { return readFileSync(join(root, path), "utf8"); }

test("root renders migrated shell with chat workspace WorkflowWorkbench OperatorBoard tabs", () => {
  assert.match(source("web/app/page.tsx"), /AppShell/);
  const appShell = source("web/components/AppShell.tsx");
  assert.match(appShell, /ChatWindow/);
  assert.match(appShell, /WorkflowSidebar/);
  assert.match(appShell, /OperatorWorkspace/);
  assert.match(appShell, /OperatorSidebar/);
  const shell = source("components/southstar/app/SouthstarPiWebShell.tsx");
  assert.match(shell, /SouthstarChatTab/);
  assert.match(shell, /SouthstarChatSessionSidebar/);
  assert.match(shell, /SouthstarChatFileViewerPanel/);
  assert.match(shell, /WorkflowWorkbench/);
  assert.match(shell, /OperatorBoard/);
  assert.match(shell, /WorkspaceTabs/);

  const tabs = source("components/southstar/workspace/WorkspaceTabs.tsx");
  assert.match(tabs, /\bChat\b/);
  assert.match(tabs, /\bWorkflow\b/);
  assert.match(tabs, /\bOperator\b/);
});

test("product shell uses Southstar Mission Engine in browser title and chat headers", () => {
  const layout = source("web/app/layout.tsx");
  const webChat = source("web/components/ChatWindow.tsx");
  const rootChat = source("components/ChatWindow.tsx");

  for (const file of [layout, webChat, rootChat]) {
    assert.match(file, /Southstar Mission Engine/);
    assert.doesNotMatch(file, /Pi Agent Web/);
  }
});

test("workflow workbench uses AgentLibraryPanel SouthstarWorkflowCanvas DefinitionInspector", () => {
  const workflow = source("components/southstar/workflow/WorkflowWorkbench.tsx");
  assert.match(workflow, /AgentLibraryPanel/);
  assert.match(workflow, /SouthstarWorkflowCanvas/);
  assert.match(workflow, /DefinitionInspector/);
});

test("workflow tab preserves URL draft or run compatibility and forwards runId", () => {
  const tab = source("components/southstar/workflow/WorkflowTab.tsx");
  assert.match(tab, /onOpenOperator:\s*\(runId\?:\s*string\)\s*=>\s*void/);
  assert.match(tab, /URLSearchParams\(window\.location\.search\)/);
  assert.match(tab, /initialDraftId=/);
  assert.match(tab, /initialRunId=/);
  assert.match(tab, /onOpenOperator=\{\(runId\?:\s*string\)\s*=>\s*props\.onOpenOperator\(runId\)\}/);
});

test("operator board centers attention queue and active runs without northstar issue wording", () => {
  const operator = source("components/southstar/operator/OperatorBoard.tsx");
  assert.match(operator, /Attention Queue/);
  assert.match(operator, /Active Runs/);
  assert.doesNotMatch(operator, /Northstar issue|issue lifecycle/i);
});
