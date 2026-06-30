import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import type { WorkflowCompositionPlan, WorkflowCompositionTask } from "../../src/v2/design-library/types.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { validateWorkflowCompositionPlan } from "../../src/v2/orchestration/composition-validator.ts";
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("validator accepts a composition that uses approved candidates", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const validation = await validateWorkflowCompositionPlan(db, packet, validComposition());
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    await db.close();
  }
});

test("validator rejects refs outside the candidate packet", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[1]!.agentProfileRef = "profile.unapproved-writer";

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((item) => item.code === "ref_not_in_candidate_packet"), true);
  } finally {
    await db.close();
  }
});

test("validator rejects dependency cycles in memory", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[0]!.dependsOn = ["summarize-completion"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((item) => item.code === "dependency_cycle"), true);
  } finally {
    await db.close();
  }
});

test("validator rejects vault refs not allowed by selected profile", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[0]!.vaultLeasePolicyRefs = ["vault.github-write-token"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((item) => item.code === "profile_does_not_allow_vault_lease"), true);
  } finally {
    await db.close();
  }
});

test("validator rejects selected artifacts not produced by selected agent", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[1]!.outputArtifactRefs = ["artifact.verification_report"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((item) => item.code === "agent_does_not_produce_artifact"), true);
  } finally {
    await db.close();
  }
});

test("validator allows simple bugfix compositions without optional review and summary groups", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("fix a typo bug in the todo form"),
      scope: "software",
    });
    const plan = simpleBugfixComposition();

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    await db.close();
  }
});

test("validator treats code quality review ordering as skill guidance rather than a hard constraint", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks.find((task) => task.id === "summarize-completion")!.dependsOn = ["verify-feature"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  } finally {
    await db.close();
  }
});

test("validator rejects input artifacts that are not satisfied by upstream dependencies", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks.find((task) => task.id === "verify-feature")!.inputArtifactRefs = ["artifact.completion_report"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.deepEqual(
      validation.issues.find((item) => item.code === "input_artifact_not_satisfied"),
      {
        code: "input_artifact_not_satisfied",
        path: "tasks.3.inputArtifactRefs",
        message: "task verify-feature input artifact is not satisfied by initial artifacts or upstream outputs: artifact.completion_report",
      },
    );
  } finally {
    await db.close();
  }
});

test("validator rejects tasks that use template slots not defined by the selected template", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[0]!.templateSlotRef = "slot.unknown";

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.deepEqual(
      validation.issues.find((item) => item.code === "template_slot_not_allowed"),
      {
        code: "template_slot_not_allowed",
        path: "tasks.0.templateSlotRef",
        message: "template template.software-feature does not allow slot: slot.unknown",
      },
    );
  } finally {
    await db.close();
  }
});

test("validator rejects tasks that do not satisfy selected template slot constraints", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[2]!.templateSlotRef = "understand-repo";

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.deepEqual(
      validation.issues.find(
        (item) =>
          item.code === "template_slot_not_allowed"
          && item.message.includes("does not satisfy template slot constraints"),
      ),
      {
        code: "template_slot_not_allowed",
        path: "tasks.2.templateSlotRef",
        message: "task implement-feature does not satisfy template slot constraints for slot: understand-repo",
      },
    );
  } finally {
    await db.close();
  }
});

function validComposition(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Software Dynamic Feature Workflow",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Use explorer-maker-checker-summarizer flow.",
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
        ["tool.workspace-read", "tool.workspace-write"],
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
        ["tool.workspace-read"],
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
        ["tool.workspace-read"],
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

function simpleBugfixComposition(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Simple Bugfix Workflow",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Use the smallest sufficient implement and verify loop for a low-risk bugfix.",
    tasks: [
      task(
        "implement-fix",
        [],
        "agent.software-maker",
        "profile.software-maker-pi",
        ["skill.software-implementation"],
        ["tool.workspace-read", "tool.workspace-write"],
        ["instruction.software-maker"],
        ["artifact.implementation_report"],
        "evaluator.software-feature-quality",
      ),
      task(
        "verify-fix",
        ["implement-fix"],
        "agent.software-checker",
        "profile.software-checker-codex",
        ["skill.software-verification"],
        ["tool.workspace-read"],
        ["instruction.software-checker"],
        ["artifact.verification_report"],
        "evaluator.software-verification-quality",
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
): WorkflowCompositionTask {
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
