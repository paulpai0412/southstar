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

test("workflow node profile editor leads with summary and recommendations", () => {
  const editor = readFileSync(join(root, "web/components/WorkflowNodeProfileEditor.tsx"), "utf8");
  const summary = readFileSync(join(root, "web/components/WorkflowNodeProfileSummary.tsx"), "utf8");
  const recommendations = readFileSync(join(root, "web/components/WorkflowNodeProfileRecommendations.tsx"), "utf8");

  assert.match(editor, /WorkflowNodeProfileSummary/);
  assert.match(editor, /WorkflowNodeProfileRecommendations/);
  assert.match(editor, /Runtime profile is locked/);
  assert.match(summary, /Profile summary/);
  assert.match(summary, /Capability refs/);
  assert.match(recommendations, /Recommendations/);
  assert.match(recommendations, /selectionReasons|candidateReasons/);
});

test("workflow node profile editor exposes ontology-backed candidate controls", () => {
  const editor = readFileSync(join(root, "web/components/WorkflowNodeProfileEditor.tsx"), "utf8");
  const form = readFileSync(join(root, "web/lib/workflow/node-profile.ts"), "utf8");

  assert.match(editor, /data-testid="workflow-profile-candidate-profile"/);
  assert.match(editor, /data-testid="workflow-profile-host-adapter"/);
  assert.match(editor, /data-testid="workflow-profile-provider"/);
  assert.match(editor, /data-testid="workflow-profile-model"/);
  assert.match(editor, /data-testid="workflow-profile-thinking-mode"/);
  assert.match(editor, /data-testid="workflow-profile-prompt"/);
  assert.match(editor, /toolGrantRefs/);
  assert.match(editor, /vaultLeasePolicyRefs/);
  assert.match(form, /nodePromptSpec/);
});

test("workflow node profile editor filters refs and uses pi model registry options", () => {
  const editor = readFileSync(join(root, "web/components/WorkflowNodeProfileEditor.tsx"), "utf8");

  assert.match(editor, /data-testid=\{`workflow-profile-filter-\$\{props\.field\}`\}/);
  assert.match(editor, /field="skillRefs"/);
  assert.match(editor, /field="mcpGrantRefs"/);
  assert.match(editor, /field="toolGrantRefs"/);
  assert.match(editor, /field="vaultLeasePolicyRefs"/);
  assert.match(editor, /\/api\/models\?/);
  assert.match(editor, /piModelOptions/);
  assert.match(editor, /selectedProviderPiModelOptions/);
  assert.match(editor, /workflow-profile-model-custom/);
  assert.match(editor, /thinkingLevels/);
});

test("workflow node profile editor uses structured prompt editing and explains generated AGENTS.md", () => {
  const editor = readFileSync(join(root, "web/components/WorkflowNodeProfileEditor.tsx"), "utf8");

  assert.match(editor, /StructuredJsonEditor/);
  assert.match(editor, /data-testid="workflow-profile-prompt"/);
  assert.match(editor, /data-testid="workflow-profile-agents-md"/);
  assert.match(editor, /AGENTS\.md/);
  assert.match(editor, /nodePromptSpec/);
  assert.match(editor, /Profile instruction/);
});

test("workflow node click opens a usable static profile before planner draft exists", () => {
  const appShell = readFileSync(join(root, "web/components/AppShell.tsx"), "utf8");
  const tabBar = readFileSync(join(root, "web/components/TabBar.tsx"), "utf8");
  const staticProfile = readFileSync(join(root, "web/components/WorkflowStaticNodeProfile.tsx"), "utf8");

  assert.match(tabBar, /workflowStaticNodeProfile/);
  assert.match(appShell, /WorkflowStaticNodeProfile/);
  assert.match(appShell, /kind:\s*"workflowStaticNodeProfile"/);
  assert.match(appShell, /workflowNode:\s*node/);
  assert.doesNotMatch(appShell, /handleOpenWorkflowResource\(node\.profileResourcePath,\s*"profile\.json"\)/);
  assert.match(staticProfile, /Profile summary/);
  assert.match(staticProfile, /Draft this DAG to edit/);
});
