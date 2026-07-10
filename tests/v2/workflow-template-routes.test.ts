import test from "node:test";
import assert from "node:assert/strict";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import type { GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { seedDeterministicWorkflowGraph } from "./fixtures/deterministic-workflow-composer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { fixedGoalInterpreter, softwareGoalContract } from "./fixtures/goal-contract.ts";

test("runtime routes expose workflow template search, detail, and instantiation", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedWorkflowTemplate(db);

    const search = await call<{ templates: Array<{ templateRef: string; nodeTypes: string[] }> }>(
      db,
      "/api/v2/workflow/templates/search?prompt=standard%20plan%20implement%20summarize&domain=software",
    );
    assert.equal(search.kind, "workflow-template-search");
    assert.equal(search.result.templates[0]?.templateRef, "template.software-dev-standard");
    assert.deepEqual(search.result.templates[0]?.nodeTypes, ["plan", "implement"]);

    const detail = await call<{ templateRef: string; canInstantiate: boolean; nodes: Array<{ id: string }> }>(
      db,
      "/api/v2/workflow/templates/template.software-dev-standard",
    );
    assert.equal(detail.kind, "workflow-template-detail");
    assert.equal(detail.result.templateRef, "template.software-dev-standard");
    assert.equal(detail.result.nodes[0]?.id, "plan");
    assert.equal(detail.result.canInstantiate, true);

    const goalContract = softwareGoalContract("build vocabulary app");
    await seedWorkflowTemplate(db, compositionPlan(goalContract));
    const instantiated = await call<{ templateRef: string; draftId: string; status: string; nodes: Array<{ taskId: string; nodePromptSpec?: unknown }> }>(
      db,
      "/api/v2/workflow/templates/instantiate",
      {
        method: "POST",
        body: JSON.stringify({
          templateRef: "template.software-dev-standard",
          goalPrompt: "build vocabulary app",
          constraints: { mode: "strict" },
        }),
      },
      { goalInterpreter: fixedGoalInterpreter(goalContract) },
    );
    assert.equal(instantiated.kind, "workflow-template-instantiate");
    assert.equal(instantiated.result.templateRef, "template.software-dev-standard");
    assert.match(instantiated.result.draftId, /^draft-wf-composed-/);
    assert.equal(instantiated.result.status, "validated");
    assert.equal(instantiated.result.nodes.every((node) => node.nodePromptSpec), true);
  } finally {
    await db.close();
  }
});

test("runtime route can instantiate a skeleton template through workflowComposer", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedWorkflowTemplate(db);
    const workflowComposer = new CapturingComposer(compositionPlan());

    const instantiated = await call<{ status: string; nodes: Array<{ nodePromptSpec?: unknown }> }>(
      db,
      "/api/v2/workflow/templates/instantiate",
      {
        method: "POST",
        body: JSON.stringify({
          templateRef: "template.software-dev-standard",
          goalPrompt: "build vocabulary app",
          constraints: { mode: "strict" },
        }),
      },
      {
        workflowComposer,
        goalInterpreter: fixedGoalInterpreter(softwareGoalContract("build vocabulary app")),
      },
    );

    assert.equal(instantiated.result.status, "validated");
    assert.equal(instantiated.result.nodes.every((node) => node.nodePromptSpec), true);
    assert.match(workflowComposer.lastGoalPrompt ?? "", /Template skeleton/);
  } finally {
    await db.close();
  }
});

async function call<T>(
  db: Parameters<typeof handleRuntimeRoute>[0]["db"],
  path: string,
  init?: RequestInit,
  contextOverrides: Partial<Parameters<typeof handleRuntimeRoute>[0]> = {},
): Promise<{ ok: true; kind: string; result: T }> {
  const response = await handleRuntimeRoute({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
    ...contextOverrides,
  }, new Request(`http://127.0.0.1${path}`, init));
  const envelope = await response.json() as { ok: true; kind: string; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

async function seedWorkflowTemplate(db: Awaited<ReturnType<typeof createTestPostgresDb>>, composition?: WorkflowCompositionPlan) {
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
      ...(composition ? { compositionPlan: composition } : {}),
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
