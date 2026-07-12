import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import type { GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { getResourceByKeyPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  getWorkflowTemplateDetailPg,
  instantiateWorkflowTemplatePg,
  searchWorkflowTemplatesPg,
} from "../../src/v2/workflow-templates/template-api-service.ts";
import { seedDeterministicWorkflowGraph } from "./fixtures/deterministic-workflow-composer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { fixedGoalInterpreter, softwareGoalContract, subscriptionGoalContract } from "./fixtures/goal-contract.ts";

test("searchWorkflowTemplatesPg returns approved workflow templates ranked by prompt text", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedWorkflowTemplate(db);

    const result = await searchWorkflowTemplatesPg(db, { prompt: "build software feature", domain: "software" });

    assert.equal(result.templates[0]?.templateRef, "template.software-dev-standard");
    assert.equal(result.templates[0]?.title, "Software Development Standard");
    assert.deepEqual(result.templates[0]?.nodeTypes, ["plan", "implement"]);
  } finally {
    await db.close();
  }
});

test("getWorkflowTemplateDetailPg returns template skeleton details", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedWorkflowTemplate(db);

    const result = await getWorkflowTemplateDetailPg(db, { templateRef: "template.software-dev-standard" });

    assert.equal(result.templateRef, "template.software-dev-standard");
    assert.equal(result.title, "Software Development Standard");
    assert.equal(result.nodes[0]?.id, "plan");
    assert.equal(result.edges[0]?.from, "plan");
    assert.equal(result.canInstantiate, true);
  } finally {
    await db.close();
  }
});

test("instantiateWorkflowTemplatePg delegates to Goal Design with a preferred template policy", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedWorkflowTemplate(db);
    let submitted: unknown;

    const result = await instantiateWorkflowTemplatePg(db, {
      templateRef: "template.software-dev-standard",
      goalPrompt: "Deliver the outcome",
      cwd: "/workspace/software",
      constraints: { mode: "adaptive" },
      async submitGoal(request) {
        submitted = request;
        return {
          goalContractHash: "goal-hash",
          goalDesignPackageHash: "package-hash",
          draftId: "draft-goal-design-abc",
          draftStatus: "ready_for_review",
          blockers: [],
        };
      },
    });

    assert.ok(submitted && typeof submitted === "object");
    const request = submitted as Record<string, unknown>;
    assert.match(String(request.idempotencyKey), /^workflow-template:/);
    delete request.idempotencyKey;
    assert.deepEqual(request, {
      goalPrompt: "Deliver the outcome",
      cwd: "/workspace/software",
      templatePolicy: {
        mode: "prefer",
        templateRef: "template.software-dev-standard",
        versionRef: "template.software-dev-standard@1",
      },
    });
    assert.equal(result.draftId, "draft-goal-design-abc");
    assert.equal(result.status, "ready_for_review");
    assert.deepEqual(result.nodes, []);
  } finally {
    await db.close();
  }
});

test("instantiateWorkflowTemplatePg maps strict templates to require policy", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedWorkflowTemplate(db);
    let templatePolicy: unknown;

    await instantiateWorkflowTemplatePg(db, {
      templateRef: "template.software-dev-standard",
      goalPrompt: "Deliver the outcome",
      constraints: { mode: "strict" },
      async submitGoal(request) {
        templatePolicy = request.templatePolicy;
        return {
          goalContractHash: "goal-hash",
          draftId: "draft-goal-design-strict",
          draftStatus: "ready_for_review",
          blockers: [],
        };
      },
    });

    assert.deepEqual(templatePolicy, {
      mode: "require",
      templateRef: "template.software-dev-standard",
      versionRef: "template.software-dev-standard@1",
    });
  } finally {
    await db.close();
  }
});

async function seedWorkflowTemplate(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  compositionPlan?: WorkflowCompositionPlan,
  extraState: Record<string, unknown> = {},
) {
  await upsertLibraryObject(db, {
    objectKey: "template.software-dev-standard",
    objectKind: "workflow_template",
    status: "approved",
    headVersionId: "template.software-dev-standard@1",
    state: {
      scope: "software",
      title: "Software Development Standard",
      description: "Plan, implement, verify, review, and summarize software changes.",
      nodes: [
        { id: "plan", title: "Plan", nodeType: "plan" },
        { id: "implement", title: "Implement", nodeType: "implement" },
      ],
      edges: [{ from: "plan", to: "implement" }],
      ...(compositionPlan ? { compositionPlan } : {}),
      ...extraState,
    },
  });
}

function compositionPlan(goalContract?: GoalContractV1): WorkflowCompositionPlan {
  const requirement = goalContract?.requirements[0];
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Software Development Standard",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Strict template composition.",
    tasks: [{
      id: "understand-repo",
      name: "Understand Repo",
      responsibility: "Plan the requested software change.",
      requirementIds: [],
      nodePromptSpec: {
        nodeType: "plan",
        goal: "Plan the requested software change.",
        requirements: [requirement?.statement ?? "Understand the goal and produce an implementation plan."],
        boundaries: ["Do not edit files."],
        nonGoals: ["Do not implement."],
        deliverableDocuments: [{ kind: "design", title: "Implementation plan", required: true, format: "markdown", description: "Plan the change." }],
        expectedOutputs: ["artifact.implementation_plan"],
        testCases: [],
        acceptanceCriteria: requirement?.acceptanceCriteria ?? ["Plan identifies files, risks, and verification."],
        planningQuestions: ["What must the implementation plan cover?"],
      },
      dependsOn: [],
      templateSlotRef: "understand-repo",
      agentDefinitionRef: "agent.software-explorer",
      agentProfileRef: "profile.generated.software-understand-repo",
      instructionRefs: [],
      skillRefs: [],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.implementation_plan"],
      evaluatorProfileRef: "evaluator.software-plan-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "Use software explorer.",
    }, {
      id: "verify-plan",
      name: "Verify Plan",
      responsibility: "Independently verify the implementation plan.",
      requirementIds: [],
      nodePromptSpec: {
        nodeType: "verify",
        goal: "Verify the implementation plan.",
        requirements: [requirement?.statement ?? "Check that the plan satisfies the requested goal."],
        boundaries: ["Do not edit files."],
        nonGoals: ["Do not implement."],
        deliverableDocuments: [],
        expectedOutputs: ["artifact.implementation_plan"],
        testCases: [],
        acceptanceCriteria: requirement?.acceptanceCriteria ?? ["Plan covers requirements, risks, and verification."],
        verificationChecks: ["Check the implementation plan against the linked requirement."],
      },
      dependsOn: ["understand-repo"],
      templateSlotRef: "verify-plan",
      agentDefinitionRef: "agent.software-explorer",
      agentProfileRef: "profile.generated.software-understand-repo",
      instructionRefs: [],
      skillRefs: [],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_plan"],
      outputArtifactRefs: [],
      evaluatorProfileRef: "evaluator.software-plan-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "Use a separate downstream task to evaluate the plan artifact.",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [{
      id: "profile.generated.software-understand-repo",
      kind: "agent_profile",
      risk: "low",
      reason: "Generated strict template profile.",
      validationStatus: "validated",
      agentProfile: {
        workerKind: "execution_worker",
        provider: "pi",
        model: "pi-agent-default",
        thinkingLevel: "high",
        harnessRef: "pi",
        instruction: "Plan the requested software change and produce artifact.implementation_plan.",
        promptTemplateRef: "graph-generated",
        contextPolicyRef: "context.generated",
        sessionPolicyRef: "session.generated",
        memoryScopes: [],
        agentsMdRefs: [],
        vaultLeasePolicyRefs: [],
        toolPolicy: { allowedTools: [], deniedTools: [], requiresApprovalFor: [] },
        budgetPolicy: { maxInputTokens: 120000, maxOutputTokens: 8192, maxWallTimeSeconds: 900 },
        execution: {
          engine: "tork",
          image: "southstar/pi-agent:local",
          command: ["southstar-agent-runner"],
          env: {},
          mounts: [],
          timeoutSeconds: 900,
          infraRetry: { maxAttempts: 1 },
        },
      },
    }],
  };
}

function compoundCompositionPlan(goalContract: ReturnType<typeof subscriptionGoalContract>): WorkflowCompositionPlan {
  const base = compositionPlan();
  const producerTemplate = base.tasks[0]!;
  const producers = goalContract.requirements.map((requirement, index) => ({
    ...structuredClone(producerTemplate),
    id: `produce-requirement-${index + 1}`,
    name: `Produce requirement ${index + 1}`,
    responsibility: requirement.statement,
    requirementIds: [],
    dependsOn: [],
    templateSlotRef: `produce-requirement-${index + 1}`,
    nodePromptSpec: {
      ...structuredClone(producerTemplate.nodePromptSpec!),
      goal: requirement.statement,
      requirements: [requirement.statement],
      acceptanceCriteria: [...requirement.acceptanceCriteria],
    },
  }));
  const verifierTemplate = base.tasks[1]!;
  return {
    ...base,
    tasks: [
      ...producers,
      {
        ...structuredClone(verifierTemplate),
        id: "verify-compound-goal",
        name: "Verify compound goal",
        responsibility: "Verify every Goal Contract requirement.",
        requirementIds: [],
        dependsOn: producers.map((task) => task.id),
        templateSlotRef: "verify-compound-goal",
        nodePromptSpec: {
          ...structuredClone(verifierTemplate.nodePromptSpec!),
          goal: "Verify every Goal Contract requirement.",
          requirements: goalContract.requirements.map((requirement) => requirement.statement),
          acceptanceCriteria: goalContract.requirements.flatMap((requirement) => requirement.acceptanceCriteria),
        },
      },
    ],
  };
}

class CapturingComposer implements WorkflowComposer {
  lastGoalPrompt?: string;

  constructor(private readonly plan: WorkflowCompositionPlan) {}

  async compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    this.lastGoalPrompt = input.goalPrompt;
    const plan = structuredClone(this.plan);
    const requirementIds = input.goalContract.requirements.map((requirement) => requirement.id);
    plan.tasks.forEach((task) => {
      task.requirementIds = requirementIds;
    });
    return plan;
  }
}
