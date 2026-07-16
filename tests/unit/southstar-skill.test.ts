import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

test("Southstar project skill is discoverable and documents the complete Pi flow", () => {
  const skill = source(".pi/skills/southstar/SKILL.md");

  assert.match(skill, /^---\nname: southstar\ndescription:/);
  assert.match(skill, /southstar\.workflow\.run_goal/);
  assert.match(skill, /southstar_workflow_run_goal/);
  assert.match(skill, /southstar\.workflow\.revise_requirement/);
  assert.match(skill, /southstar\.workflow\.confirm_requirements/);
  assert.match(skill, /southstar_workflow_confirm_goal_design/);
  assert.match(skill, /southstar_workflow_confirm_goal_design_stream/);
  assert.match(skill, /southstar_library_get_import_draft/);
  assert.match(skill, /auto_until_blocked/);
  assert.match(skill, /Goal.*Requirement.*Slice.*DAG.*Executor/si);
  assert.match(skill, /structuredContent/);
  assert.match(skill, /never invent/i);
});

test("/southstar is a Pi prompt alias that forwards the natural-language goal", () => {
  const prompt = source(".pi/prompts/southstar.md");

  assert.match(prompt, /description:/);
  assert.match(prompt, /loaded Southstar skill/i);
  assert.doesNotMatch(prompt, /\.pi\/skills\/southstar\/SKILL\.md/);
  assert.match(prompt, /\$@/);
});

test("Pi Chat sessions load the bundled Southstar prompt and skill for every consumer workspace", () => {
  const manager = source("web/lib/rpc-manager.ts");

  assert.match(manager, /DefaultResourceLoader/);
  assert.match(manager, /additionalSkillPaths:[\s\S]*\.pi[\s\S]*skills[\s\S]*southstar/);
  assert.match(manager, /additionalPromptTemplatePaths:[\s\S]*\.pi[\s\S]*prompts[\s\S]*southstar\.md/);
  assert.match(manager, /resourceLoader/);
});

test("Southstar exposes one high-level goal execution tool to Pi", () => {
  const registry = source("src/v2/mcp/tool-registry.ts");
  const client = source("src/v2/server/client.ts");

  assert.match(registry, /southstar\.workflow\.run_goal/);
  assert.match(registry, /southstar\.workflow\.revise_requirement/);
  assert.match(registry, /southstar\.workflow\.confirm_requirements/);
  assert.match(registry, /southstar\.workflow\.confirm_goal_design/);
  assert.match(registry, /southstar\.workflow\.confirm_goal_design_stream/);
  assert.match(registry, /southstar\.library\.get_import_draft/);
  assert.match(client, /runGoalStream\(/);
  assert.match(client, /confirmGoalDesign\(/);
  assert.match(client, /confirmGoalDesignStream\(/);
  assert.match(client, /getLibraryImportDraft\(/);
  assert.match(registry, /goalDesignMode/);
  assert.match(registry, /templatePolicy/);
});

test("Chat renders structured goal, slice, and DAG results returned by the Pi tool", () => {
  const messageView = source("web/components/MessageView.tsx");

  assert.match(messageView, /goalRequirementsFromSouthstarToolResult/);
  assert.match(messageView, /goalDesignFromSouthstarToolResult/);
  assert.match(messageView, /<GoalRequirementListBlock/);
  assert.match(messageView, /<GoalSlicePlanBlock/);
  assert.match(messageView, /workflowDagFromSouthstarToolResult/);
  assert.match(messageView, /<details open/);
  assert.match(messageView, /SouthstarResultBox/);
});
