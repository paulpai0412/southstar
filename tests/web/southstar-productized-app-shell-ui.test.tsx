import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string { return readFileSync(join(root, path), "utf8"); }

test("root renders Southstar product shell with Chat Workflow Operations tabs", () => {
  assert.match(source("app/page.tsx"), /SouthstarProductShell/);
  const shell = source("components/southstar/app-shell/SouthstarProductShell.tsx");
  assert.match(shell, /SouthstarChatTab/);
  assert.match(shell, /WorkflowTab/);
  assert.match(shell, /SouthstarOperationsTab/);
  assert.match(shell, /activeTab/);
  assert.match(shell, /Chat/);
  assert.match(shell, /Workflow/);
  assert.match(shell, /Operations/);
});

test("workflow tab contains library context, guided chat, DAG flow, and floating operator", () => {
  assert.match(source("components/southstar/workflow/WorkflowTab.tsx"), /LibraryContextPanel/);
  assert.match(source("components/southstar/workflow/WorkflowTab.tsx"), /GuidedPlannerChat/);
  assert.match(source("components/southstar/workflow/WorkflowTab.tsx"), /WorkflowDagPanel/);
  assert.match(source("components/southstar/workflow/TaskInspector.tsx"), /Customize this run/);
  assert.match(source("components/southstar/workflow/TaskInspector.tsx"), /Context Sources/);
  assert.match(source("components/southstar/workflow/LibraryAlternativesSheet.tsx"), /Matched templates/);
  assert.match(source("components/southstar/operator/OperatorSheet.tsx"), /Needs attention/);
});

test("chat tab remains available and operations tab replaces northstar wording", () => {
  assert.match(source("components/southstar/chat/SouthstarChatTab.tsx"), /General conversation/);
  assert.match(source("components/southstar/chat/SouthstarChatTab.tsx"), /skill-guided/);
  const ops = source("components/southstar/operations/SouthstarOperationsTab.tsx");
  assert.match(ops, /Southstar Control Center/);
  assert.match(ops, /workflow runs/);
  assert.doesNotMatch(ops, /Northstar issue|issue lifecycle/);
});

test("calm product shell tokens exist and avoid copied pi-web dark shell as default", () => {
  const css = source("app/globals.css");
  assert.match(css, /--ss-product-bg: #f6f8fb/);
  assert.match(css, /--ss-product-primary: #102033/);
  assert.match(css, /--ss-product-border: #d8e1ec/);
  assert.doesNotMatch(css, /purple|violet|gradient\(.*purple/i);
});
