import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import type { GeneratedAgentProfile, WorkflowCompositionPlan, WorkflowCompositionTask } from "../../src/v2/design-library/types.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { runCompositionRepairLoop } from "../../src/v2/orchestration/composition-repair-loop.ts";
import { LlmComposerOutputError } from "../../src/v2/orchestration/llm-composer.ts";
import { requirementSpecFromGoalContract } from "../../src/v2/orchestration/goal-contract.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { softwareGoalContract } from "./fixtures/goal-contract.ts";

const GOAL_CONTRACT = softwareGoalContract();

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

test("composition repair loop retries once and returns valid composition", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const candidatePacket = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(GOAL_CONTRACT),
      scope: "software",
    });
    const composer = new ScriptedWorkflowComposer([invalidPlan(), validPlan()]);
    const result = await runCompositionRepairLoop({
      db,
      goalPrompt: "implement calc sum",
      goalContract: GOAL_CONTRACT,
      candidatePacket,
      composer,
      scope: "software",
      maxRepairAttempts: 1,
    });
    assert.equal(result.validation.ok, true, JSON.stringify(result.validation.issues, null, 2));
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0]?.validation.ok, false);
    assert.equal(result.composition.tasks[0]?.agentProfileRef, "profile.generated.understand-repo");
  } finally {
    await db.close();
  }
});

test("composition repair loop retry prompt includes previous composition JSON and validation issues", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const candidatePacket = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(GOAL_CONTRACT),
      scope: "software",
    });
    const prompts: string[] = [];
    const composer = {
      async compose(input: { goalPrompt: string }) {
        prompts.push(input.goalPrompt);
        return prompts.length === 1 ? invalidPlan() : validPlan();
      },
    };
    const result = await runCompositionRepairLoop({
      db,
      goalPrompt: "implement calc sum",
      goalContract: GOAL_CONTRACT,
      candidatePacket,
      composer,
      scope: "software",
      maxRepairAttempts: 1,
      runtimeBindingCapabilities: {
        providers: ["pi"],
        models: ["pi-agent-default"],
        harnesses: ["pi"],
        executionEngines: ["tork"],
        images: ["southstar/pi-agent:local"],
      },
    });
    const initialPrompt = prompts[0] ?? "";
    const retryPrompt = prompts[1] ?? "";
    const firstIssueCode = result.attempts[0]?.validation.issues[0]?.code ?? "";

    assert.equal(result.validation.ok, true, JSON.stringify(result.validation.issues, null, 2));
    assert.equal(prompts.length, 2);
    assert.match(initialPrompt, /Runtime host advertised bindings \(authoritative; use exact values\):/);
    assert.match(initialPrompt, /"providers":\["pi"\]/);
    assert.match(initialPrompt, /"models":\["pi-agent-default"\]/);
    assert.match(initialPrompt, /"harnesses":\["pi"\]/);
    assert.match(initialPrompt, /"images":\["southstar\/pi-agent:local"\]/);
    assert.match(retryPrompt, /Previous composition JSON:/);
    assert.match(retryPrompt, /"providers":\["pi"\]/);
    assert.match(retryPrompt, /Latest validation issues:/);
    assert.match(retryPrompt, new RegExp(firstIssueCode));
    assert.match(retryPrompt, /\"title\":\"Invalid Plan\"/);
  } finally {
    await db.close();
  }
});

test("composition repair loop retries when composer output violates schema contract", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const candidatePacket = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(GOAL_CONTRACT),
      scope: "software",
    });
    let attempt = 0;
    const prompts: string[] = [];
    const composer = {
      async compose(input: { goalPrompt: string }) {
        prompts.push(input.goalPrompt);
        if (attempt === 0) {
          attempt += 1;
          throw new LlmComposerOutputError([
            {
              code: "composer_output_schema_violation",
              path: "tasks",
              message: "tasks must be an array",
            },
          ]);
        }
        return validPlan();
      },
    };
    const result = await runCompositionRepairLoop({
      db,
      goalPrompt: "implement calc sum",
      goalContract: GOAL_CONTRACT,
      candidatePacket,
      composer,
      scope: "software",
      maxRepairAttempts: 1,
    });
    assert.equal(result.validation.ok, true, JSON.stringify(result.validation.issues, null, 2));
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0]?.validation.ok, false);
    assert.equal(result.attempts[0]?.validation.issues[0]?.code, "composer_output_schema_violation");
    assert.equal(result.attempts[0]?.composition, undefined);
    assert.equal(result.composition?.tasks[0]?.agentProfileRef, "profile.generated.understand-repo");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /Latest validation issues:/);
    assert.match(prompts[1] ?? "", /composer_output_schema_violation/);
    assert.equal((prompts[1] ?? "").includes("Previous composition JSON:"), false);
  } finally {
    await db.close();
  }
});

function invalidPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Invalid Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "invalid explorer profile should trigger repair",
    tasks: buildPlanTasks({ firstProfileRef: "profile.software-maker-pi", generatedProfiles: false }),
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function validPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Valid Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "valid software feature workflow with code quality review",
    tasks: buildPlanTasks({ generatedProfiles: true }),
    rejectedCandidates: [],
    generatedComponentProposals: generatedProfileProposals(),
  };
}

function buildPlanTasks(input: { firstProfileRef?: string; generatedProfiles: boolean }): WorkflowCompositionTask[] {
  return [
    task(
      "understand-repo",
      [],
      "agent.software-explorer",
      input.firstProfileRef ?? profileRefForTask("understand-repo", input.generatedProfiles, "profile.software-explorer-codex"),
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
      profileRefForTask("review-spec", input.generatedProfiles, "profile.software-spec-reviewer-codex"),
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
      profileRefForTask("implement-feature", input.generatedProfiles, "profile.software-maker-pi"),
      ["skill.software-implementation"],
      ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
      ["instruction.software-maker"],
      ["artifact.implementation_report"],
      "evaluator.software-feature-quality",
    ),
    task(
      "verify-feature",
      ["understand-repo", "implement-feature"],
      "agent.software-checker",
      profileRefForTask("verify-feature", input.generatedProfiles, "profile.software-checker-codex"),
      ["skill.software-verification"],
      ["tool.workspace-read", "tool.shell-command"],
      ["instruction.software-checker"],
      ["artifact.verification_report"],
      "evaluator.software-verification-quality",
    ),
    task(
      "review-code-quality",
      ["understand-repo", "implement-feature"],
      "agent.software-code-quality-reviewer",
      profileRefForTask("review-code-quality", input.generatedProfiles, "profile.software-code-quality-reviewer-codex"),
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
      profileRefForTask("summarize-completion", input.generatedProfiles, "profile.software-summarizer-codex"),
      ["skill.software-summary"],
      ["tool.workspace-read"],
      ["instruction.software-summarizer"],
      ["artifact.completion_report"],
      "evaluator.software-completion-quality",
    ),
  ];
}

function profileRefForTask(taskId: string, generatedProfiles: boolean, storedProfileRef: string): string {
  return generatedProfiles ? `profile.generated.${taskId}` : storedProfileRef;
}

function generatedProfileProposals(): WorkflowCompositionPlan["generatedComponentProposals"] {
  return [
    generatedProfile("profile.generated.understand-repo", "Inspect the repository and produce a scoped implementation plan.", ["tool.workspace-read"]),
    generatedProfile("profile.generated.review-spec", "Review the implementation plan for missing requirements and risk.", ["tool.workspace-read"]),
    generatedProfile(
      "profile.generated.implement-feature",
      "Implement the requested feature using approved workspace tools and produce implementation evidence.",
      ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
      ["mcp.filesystem-workspace"],
    ),
    generatedProfile("profile.generated.verify-feature", "Verify the implementation behavior and test evidence.", ["tool.workspace-read", "tool.shell-command"]),
    generatedProfile("profile.generated.review-code-quality", "Review maintainability, style, and regression risk.", ["tool.workspace-read", "tool.shell-command"]),
    generatedProfile("profile.generated.summarize-completion", "Summarize completed work, verification, and follow-up notes.", ["tool.workspace-read"]),
  ];
}

function generatedProfile(
  id: string,
  instruction: string,
  allowedTools: string[],
  mcpGrantRefs: string[] = [],
): WorkflowCompositionPlan["generatedComponentProposals"][number] {
  return {
    id,
    kind: "agent_profile",
    risk: "medium",
    reason: "Generated from graph-backed primitive candidates.",
    validationStatus: "validated",
    agentProfile: generatedAgentProfile(instruction, allowedTools, mcpGrantRefs),
  };
}

function generatedAgentProfile(
  instruction: string,
  allowedTools: string[],
  mcpGrantRefs: string[],
): GeneratedAgentProfile {
  return {
    workerKind: "execution_worker",
    provider: "pi",
    model: "pi-agent-default",
    thinkingLevel: "high",
    harnessRef: "pi",
    instruction,
    promptTemplateRef: "graph-generated",
    contextPolicyRef: "context.generated",
    sessionPolicyRef: "session.generated",
    memoryScopes: [],
    agentsMdRefs: [],
    vaultLeasePolicyRefs: [],
    toolPolicy: {
      allowedTools,
      deniedTools: [],
      requiresApprovalFor: [],
    },
    budgetPolicy: {
      maxInputTokens: 120000,
      maxOutputTokens: 8192,
      maxWallTimeSeconds: 900,
    },
    execution: {
      engine: "tork",
      image: "southstar/pi-agent:local",
      command: ["southstar-agent-runner"],
      env: {},
      mounts: [],
      timeoutSeconds: 900,
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
): WorkflowCompositionTask {
  const mcpGrantRefs = id === "implement-feature" ? ["mcp.filesystem-workspace"] : [];
  return {
    id,
    sliceId: "slice-main",
    name: id,
    responsibility: id,
    requirementIds: id === "summarize-completion"
      ? []
      : GOAL_CONTRACT.requirements.map((requirement) => requirement.id),
    ...(id === "summarize-completion" ? {
      nodePromptSpec: {
        nodeType: "summary" as const,
        goal: "Summarize completed work and verification evidence.",
        requirements: [],
        boundaries: [],
        nonGoals: [],
        deliverableDocuments: [],
        expectedOutputs: outputArtifactRefs,
        testCases: [],
        acceptanceCriteria: ["The summary records completed work, verification, and remaining risks."],
        summarySections: ["completed work", "verification", "remaining risks"],
      },
    } : {}),
    dependsOn,
    templateSlotRef: id,
    agentDefinitionRef,
    agentProfileRef,
    instructionRefs,
    skillRefs,
    toolGrantRefs,
    mcpGrantRefs,
    vaultLeasePolicyRefs: [],
    inputArtifactRefs: [],
    outputArtifactRefs,
    evaluatorProfileRef,
    recoveryStrategyRefs: ["retry-same-agent"],
    rationale: id,
  };
}
