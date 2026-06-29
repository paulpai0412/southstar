import test from "node:test";
import assert from "node:assert/strict";
import { buildNodeProfilePatchPayload, normalizeNodeProfileForm } from "../../web/lib/workflow/node-profile";

test("normalizeNodeProfileForm prefers effective profile and preserves selected refs", () => {
  const form = normalizeNodeProfileForm({
    selectedDefinition: {
      taskId: "task-build",
      taskName: "Build",
      agentProfileRef: "software-maker-pi",
      skillRefs: ["software.calc-cli"],
      mcpGrantRefs: [],
      effectiveProfile: {
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Use tests.",
        skillRefs: ["software.calc-cli", "software.test-evidence"],
        mcpGrantRefs: ["filesystem-workspace"],
      },
      editable: true,
    },
  });

  assert.equal(form.provider, "codex");
  assert.equal(form.model, "gpt-5-codex");
  assert.equal(form.thinkingLevel, "high");
  assert.equal(form.instruction, "Use tests.");
  assert.deepEqual(form.skillRefs, ["software.calc-cli", "software.test-evidence"]);
  assert.deepEqual(form.mcpGrantRefs, ["filesystem-workspace"]);
});

test("buildNodeProfilePatchPayload trims and de-duplicates arrays", () => {
  assert.deepEqual(buildNodeProfilePatchPayload({
    provider: "codex",
    model: " gpt-5-codex ",
    thinkingLevel: " high ",
    instruction: " Use tests. ",
    skillRefs: ["software.calc-cli", "software.calc-cli", ""],
    mcpGrantRefs: ["filesystem-workspace", " "],
  }), {
    provider: "codex",
    model: "gpt-5-codex",
    thinkingLevel: "high",
    instruction: "Use tests.",
    skillRefs: ["software.calc-cli"],
    mcpGrantRefs: ["filesystem-workspace"],
  });
});
