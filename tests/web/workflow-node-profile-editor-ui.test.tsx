import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

test("pi web workflow node profile editor is wired into the right panel", () => {
  const appShell = readFileSync(join(root, "web/components/AppShell.tsx"), "utf8");
  const editor = readFileSync(join(root, "web/components/WorkflowNodeProfileEditor.tsx"), "utf8");

  assert.match(appShell, /workflowNodeProfile/);
  assert.match(appShell, /WorkflowNodeProfileEditor/);
  assert.match(editor, /data-testid="workflow-node-profile-editor"/);
  assert.match(editor, /data-testid="workflow-node-profile-save"/);
  assert.match(editor, /data-testid="workflow-node-profile-reset"/);
});
