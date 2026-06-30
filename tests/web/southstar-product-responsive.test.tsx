import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("sidecar has sticky clickable tabs above scrollable content", () => {
  const shell = source("web/components/SidecarShell.tsx");
  const css = source("web/app/globals.css");
  assert.match(shell, /sidecar-tabs/);
  assert.match(css, /\.sidecar-tabs/);
  assert.match(css, /position: sticky/);
  assert.match(css, /z-index: 2/);
});

test("operator task tabs render summary before raw debug panels", () => {
  const tabs = source("web/components/operator/OperatorTaskTabs.tsx");
  assert.match(tabs, /OperatorTaskSummary/);
  assert.match(tabs, /Task Summary/);
});

test("workflow new session omits launch preview from the empty chat state", () => {
  const chat = source("web/components/ChatWindow.tsx");
  assert.match(chat, /workflowMode/);
  assert.doesNotMatch(chat, /WorkflowLaunchPreview/);
  assert.doesNotMatch(chat, /Workflow launch preview/);
  assert.doesNotMatch(chat, /Workflow handles DAG generation, revision, validation, and launch/);
});

test("operator and workflow control surfaces stack on mobile", () => {
  const css = source("web/app/globals.css");
  const preview = source("web/components/WorkflowLaunchPreview.tsx");
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /\.operator-health-strip/);
  assert.match(css, /\.operator-priority-grid/);
  assert.match(css, /\.workflow-launch-preview-flow/);
  assert.match(preview, /workflow-launch-preview-flow/);
});

test("mode positioning copy separates chat workflow and operator responsibilities", () => {
  assert.match(source("web/components/AppModeRail.tsx"), /ad-hoc/);
  assert.doesNotMatch(source("web/components/ChatWindow.tsx"), /Chat handles ad-hoc/);
  assert.match(source("web/components/WorkflowLaunchPreview.tsx"), /Workflow handles DAG generation/);
  assert.match(source("web/components/operator/OperatorWorkspace.tsx"), /Operator helps you monitor/);
});
