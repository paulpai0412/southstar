import test from "node:test";
import assert from "node:assert/strict";
import { buildNodeProfilePatchPayload, formEquals, normalizeNodeProfileForm } from "../../web/lib/workflow/node-profile";

test("normalizeNodeProfileForm prefers effective profile and preserves selected refs", () => {
  const form = normalizeNodeProfileForm({
    selectedDefinition: {
      taskId: "task-build",
      taskName: "Build",
      agentProfileRef: "software-maker-pi",
      skillRefs: ["software.calc-cli"],
      mcpGrantRefs: [],
      effectiveProfile: {
        harnessRef: "codex",
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Use tests.",
        skillRefs: ["software.calc-cli", "software.test-evidence"],
        mcpGrantRefs: ["filesystem-workspace"],
        toolGrantRefs: ["tool.workspace-write"],
        vaultLeasePolicyRefs: ["vault.github-write-token"],
        nodePromptSpec: {
          nodeType: "implement",
          goal: "Build the feature",
        },
      },
      editable: true,
    },
  });

  assert.equal(form.harnessRef, "codex");
  assert.equal(form.provider, "codex");
  assert.equal(form.model, "gpt-5-codex");
  assert.equal(form.thinkingLevel, "high");
  assert.equal(form.instruction, "Use tests.");
  assert.deepEqual(form.skillRefs, ["software.calc-cli", "software.test-evidence"]);
  assert.deepEqual(form.mcpGrantRefs, ["filesystem-workspace"]);
  assert.deepEqual(form.toolGrantRefs, ["tool.workspace-write"]);
  assert.deepEqual(form.vaultLeasePolicyRefs, ["vault.github-write-token"]);
  assert.match(form.nodePromptSpec, /"goal": "Build the feature"/);
});

test("buildNodeProfilePatchPayload trims and de-duplicates arrays", () => {
  assert.deepEqual(buildNodeProfilePatchPayload({
    harnessRef: " codex ",
    provider: "codex",
    model: " gpt-5-codex ",
    thinkingLevel: " high ",
    instruction: " Use tests. ",
    skillRefs: ["software.calc-cli", "software.calc-cli", ""],
    mcpGrantRefs: ["filesystem-workspace", " "],
    toolGrantRefs: ["tool.workspace-write", "tool.workspace-write"],
    vaultLeasePolicyRefs: ["vault.github-write-token", ""],
    nodePromptSpec: '{ "nodeType": "implement", "goal": "Build" }',
  }), {
    harnessRef: "codex",
    provider: "codex",
    model: "gpt-5-codex",
    thinkingLevel: "high",
    instruction: "Use tests.",
    skillRefs: ["software.calc-cli"],
    mcpGrantRefs: ["filesystem-workspace"],
    toolGrantRefs: ["tool.workspace-write"],
    vaultLeasePolicyRefs: ["vault.github-write-token"],
    nodePromptSpec: { nodeType: "implement", goal: "Build" },
  });
});

test("formEquals tolerates invalid node prompt JSON while the user is editing", () => {
  const base = {
    harnessRef: "",
    provider: "",
    model: "",
    thinkingLevel: "",
    instruction: "",
    skillRefs: [],
    mcpGrantRefs: [],
    toolGrantRefs: [],
    vaultLeasePolicyRefs: [],
    nodePromptSpec: '{ "nodeType": ',
  };

  assert.equal(formEquals(base, { ...base }), true);
  assert.equal(formEquals(base, { ...base, nodePromptSpec: '{ "nodeType": "implement" }' }), false);
});
