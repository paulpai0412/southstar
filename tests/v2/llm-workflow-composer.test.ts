import assert from "node:assert/strict";
import test from "node:test";
import type { CandidatePacket, CandidateSummary, WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { LlmWorkflowComposer, parseWorkflowCompositionPlanFromText } from "../../src/v2/orchestration/llm-composer.ts";

test("LLM composer sends bounded candidate packet and parses exactly one composition plan", async () => {
  const prompts: string[] = [];
  const composer = new LlmWorkflowComposer({
    model: "test-model",
    maxOutputChars: 20_000,
    client: {
      async generateText(input) {
        prompts.push(input.prompt);
        return JSON.stringify(validPlan());
      },
    },
  });

  const plan = await composer.compose({ goalPrompt: "implement calc sum", candidatePacket: candidatePacket() });
  assert.equal(plan.schemaVersion, "southstar.workflow_composition_plan.v1");
  assert.equal(plan.tasks[0]?.id, "understand-repo");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /select refs only from the candidate packet/i);
  assert.match(prompts[0] ?? "", /do not return markdown, comments, prose, or multiple JSON objects/i);
  assert.match(prompts[0] ?? "", /CandidatePacket:/);
  assert.match(prompts[0] ?? "", /template.keep-19/);
  assert.doesNotMatch(prompts[0] ?? "", /template.drop-20/);
  assert.match(prompts[0] ?? "", /artifact.keep-49/);
  assert.doesNotMatch(prompts[0] ?? "", /artifact.drop-50/);
  assert.match(prompts[0] ?? "", /policy.keep-49/);
  assert.doesNotMatch(prompts[0] ?? "", /policy.drop-50/);
  assert.match(prompts[0] ?? "", /agent-map\.keep-key-49/);
  assert.doesNotMatch(prompts[0] ?? "", /agent-map\.drop-key-50/);
  assert.match(prompts[0] ?? "", /agent-map-candidate\.keep-19/);
  assert.doesNotMatch(prompts[0] ?? "", /agent-map-candidate\.drop-20/);
  assert.match(prompts[0] ?? "", /profile-map\.keep-key-49/);
  assert.doesNotMatch(prompts[0] ?? "", /profile-map\.drop-key-50/);
  assert.match(prompts[0] ?? "", /skill-map\.keep-key-49/);
  assert.doesNotMatch(prompts[0] ?? "", /skill-map\.drop-key-50/);
  assert.match(prompts[0] ?? "", /tool-map\.keep-key-49/);
  assert.doesNotMatch(prompts[0] ?? "", /tool-map\.drop-key-50/);
  assert.match(prompts[0] ?? "", /mcp-map\.keep-key-49/);
  assert.doesNotMatch(prompts[0] ?? "", /mcp-map\.drop-key-50/);
  assert.match(prompts[0] ?? "", /vault-map\.keep-key-49/);
  assert.doesNotMatch(prompts[0] ?? "", /vault-map\.drop-key-50/);
  assert.match(prompts[0] ?? "", /vault-map-candidate\.keep-19/);
  assert.doesNotMatch(prompts[0] ?? "", /vault-map-candidate\.drop-20/);
  assert.match(prompts[0] ?? "", /instruction-map\.keep-key-49/);
  assert.doesNotMatch(prompts[0] ?? "", /instruction-map\.drop-key-50/);
  assert.match(prompts[0] ?? "", /evaluator-map\.keep-key-49/);
  assert.doesNotMatch(prompts[0] ?? "", /evaluator-map\.drop-key-50/);
});

test("LLM composer parser rejects non-JSON output", () => {
  assert.throws(
    () => parseWorkflowCompositionPlanFromText("Here is the plan: {}", 20_000),
    /LLM workflow composer returned non-JSON output/,
  );
});

test("LLM composer parser rejects arrays and wrong schema versions", () => {
  assert.throws(
    () => parseWorkflowCompositionPlanFromText("[]", 20_000),
    /must return a JSON object/,
  );
  assert.throws(
    () => parseWorkflowCompositionPlanFromText(JSON.stringify({ schemaVersion: "wrong", tasks: [] }), 20_000),
    /invalid schemaVersion/,
  );
});

test("LLM composer parser rejects oversized output", () => {
  assert.throws(
    () => parseWorkflowCompositionPlanFromText(JSON.stringify(validPlan()), 10),
    /exceeded max output size/,
  );
});

test("LLM composer parser rejects missing or invalid required top-level fields", () => {
  const { title: _title, ...withoutTitle } = validPlan();
  assert.throws(
    () => parseWorkflowCompositionPlanFromText(JSON.stringify(withoutTitle), 20_000),
    /title/,
  );
  assert.throws(
    () =>
      parseWorkflowCompositionPlanFromText(
        JSON.stringify({ ...validPlan(), selectedWorkflowTemplateRef: 123 }),
        20_000,
      ),
    /selectedWorkflowTemplateRef/,
  );
  assert.throws(
    () =>
      parseWorkflowCompositionPlanFromText(
        JSON.stringify({ ...validPlan(), rejectedCandidates: "invalid" }),
        20_000,
      ),
    /rejectedCandidates/,
  );
});

test("LLM composer parser rejects malformed task shape", () => {
  assert.throws(
    () =>
      parseWorkflowCompositionPlanFromText(
        JSON.stringify({
          ...validPlan(),
          tasks: [{ ...validPlan().tasks[0], dependsOn: "bad" }],
        }),
        20_000,
      ),
    /tasks\[0\]\.dependsOn/,
  );
  const { id: _id, ...withoutId } = validPlan().tasks[0];
  assert.throws(
    () =>
      parseWorkflowCompositionPlanFromText(
        JSON.stringify({
          ...validPlan(),
          tasks: [withoutId],
        }),
        20_000,
      ),
    /tasks\[0\]\.id/,
  );
});

function validPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Dynamic Mock Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "mock llm plan",
    tasks: [
      {
        id: "understand-repo",
        name: "Understand Repo",
        responsibility: "inspect repository",
        dependsOn: [],
        templateSlotRef: "understand",
        agentDefinitionRef: "agent.software-explorer",
        agentProfileRef: "profile.software-explorer-codex",
        instructionRefs: ["instruction.software-explorer"],
        skillRefs: ["skill.software-repo-discovery"],
        toolGrantRefs: ["tool.workspace-read"],
        mcpGrantRefs: [],
        vaultLeasePolicyRefs: [],
        inputArtifactRefs: [],
        outputArtifactRefs: ["artifact.implementation_plan"],
        evaluatorProfileRef: "evaluator.software-plan-quality",
        recoveryStrategyRefs: ["retry-same-agent"],
        rationale: "start with repository discovery",
      },
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function candidatePacket(): CandidatePacket {
  return {
    requirementSpec: {
      summary: "implement calc sum",
      workType: "software_feature",
      requiredCapabilities: ["capability.repo-read"],
      expectedArtifacts: ["artifact.implementation_plan"],
      acceptanceCriteria: ["calc sum works"],
      nonGoals: [],
      riskNotes: [],
      workspaceAssumptions: [],
      missingInputs: [],
    },
    workflowTemplateCandidates: [
      ...Array.from({ length: 20 }, (_value, index) => ({
        ref: `template.keep-${index}`,
        versionRef: `template.keep-${index}@v1`,
        kind: "workflow_template" as const,
        displayName: `Template Keep ${index}`,
        state: {},
        reason: "test",
      })),
      ...Array.from({ length: 3 }, (_value, index) => ({
        ref: `template.drop-${20 + index}`,
        versionRef: `template.drop-${20 + index}@v1`,
        kind: "workflow_template" as const,
        displayName: `Template Drop ${20 + index}`,
        state: {},
        reason: "test",
      })),
    ],
    agentCandidatesByCapability: candidateMap("agent-map", "agent-map-candidate", "agent_definition"),
    profileCandidatesByAgent: candidateMap("profile-map", "profile-map-candidate", "agent_profile"),
    skillCandidatesByProfile: candidateMap("skill-map", "skill-map-candidate", "skill_definition"),
    toolCandidatesByProfile: candidateMap("tool-map", "tool-map-candidate", "tool_definition"),
    mcpGrantCandidatesByProfile: candidateMap("mcp-map", "mcp-map-candidate", "mcp_tool_grant"),
    vaultLeaseCandidatesByProfile: candidateMap("vault-map", "vault-map-candidate", "vault_lease_policy"),
    instructionCandidatesByProfile: candidateMap("instruction-map", "instruction-map-candidate", "instruction_template"),
    artifactContractCandidates: [
      ...Array.from({ length: 50 }, (_value, index) => ({
        ref: `artifact.keep-${index}`,
        versionRef: `artifact.keep-${index}@v1`,
        kind: "artifact_contract" as const,
        displayName: `Artifact Keep ${index}`,
        state: {},
        reason: "test",
      })),
      ...Array.from({ length: 2 }, (_value, index) => ({
        ref: `artifact.drop-${50 + index}`,
        versionRef: `artifact.drop-${50 + index}@v1`,
        kind: "artifact_contract" as const,
        displayName: `Artifact Drop ${50 + index}`,
        state: {},
        reason: "test",
      })),
    ],
    evaluatorCandidatesByArtifact: candidateMap("evaluator-map", "evaluator-map-candidate", "evaluator_profile"),
    policyConstraints: [
      ...Array.from({ length: 50 }, (_value, index) => ({
        ref: `policy.keep-${index}`,
        versionRef: `policy.keep-${index}@v1`,
        kind: "policy_bundle" as const,
        displayName: `Policy Keep ${index}`,
        state: {},
        reason: "test",
      })),
      ...Array.from({ length: 2 }, (_value, index) => ({
        ref: `policy.drop-${50 + index}`,
        versionRef: `policy.drop-${50 + index}@v1`,
        kind: "policy_bundle" as const,
        displayName: `Policy Drop ${50 + index}`,
        state: {},
        reason: "test",
      })),
    ],
    unavailableRequirements: [],
  };
}

function candidateMap(
  mapPrefix: string,
  candidatePrefix: string,
  kind: CandidateSummary["kind"],
): Record<string, CandidateSummary[]> {
  const map: Record<string, CandidateSummary[]> = {};
  for (let index = 0; index < 52; index += 1) {
    const key = index < 50 ? `${mapPrefix}.keep-key-${index}` : `${mapPrefix}.drop-key-${index}`;
    map[key] = index === 0 ? overflowCandidates(candidatePrefix, kind) : [candidate(`${candidatePrefix}.key-${index}`, kind)];
  }
  return map;
}

function overflowCandidates(prefix: string, kind: CandidateSummary["kind"]): CandidateSummary[] {
  return [
    ...Array.from({ length: 20 }, (_value, index) => candidate(`${prefix}.keep-${index}`, kind)),
    ...Array.from({ length: 2 }, (_value, index) => candidate(`${prefix}.drop-${20 + index}`, kind)),
  ];
}

function candidate(ref: string, kind: CandidateSummary["kind"]): CandidateSummary {
  return {
    ref,
    versionRef: `${ref}@v1`,
    kind,
    displayName: ref,
    state: {},
    reason: "test",
  };
}
