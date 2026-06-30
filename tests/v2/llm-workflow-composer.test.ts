import assert from "node:assert/strict";
import test from "node:test";
import type { CandidatePacket, CandidateSummary, WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import {
  LlmComposerOutputError,
  LlmWorkflowComposer,
  parseWorkflowCompositionPlanFromText,
  WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA,
} from "../../src/v2/orchestration/llm-composer.ts";

test("LLM composer sends bounded candidate packet and explicit output schema contract", async () => {
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
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /OutputJsonSchema:/);
  assert.match(prompts[0] ?? "", /Do not use alias fields/i);
  assert.match(prompts[0] ?? "", /SkillGuidance:/);
  assert.match(prompts[0] ?? "", /smallest sufficient DAG/i);
  assert.match(prompts[0] ?? "", /skill-map-candidate\.keep-0 profile=skill-map\.keep-key-0 role=explorer artifacts=artifact\.implementation_plan/);
  assert.match(prompts[0] ?? "", /CandidatePacket:/);
  assert.match(prompts[0] ?? "", /template.keep-19/);
  assert.doesNotMatch(prompts[0] ?? "", /template.drop-20/);
  assert.match(prompts[0] ?? "", /artifact.keep-49/);
  assert.doesNotMatch(prompts[0] ?? "", /artifact.drop-50/);
  assert.match(prompts[0] ?? "", /policy.keep-49/);
  assert.doesNotMatch(prompts[0] ?? "", /policy.drop-50/);
  assert.match(prompts[0] ?? "", /\"additionalProperties\":false/);
  assert.match(prompts[0] ?? "", /\"schemaVersion\":\{\"const\":\"southstar.workflow_composition_plan.v1\"\}/);
  assert.equal(typeof WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA.$defs.task.properties.id.type, "string");
});


test("LLM composer uses streaming text client and relays true deltas", async () => {
  const deltas: string[] = [];
  const composer = new LlmWorkflowComposer({
    model: "stream-model",
    client: {
      async generateText() {
        throw new Error("generateText should not be used when generateTextStream is available");
      },
      async generateTextStream(input, handlers) {
        assert.equal(input.model, "stream-model");
        handlers.onDelta?.("{");
        handlers.onDelta?.("\"schemaVersion\"");
        return JSON.stringify(validPlan());
      },
    },
  });

  const plan = await composer.compose({
    goalPrompt: "implement calc sum",
    candidatePacket: candidatePacket(),
    onLlmDelta(delta) {
      deltas.push(delta);
    },
  });

  assert.equal(plan.schemaVersion, "southstar.workflow_composition_plan.v1");
  assert.deepEqual(deltas, ["{", "\"schemaVersion\""]);
});

test("LLM composer parser accepts strict contract payload", () => {
  const parsed = parseWorkflowCompositionPlanFromText(JSON.stringify(validPlan()), 20_000);
  assert.equal(parsed.title, "Dynamic Mock Plan");
  assert.deepEqual(parsed.tasks.map((task) => task.id), [
    "understand-repo",
    "review-spec",
    "implement-feature",
    "verify-feature",
    "review-code-quality",
    "summarize-completion",
  ]);
});

test("LLM composer parser rejects oversized output", () => {
  assert.throws(
    () => parseWorkflowCompositionPlanFromText(JSON.stringify(validPlan()), 10),
    (error: unknown) =>
      error instanceof LlmComposerOutputError
      && error.issues[0]?.code === "composer_output_too_large",
  );
});

test("LLM composer parser rejects non-json output", () => {
  assert.throws(
    () => parseWorkflowCompositionPlanFromText("Here is the plan: {}", 20_000),
    (error: unknown) =>
      error instanceof LlmComposerOutputError
      && error.issues[0]?.code === "composer_output_non_json",
  );
});

test("LLM composer parser rejects invalid json", () => {
  assert.throws(
    () => parseWorkflowCompositionPlanFromText("{bad-json", 20_000),
    (error: unknown) =>
      error instanceof LlmComposerOutputError
      && error.issues[0]?.code === "composer_output_invalid_json",
  );
});

test("LLM composer parser rejects alias-based payload instead of patching it", () => {
  assert.throws(
    () =>
      parseWorkflowCompositionPlanFromText(
        JSON.stringify({
          schemaVersion: "southstar.workflow_composition_plan.v1",
          title: "alias payload",
          selectedWorkflowTemplateRef: "template.software-feature",
          rationale: "alias",
          taskGraph: [
            {
              id: "task_a",
              agentRef: "agent.software-explorer",
              profileRef: "profile.software-explorer-codex",
            },
          ],
          rejectedCandidates: [],
          generatedComponentProposals: [],
        }),
        20_000,
      ),
    (error: unknown) =>
      error instanceof LlmComposerOutputError
      && error.issues.some((issue) => issue.code === "composer_output_schema_violation" && issue.path === "$.taskGraph"),
  );
});

test("LLM composer parser rejects unexpected properties in task", () => {
  const plan = validPlan();
  const task = { ...plan.tasks[0], aliasField: "nope" };
  assert.throws(
    () =>
      parseWorkflowCompositionPlanFromText(
        JSON.stringify({
          ...plan,
          tasks: [task, ...plan.tasks.slice(1)],
        }),
        20_000,
      ),
    (error: unknown) =>
      error instanceof LlmComposerOutputError
      && error.issues.some((issue) => issue.path === "tasks.0.aliasField"),
  );
});

test("LLM composer parser rejects invalid task field types", () => {
  const plan = validPlan();
  assert.throws(
    () =>
      parseWorkflowCompositionPlanFromText(
        JSON.stringify({
          ...plan,
          tasks: [{ ...plan.tasks[0], dependsOn: "implement-feature" }],
        }),
        20_000,
      ),
    (error: unknown) =>
      error instanceof LlmComposerOutputError
      && error.issues.some((issue) => issue.path === "tasks.0.dependsOn"),
  );
});

function validPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Dynamic Mock Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "mock llm plan",
    tasks: [
      task(
        "understand-repo",
        [],
        "agent.software-explorer",
        "profile.software-explorer-codex",
        ["skill.software-repo-discovery"],
        ["tool.workspace-read"],
        ["instruction.software-explorer"],
        ["artifact.implementation_plan"],
        "evaluator.software-plan-quality",
      ),
      task(
        "review-spec",
        ["understand-repo"],
        "agent.software-spec-reviewer",
        "profile.software-spec-reviewer-codex",
        ["skill.software-spec-review"],
        ["tool.workspace-read"],
        ["instruction.software-spec-reviewer"],
        ["artifact.implementation_plan"],
        "evaluator.software-plan-quality",
      ),
      task(
        "implement-feature",
        ["review-spec"],
        "agent.software-maker",
        "profile.software-maker-pi",
        ["skill.software-implementation"],
        ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
        ["instruction.software-maker"],
        ["artifact.implementation_report"],
        "evaluator.software-feature-quality",
      ),
      task(
        "verify-feature",
        ["implement-feature"],
        "agent.software-checker",
        "profile.software-checker-codex",
        ["skill.software-verification"],
        ["tool.workspace-read", "tool.shell-command"],
        ["instruction.software-checker"],
        ["artifact.verification_report"],
        "evaluator.software-verification-quality",
      ),
      task(
        "review-code-quality",
        ["implement-feature"],
        "agent.software-code-quality-reviewer",
        "profile.software-code-quality-reviewer-codex",
        ["skill.software-code-quality-review"],
        ["tool.workspace-read", "tool.shell-command"],
        ["instruction.software-code-quality-reviewer"],
        ["artifact.verification_report"],
        "evaluator.software-verification-quality",
      ),
      task(
        "summarize-completion",
        ["verify-feature", "review-code-quality"],
        "agent.software-summarizer",
        "profile.software-summarizer-codex",
        ["skill.software-summary"],
        ["tool.workspace-read"],
        ["instruction.software-summarizer"],
        ["artifact.completion_report"],
        "evaluator.software-completion-quality",
      ),
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function task(
  id: string,
  dependsOn: string[],
  agentDefinitionRef: string,
  agentProfileRef: string,
  skillRefs: string[],
  toolGrantRefs: string[],
  instructionRefs: string[],
  outputArtifactRefs: string[],
  evaluatorProfileRef: string,
) {
  return {
    id,
    name: id,
    responsibility: id,
    dependsOn,
    templateSlotRef: id,
    agentDefinitionRef,
    agentProfileRef,
    instructionRefs,
    skillRefs,
    toolGrantRefs,
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
    inputArtifactRefs: [],
    outputArtifactRefs,
    evaluatorProfileRef,
    recoveryStrategyRefs: ["retry-same-agent"],
    rationale: id,
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
      ...Array.from({ length: 20 }, (_value, index) => candidate(`template.keep-${index}`, "workflow_template")),
      ...Array.from({ length: 3 }, (_value, index) => candidate(`template.drop-${20 + index}`, "workflow_template")),
    ],
    agentCandidatesByCapability: candidateMap("agent-map", "agent-map-candidate", "agent_definition"),
    profileCandidatesByAgent: candidateMap("profile-map", "profile-map-candidate", "agent_profile"),
    skillCandidatesByProfile: candidateMap("skill-map", "skill-map-candidate", "skill_definition"),
    toolCandidatesByProfile: candidateMap("tool-map", "tool-map-candidate", "tool_definition"),
    mcpGrantCandidatesByProfile: candidateMap("mcp-map", "mcp-map-candidate", "mcp_tool_grant"),
    vaultLeaseCandidatesByProfile: candidateMap("vault-map", "vault-map-candidate", "vault_lease_policy"),
    instructionCandidatesByProfile: candidateMap("instruction-map", "instruction-map-candidate", "instruction_template"),
    artifactContractCandidates: [
      ...Array.from({ length: 50 }, (_value, index) => candidate(`artifact.keep-${index}`, "artifact_contract")),
      ...Array.from({ length: 2 }, (_value, index) => candidate(`artifact.drop-${50 + index}`, "artifact_contract")),
    ],
    evaluatorCandidatesByArtifact: candidateMap("evaluator-map", "evaluator-map-candidate", "evaluator_profile"),
    policyConstraints: [
      ...Array.from({ length: 50 }, (_value, index) => candidate(`policy.keep-${index}`, "policy_bundle")),
      ...Array.from({ length: 2 }, (_value, index) => candidate(`policy.drop-${50 + index}`, "policy_bundle")),
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
    state: candidateState(ref, kind),
    reason: "test",
  };
}

function candidateState(ref: string, kind: CandidateSummary["kind"]): Record<string, unknown> {
  if (kind === "skill_definition" && ref.endsWith(".keep-0")) {
    return {
      role: "explorer",
      instructions: "Workflow composition guidance: start from the smallest sufficient DAG and add review or summary tasks only when risk justifies them.",
      artifactContracts: ["artifact.implementation_plan"],
    };
  }
  return {};
}
