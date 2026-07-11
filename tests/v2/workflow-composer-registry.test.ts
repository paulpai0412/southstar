import assert from "node:assert/strict";
import test from "node:test";
import type { CandidatePacket, WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { createWorkflowComposerRegistry } from "../../src/v2/orchestration/composer-registry.ts";
import { softwareGoalContract } from "./fixtures/goal-contract.ts";

const GOAL_CONTRACT = softwareGoalContract("x");

class ScriptedWorkflowComposer implements WorkflowComposer {
  private index = 0;

  constructor(private readonly plans: WorkflowCompositionPlan[]) {}

  async compose(_input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    const plan = this.plans[Math.min(this.index, this.plans.length - 1)];
    this.index += 1;
    if (!plan) throw new Error("ScriptedWorkflowComposer has no plans");
    return structuredClone(plan);
  }
}

test("composer registry defaults to llm mode when composerMode is omitted", () => {
  const registry = createWorkflowComposerRegistry();
  assert.throws(
    () => registry.resolve({}),
    /LLM workflow composer is not configured/,
  );
});

test("composer registry resolves llm mode with scripted composer output", async () => {
  const registry = createWorkflowComposerRegistry({
    llmComposer: new ScriptedWorkflowComposer([minimalPlan("scripted-task")]),
  });
  const composer = registry.resolve({ composerMode: "llm" });
  const composed = await composer.compose({ goalPrompt: "x", goalContract: GOAL_CONTRACT, candidatePacket: candidatePacket() });
  assert.deepEqual(composed.tasks.map((task) => task.id), ["scripted-task"]);
});

test("composer registry fails closed when llm mode has no configured composer", () => {
  const registry = createWorkflowComposerRegistry();
  assert.throws(
    () => registry.resolve({ composerMode: "llm" }),
    /LLM workflow composer is not configured/,
  );
});

test("composer registry does not hide primary llm composer failures", async () => {
  const failing = {
    async compose(): Promise<WorkflowCompositionPlan> {
      throw new Error("llm unavailable");
    },
  };
  const registry = createWorkflowComposerRegistry({ llmComposer: failing });
  const composer = registry.resolve({ composerMode: "llm" });
  await assert.rejects(
    () => composer.compose({ goalPrompt: "x", goalContract: GOAL_CONTRACT, candidatePacket: candidatePacket() }),
    /llm unavailable/,
  );
});

test("composer registry keeps primary result when llm composer succeeds", async () => {
  const primaryPlan: WorkflowCompositionPlan = {
    ...minimalPlan("primary-task"),
    title: "Primary Plan",
    selectedWorkflowTemplateRef: "template.primary-success",
  };
  const registry = createWorkflowComposerRegistry({
    llmComposer: new ScriptedWorkflowComposer([primaryPlan]),
  });
  const composer = registry.resolve({ composerMode: "llm" });
  const composed = await composer.compose({ goalPrompt: "x", goalContract: GOAL_CONTRACT, candidatePacket: candidatePacket() });
  assert.equal(composed.selectedWorkflowTemplateRef, "template.primary-success");
  assert.deepEqual(composed.tasks.map((task) => task.id), ["primary-task"]);
});

test("composer registry rejects unknown composer modes", () => {
  const registry = createWorkflowComposerRegistry();
  assert.throws(
    () => registry.resolve({ composerMode: "unexpected" as unknown as "llm" }),
    /Unknown workflow composer mode: unexpected/,
  );
});

test("scripted workflow composer replays the only plan across repeated compose calls", async () => {
  const singlePlan = minimalPlan("replayed-task");
  const composer = new ScriptedWorkflowComposer([singlePlan]);
  const first = await composer.compose({ goalPrompt: "x", goalContract: GOAL_CONTRACT, candidatePacket: candidatePacket() });
  const second = await composer.compose({ goalPrompt: "x", goalContract: GOAL_CONTRACT, candidatePacket: candidatePacket() });
  assert.deepEqual(first.tasks.map((task) => task.id), ["replayed-task"]);
  assert.deepEqual(second.tasks.map((task) => task.id), ["replayed-task"]);
});

test("scripted workflow composer throws when no plans are configured", async () => {
  const composer = new ScriptedWorkflowComposer([]);
  await assert.rejects(
    () => composer.compose({ goalPrompt: "x", goalContract: GOAL_CONTRACT, candidatePacket: candidatePacket() }),
    /ScriptedWorkflowComposer has no plans/,
  );
});

function minimalPlan(taskId: string): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Mock LLM Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "scripted test plan",
    tasks: [
      {
        id: taskId,
        sliceId: "slice-main",
        name: "Mock Task",
        responsibility: "mock",
        requirementIds: GOAL_CONTRACT.requirements.map((requirement) => requirement.id),
        dependsOn: [],
        templateSlotRef: "mock",
        agentDefinitionRef: "agent.test-explorer",
        agentProfileRef: "profile.generated.test-explorer",
        instructionRefs: ["instruction.test-explorer"],
        skillRefs: ["skill.test-discovery"],
        toolGrantRefs: ["tool.test-read"],
        mcpGrantRefs: [],
        vaultLeasePolicyRefs: [],
        inputArtifactRefs: [],
        outputArtifactRefs: ["artifact.test-plan"],
        evaluatorProfileRef: "evaluator.test-plan-quality",
        recoveryStrategyRefs: ["retry-same-agent"],
        rationale: "mock",
      },
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function candidatePacket(): CandidatePacket {
  return {
    requirementSpec: {
      summary: "mock",
      workType: "software_feature",
      requiredCapabilities: [],
      expectedArtifacts: [],
      acceptanceCriteria: [],
      nonGoals: [],
      riskNotes: [],
      workspaceAssumptions: [],
      missingInputs: [],
    },
    workflowTemplateCandidates: [],
    agentCandidatesByCapability: {},
    profileCandidatesByAgent: {},
    skillCandidatesByProfile: {},
    toolCandidatesByProfile: {},
    mcpGrantCandidatesByProfile: {},
    vaultLeaseCandidatesByProfile: {},
    instructionCandidatesByProfile: {},
    artifactContractCandidates: [],
    evaluatorCandidatesByArtifact: {},
    policyConstraints: [],
    unavailableRequirements: [],
  };
}
