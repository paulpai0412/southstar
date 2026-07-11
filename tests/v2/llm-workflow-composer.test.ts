import assert from "node:assert/strict";
import test from "node:test";
import type { CandidatePacket, CandidateSummary, GeneratedAgentProfile, WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import {
  LlmComposerOutputError,
  LlmWorkflowComposer,
  parseWorkflowCompositionPlanFromText,
  WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA,
} from "../../src/v2/orchestration/llm-composer.ts";
import { softwareGoalContract } from "./fixtures/goal-contract.ts";

const GOAL_CONTRACT = softwareGoalContract();

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

  const plan = await composer.compose({
    goalPrompt: "implement calc sum",
    goalContract: GOAL_CONTRACT,
    candidatePacket: candidatePacket(),
  });
  assert.equal(plan.schemaVersion, "southstar.workflow_composition_plan.v1");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /OutputJsonSchema:/);
  assert.match(prompts[0] ?? "", /Do not use alias fields/i);
  assert.doesNotMatch(prompts[0] ?? "", /SkillGuidance:/);
  assert.match(prompts[0] ?? "", /DagAndAgentProfileSop:/);
  assert.match(prompts[0] ?? "", /Choose task count and workerKind dynamically/i);
  assert.match(prompts[0] ?? "", /do not pre-add repair\/reverify nodes/i);
  assert.match(prompts[0] ?? "", /Runtime dynamic repair request goals, generate only the additional bounded repair and reverify tasks/i);
  assert.match(prompts[0] ?? "", /repair task must use workerKind=repair_worker/i);
  assert.match(prompts[0] ?? "", /reverify task must use workerKind=validation_worker/i);
  assert.match(prompts[0] ?? "", /agentProfile\.execution must include all Docker\/Tork worker input/);
  assert.match(prompts[0] ?? "", /provider=pi, harnessRef=pi, and model=pi-agent-default/i);
  assert.match(prompts[0] ?? "", /Never pair provider=codex or harnessRef=codex with southstar\/pi-agent:local/i);
  assert.doesNotMatch(prompts[0] ?? "", /agentSpec/);
  assert.match(prompts[0] ?? "", /GraphMetadataCandidates:/);
  assert.match(prompts[0] ?? "", /Use GraphMetadataCandidates as the direct source of selectable refs/);
  assert.match(prompts[0] ?? "", /agent\.frontend-developer/);
  assert.match(prompts[0] ?? "", /uses/);
  assert.match(prompts[0] ?? "", /ProfilePrimitiveCandidates:/);
  assert.match(prompts[0] ?? "", /"agents":\["agent\.frontend-developer"\]/);
  assert.match(prompts[0] ?? "", /CandidatePacketSummary:/);
  assert.match(prompts[0] ?? "", /template.keep-19/);
  assert.doesNotMatch(prompts[0] ?? "", /template.drop-20/);
  assert.match(prompts[0] ?? "", /artifact.keep-49/);
  assert.doesNotMatch(prompts[0] ?? "", /artifact.drop-50/);
  assert.match(prompts[0] ?? "", /policy.keep-49/);
  assert.doesNotMatch(prompts[0] ?? "", /policy.drop-50/);
  assert.doesNotMatch(prompts[0] ?? "", /CandidatePacketSummary:[\s\S]*graphMetadataCandidates/);
  assert.match(prompts[0] ?? "", /"graphMetadataCandidateCounts":\{"nodes":6,"edges":5\}/);
  assert.match(prompts[0] ?? "", /\"additionalProperties\":false/);
  assert.match(prompts[0] ?? "", /\"schemaVersion\":\{\"const\":\"southstar.workflow_composition_plan.v1\"\}/);
  assert.match(prompts[0] ?? "", /nodePromptSpec/);
  assert.match(prompts[0] ?? "", /acceptanceCriteria/);
  assert.match(prompts[0] ?? "", /GoalContractRequirements:/);
  assert.match(prompts[0] ?? "", new RegExp(GOAL_CONTRACT.requirements[0]!.id));
  assert.match(prompts[0] ?? "", /turn each observable requirement into one or more executable producer work packages/i);
  assert.match(prompts[0] ?? "", /preserve independent branches as tasks without artificial dependencies/i);
  assert.match(prompts[0] ?? "", /producer tasks are dependency-independent unless a declared input artifact requires ordering/i);
  assert.match(prompts[0] ?? "", /shared integration or evaluator task depends on every producer branch it evaluates/i);
  assert.match(prompts[0] ?? "", /state or artifact owner/i);
  assert.match(prompts[0] ?? "", /same atomic consistency boundary/i);
  assert.match(prompts[0] ?? "", /do not create a catch-all producer/i);
  assert.match(prompts[0] ?? "", /dependency is valid only when the consumer names an upstream outputArtifactRef in inputArtifactRefs/i);
  assert.match(prompts[0] ?? "", /never force one task per requirement/i);
  assert.match(prompts[0] ?? "", /independent evaluator/i);
  assert.equal(typeof WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA.$defs.task.properties.id.type, "string");
  assert.equal(WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA.$defs.task.properties.requirementIds.type, "array");
  assert.equal("minItems" in WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA.$defs.task.properties.requirementIds, false);
  assert.equal(
    WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA.$defs.task.required.includes("requirementIds"),
    true,
  );
  assert.equal(
    WORKFLOW_COMPOSITION_PLAN_JSON_SCHEMA.$defs.task.required.includes("nodePromptSpec"),
    true,
  );
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
    goalContract: GOAL_CONTRACT,
    candidatePacket: candidatePacket(),
    onLlmDelta(delta) {
      deltas.push(delta);
    },
  });

  assert.equal(plan.schemaVersion, "southstar.workflow_composition_plan.v1");
  assert.deepEqual(deltas, ["{", "\"schemaVersion\""]);
});

test("LLM composer forwards requested cwd to the text client", async () => {
  let receivedCwd: string | undefined;
  const composer = new LlmWorkflowComposer({
    model: "cwd-aware-model",
    client: {
      async generateText(input) {
        receivedCwd = input.cwd;
        return JSON.stringify(validPlan());
      },
    },
  });

  await composer.compose({
    goalPrompt: "implement feature in selected project",
    goalContract: GOAL_CONTRACT,
    candidatePacket: candidatePacket(),
    cwd: "/home/timmypai/apps/southstar-vocab",
  });

  assert.equal(receivedCwd, "/home/timmypai/apps/southstar-vocab");
});

test("LLM composer parser accepts strict contract payload", () => {
  const parsed = parseWorkflowCompositionPlanFromText(JSON.stringify(validPlan()), 20_000);
  assert.equal(parsed.title, "Dynamic Mock Plan");
  assert.deepEqual(parsed.tasks.map((task) => task.id), [
    "understand-repo",
    "implement-feature",
    "verify-feature",
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

test("LLM composer parser rejects Codex profiles on the Pi agent runtime image", () => {
  const plan = validPlan();
  const profile = plan.generatedComponentProposals[0]!.agentProfile!;
  profile.provider = "codex";
  profile.model = "gpt-5-codex";
  profile.harnessRef = "codex";

  assert.throws(
    () => parseWorkflowCompositionPlanFromText(JSON.stringify(plan), 20_000),
    (error: unknown) =>
      error instanceof LlmComposerOutputError
      && error.issues.some((issue) =>
        issue.code === "composer_output_schema_violation"
        && issue.path === "generatedComponentProposals.0.agentProfile.harnessRef"
      ),
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

test("LLM composer parser rejects tasks without node prompt specs", () => {
  const plan = validPlan();
  const { nodePromptSpec: _nodePromptSpec, ...taskWithoutPromptSpec } = plan.tasks[0] as Record<string, unknown>;

  assert.throws(
    () =>
      parseWorkflowCompositionPlanFromText(
        JSON.stringify({
          ...plan,
          tasks: [taskWithoutPromptSpec, ...plan.tasks.slice(1)],
        }),
        20_000,
      ),
    (error: unknown) =>
      error instanceof LlmComposerOutputError
      && error.issues.some((issue) =>
        issue.path === "tasks.0.nodePromptSpec"
        && /missing required property/.test(issue.message)
      ),
  );
});

test("LLM composer parser rejects tasks without requirement ids", () => {
  const plan = validPlan();
  const { requirementIds: _requirementIds, ...taskWithoutRequirementIds } = plan.tasks[0] as Record<string, unknown>;

  assert.throws(
    () => parseWorkflowCompositionPlanFromText(JSON.stringify({
      ...plan,
      tasks: [taskWithoutRequirementIds, ...plan.tasks.slice(1)],
    }), 20_000),
    (error: unknown) =>
      error instanceof LlmComposerOutputError
      && error.issues.some((issue) =>
        issue.path === "tasks.0.requirementIds"
        && /missing required property/.test(issue.message)
      ),
  );
});

test("LLM composer parser allows an explicit summary task with empty requirement ids", () => {
  const plan = validPlan();
  plan.tasks[0]!.requirementIds = [];
  plan.tasks[0]!.nodePromptSpec!.nodeType = "summary";
  plan.tasks[0]!.nodePromptSpec!.summarySections = ["completed work"];
  plan.tasks[0]!.nodePromptSpec!.handoffCriteria = ["Final state is clear."];

  assert.doesNotThrow(() => parseWorkflowCompositionPlanFromText(JSON.stringify(plan), 20_000));
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
        "agent.frontend-developer",
        "generated.profile.vocab-feature-executor",
        ["skill.react-ui"],
        ["tool.workspace-read"],
        ["instruction.software-explorer"],
        ["artifact.implementation_plan"],
        "evaluator.software-plan-quality",
      ),
      task(
        "implement-feature",
        ["understand-repo"],
        "agent.frontend-developer",
        "generated.profile.vocab-feature-executor",
        ["skill.react-ui"],
        ["tool.workspace-write"],
        ["instruction.software-maker"],
        ["artifact.implementation_report"],
        "evaluator.software-feature-quality",
      ),
      task(
        "verify-feature",
        ["implement-feature"],
        "agent.frontend-developer",
        "generated.profile.vocab-feature-validator",
        ["skill.react-ui"],
        ["tool.workspace-read"],
        ["instruction.software-checker"],
        ["artifact.verification_report"],
        "evaluator.software-verification-quality",
      ),
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [
      generatedProfileProposal(
        "generated.profile.vocab-feature-executor",
        agentProfile("execution_worker", ["tool.workspace-read", "tool.workspace-write"]),
      ),
      generatedProfileProposal(
        "generated.profile.vocab-feature-validator",
        agentProfile("validation_worker", ["tool.workspace-read"]),
      ),
    ],
  };
}

function generatedProfileProposal(id: string, spec: GeneratedAgentProfile) {
  return {
    id,
    kind: "agent_profile" as const,
    risk: "low" as const,
    reason: `generated ${id}`,
    validationStatus: "validated" as const,
    agentProfile: spec,
  };
}

function agentProfile(workerKind: GeneratedAgentProfile["workerKind"], allowedTools: string[]): GeneratedAgentProfile {
  return {
    workerKind,
    provider: "pi",
    model: "pi-agent-default",
    thinkingLevel: workerKind === "validation_worker" ? "minimal" : "medium",
    harnessRef: "pi",
    instruction: `${workerKind} for the requested feature. Use selected graph-backed skills and tools only.`,
    promptTemplateRef: "instruction.software-maker",
    contextPolicyRef: "context.generated",
    sessionPolicyRef: "session.generated",
    memoryScopes: [],
    agentsMdRefs: ["AGENTS.md"],
    vaultLeasePolicyRefs: [],
    toolPolicy: {
      allowedTools,
      deniedTools: [],
      requiresApprovalFor: [],
    },
    budgetPolicy: {
      maxInputTokens: 120000,
      maxOutputTokens: 8192,
      maxWallTimeSeconds: 3600,
    },
    execution: {
      engine: "tork",
      image: "southstar/pi-agent:local",
      command: ["southstar-agent-runner"],
      env: {},
      mounts: [],
      timeoutSeconds: 3600,
      infraRetry: { maxAttempts: 1 },
    },
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
    requirementIds: GOAL_CONTRACT.requirements.map((requirement) => requirement.id),
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
    nodePromptSpec: {
      nodeType: id.includes("verify") ? "verify" : id.includes("understand") ? "plan" : "implement",
      goal: `Complete ${id} for the requested feature.`,
      requirements: [`Satisfy the user goal for ${id}.`],
      boundaries: ["Work only inside the mounted workspace.", "Do not modify Southstar runtime internals."],
      nonGoals: ["Do not perform unrelated refactors."],
      deliverableDocuments: [{
        kind: id.includes("verify") ? "verification" : id.includes("understand") ? "design" : "implementation",
        title: `${id} document`,
        required: true,
        format: "markdown",
        description: `Document the ${id} result for downstream nodes.`,
      }],
      expectedOutputs: outputArtifactRefs,
      testCases: [{
        name: `${id} acceptance check`,
        command: "npm test",
        expected: "Relevant tests pass or a clear blocker report is produced.",
      }],
      acceptanceCriteria: [`${id} produces ${outputArtifactRefs.join(", ")}.`],
      ...(id.includes("verify") ? { verificationChecks: ["Run the selected verification checks and inspect the result."] } : {}),
      ...(id.includes("understand") ? { planningQuestions: ["What needs to change?"], decisionCriteria: ["Plan is scoped and testable."] } : {}),
      ...(id.includes("implement") ? { implementationScope: ["Implement the requested feature behavior."] } : {}),
      failureReportContract: "Return blocker, evidence, and next repair action when the task cannot be completed.",
    },
    rationale: id,
  } as unknown as WorkflowCompositionPlan["tasks"][number];
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
    profileCandidatesByAgent: {},
    skillCandidatesByProfile: {},
    toolCandidatesByProfile: {},
    mcpGrantCandidatesByProfile: {},
    vaultLeaseCandidatesByProfile: {},
    instructionCandidatesByProfile: {},
    artifactContractCandidates: [
      ...Array.from({ length: 50 }, (_value, index) => candidate(`artifact.keep-${index}`, "artifact_contract")),
      ...Array.from({ length: 2 }, (_value, index) => candidate(`artifact.drop-${50 + index}`, "artifact_contract")),
    ],
    evaluatorCandidatesByArtifact: candidateMap("evaluator-map", "evaluator-map-candidate", "evaluator_profile"),
    policyConstraints: [
      ...Array.from({ length: 50 }, (_value, index) => candidate(`policy.keep-${index}`, "policy_bundle")),
      ...Array.from({ length: 2 }, (_value, index) => candidate(`policy.drop-${50 + index}`, "policy_bundle")),
    ],
    graphMetadataCandidates: {
      schemaVersion: "southstar.graph_metadata_candidates.v1",
      scope: "software",
      nodes: [
        { ref: "agent.frontend-developer", kind: "agent_definition", status: "approved", versionRef: "agent.frontend-developer@1", scope: "software", title: "Frontend Developer", aliases: [] },
        { ref: "skill.react-ui", kind: "skill_spec", status: "approved", versionRef: "skill.react-ui@1", scope: "software", title: "React UI", aliases: [] },
        { ref: "tool.workspace-read", kind: "tool_definition", status: "approved", versionRef: "tool.workspace-read@1", scope: "global", title: "Workspace Read", aliases: [] },
        { ref: "tool.workspace-write", kind: "tool_definition", status: "approved", versionRef: "tool.workspace-write@1", scope: "global", title: "Workspace Write", aliases: [] },
        { ref: "instruction.software-maker", kind: "instruction_template", status: "approved", versionRef: "instruction.software-maker@1", scope: "software", title: "Software Maker", aliases: [] },
        { ref: "instruction.software-checker", kind: "instruction_template", status: "approved", versionRef: "instruction.software-checker@1", scope: "software", title: "Software Checker", aliases: [] },
      ],
      edges: [
        { from: "agent.frontend-developer", type: "uses", to: "skill.react-ui", scope: "software", weight: 1 },
        { from: "skill.react-ui", type: "requires_tool", to: "tool.workspace-read", scope: "software", weight: 1 },
        { from: "skill.react-ui", type: "requires_tool", to: "tool.workspace-write", scope: "software", weight: 1 },
        { from: "skill.react-ui", type: "uses_instruction", to: "instruction.software-maker", scope: "software", weight: 1 },
        { from: "skill.react-ui", type: "uses_instruction", to: "instruction.software-checker", scope: "software", weight: 1 },
      ],
    },
    profilePrimitiveCandidates: {
      agents: ["agent.frontend-developer"],
      skills: ["skill.react-ui"],
      tools: ["tool.workspace-read", "tool.workspace-write"],
      mcpGrants: [],
      instructions: ["instruction.software-maker", "instruction.software-checker"],
    },
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
