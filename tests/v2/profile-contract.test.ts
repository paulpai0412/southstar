import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveAgentProfile,
  materializeAgentProfile,
  normalizeAgentProfileOverride,
} from "../../src/v2/design-library/profile-composer/profile-contract.ts";
import type { AgentProfile } from "../../src/v2/design-library/runtime-types.ts";

const profile: AgentProfile = {
  id: "profile.base",
  name: "Base",
  provider: "pi",
  model: "base-model",
  thinkingLevel: "low",
  instruction: "base instruction",
  harnessRef: "harness.base",
  agentsMdRefs: [],
  promptTemplateRef: "instruction.base",
  skillRefs: ["skill.base"],
  mcpGrantRefs: ["mcp.base"],
  memoryScopes: [],
  contextPolicyRef: "context.base",
  sessionPolicyRef: "session.base",
  toolPolicy: { allowedTools: ["tool.base"], deniedTools: [], requiresApprovalFor: [] },
  budgetPolicy: { maxInputTokens: 100, maxOutputTokens: 100 },
};

test("profile contract normalizes, projects, and materializes one override semantics", () => {
  const override = normalizeAgentProfileOverride({
    harnessRef: "harness.override",
    model: "override-model",
    instruction: "  override instruction  ",
    skillRefs: ["skill.override", "skill.override"],
  });
  const effective = effectiveAgentProfile({
    agentProfile: profile,
    task: { skillRefs: ["skill.compiled"], mcpGrantRefs: ["mcp.compiled"] },
    profileOverride: override,
  });
  assert.deepEqual(effective, {
    harnessRef: "harness.override",
    provider: "pi",
    model: "override-model",
    thinkingLevel: "low",
    instruction: "override instruction",
    skillRefs: ["skill.override"],
    mcpGrantRefs: ["mcp.compiled"],
    toolGrantRefs: ["tool.base"],
    vaultLeasePolicyRefs: [],
  });

  const materialized = materializeAgentProfile(profile, override, "task-1", "Implement");
  assert.equal(materialized.id, "profile.base__task-1__override");
  assert.equal(materialized.harnessRef, "harness.override");
  assert.deepEqual(materialized.skillRefs, ["skill.override"]);
  assert.deepEqual(profile.skillRefs, ["skill.base"]);
});

test("profile contract fails closed for unsupported provider and malformed refs", () => {
  assert.throws(() => normalizeAgentProfileOverride({ provider: "not-a-provider" }), /unsupported provider/);
  assert.throws(() => normalizeAgentProfileOverride({ skillRefs: "skill" }), /skillRefs must be an array/);
});
