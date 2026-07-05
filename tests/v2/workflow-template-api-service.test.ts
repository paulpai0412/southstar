import test from "node:test";
import assert from "node:assert/strict";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import {
  getWorkflowTemplateDetailPg,
  instantiateWorkflowTemplatePg,
  searchWorkflowTemplatesPg,
} from "../../src/v2/workflow-templates/template-api-service.ts";
import { seedDeterministicWorkflowGraph } from "./fixtures/deterministic-workflow-composer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

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

test("instantiateWorkflowTemplatePg creates planner draft from strict template composition", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedWorkflowTemplate(db, compositionPlan());

    const result = await instantiateWorkflowTemplatePg(db, {
      templateRef: "template.software-dev-standard",
      goalPrompt: "build vocabulary app",
      constraints: { mode: "strict" },
    });

    assert.equal(result.templateRef, "template.software-dev-standard");
    assert.match(result.draftId, /^draft-wf-composed-/);
    assert.equal(result.status, "validated");
    assert.equal(result.nodes.every((node) => node.nodePromptSpec), true);
  } finally {
    await db.close();
  }
});

test("instantiateWorkflowTemplatePg asks composer to bind a skeleton-only template", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    await seedWorkflowTemplate(db);
    const composer = new CapturingComposer(compositionPlan());

    const result = await instantiateWorkflowTemplatePg(db, {
      templateRef: "template.software-dev-standard",
      goalPrompt: "build vocabulary app",
      constraints: { mode: "strict" },
      composer,
    });

    assert.equal(result.status, "validated");
    assert.equal(result.nodes.every((node) => node.nodePromptSpec), true);
    assert.match(composer.lastGoalPrompt ?? "", /Template skeleton/);
    assert.match(composer.lastGoalPrompt ?? "", /"id":"plan"/);
    assert.match(composer.lastGoalPrompt ?? "", /Preserve template node ids and dependencies/);
  } finally {
    await db.close();
  }
});

async function seedWorkflowTemplate(db: Awaited<ReturnType<typeof createTestPostgresDb>>, compositionPlan?: WorkflowCompositionPlan) {
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
    },
  });
}

function compositionPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Software Development Standard",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Strict template composition.",
    tasks: [{
      id: "understand-repo",
      name: "Understand Repo",
      responsibility: "Plan the requested software change.",
      nodePromptSpec: {
        nodeType: "plan",
        goal: "Plan the requested software change.",
        requirements: ["Understand the goal and produce an implementation plan."],
        boundaries: ["Do not edit files."],
        nonGoals: ["Do not implement."],
        deliverableDocuments: [{ kind: "design", title: "Implementation plan", required: true, format: "markdown", description: "Plan the change." }],
        expectedOutputs: ["artifact.implementation_plan"],
        testCases: [],
        acceptanceCriteria: ["Plan identifies files, risks, and verification."],
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
    return structuredClone(this.plan);
  }
}
