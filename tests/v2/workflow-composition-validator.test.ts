import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import type { WorkflowCompositionPlan, WorkflowCompositionTask } from "../../src/v2/design-library/types.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { validateWorkflowCompositionPlan } from "../../src/v2/orchestration/composition-validator.ts";
import {
  buildGoalRequirementCoverage,
  storedGoalRequirementCoverage,
} from "../../src/v2/orchestration/goal-requirement-coverage.ts";
import { requirementSpecFromGoalContract, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import { finalizeGoalDesignPackage, type GoalDesignPackageV1 } from "../../src/v2/orchestration/goal-design.ts";
import { classifyWorkflowCompositionTask } from "../../src/v2/orchestration/workflow-node-classifier.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { articleGoalContract, softwareGoalContract, subscriptionGoalContract } from "./fixtures/goal-contract.ts";

test("stored Goal Requirement Coverage parser rejects malformed persisted projections", () => {
  const contract = softwareGoalContract();
  const coverage = buildGoalRequirementCoverage({ goalContract: contract, composition: validComposition() });

  assert.deepEqual(storedGoalRequirementCoverage(coverage), coverage);
  assert.equal(storedGoalRequirementCoverage({
    ...coverage,
    entries: [{ ...coverage.entries[0], producerTaskIds: "implement" }],
  }), undefined);
});

test("validator rejects legacy stored-profile compositions when graph metadata is active", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract()),
      scope: "software",
    });
    const validation = await validateWorkflowCompositionPlan(db, packet, validComposition());
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "ref_not_in_candidate_packet"), true);
  } finally {
    await db.close();
  }
});

test("validator rejects refs outside the candidate packet", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract()),
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

test("composer tasks must belong to the authoritative Slice Plan", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const goalContract = softwareGoalContract();
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: "software",
    });
    const plan = validComposition(goalContract);
    (plan.tasks[0] as WorkflowCompositionTask & { sliceId?: string }).sliceId = "slice-unknown";

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, {
      goalContract,
      goalDesignPackage: validGoalDesignPackage(goalContract),
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "unknown_slice_id"), true);
  } finally {
    await db.close();
  }
});

test("validator rejects dependency cycles in memory", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract()),
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
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract()),
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
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract()),
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

test("validator rejects legacy stored-profile bugfix compositions when graph metadata is active", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract("fix a typo bug in the todo form")),
      scope: "software",
    });
    const plan = simpleBugfixComposition();

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((item) => item.code === "ref_not_in_candidate_packet"), true);
  } finally {
    await db.close();
  }
});

test("validator does not re-enable legacy stored profiles for code quality review ordering", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract()),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks.find((task) => task.id === "summarize-completion")!.dependsOn = ["verify-feature"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((item) => item.code === "ref_not_in_candidate_packet"), true);
  } finally {
    await db.close();
  }
});

test("validator rejects input artifacts that are not satisfied by upstream dependencies", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract()),
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
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract()),
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
      requirementSpec: requirementSpecFromGoalContract(softwareGoalContract()),
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

test("coverage maps every blocking requirement to producer and independent evaluator", () => {
  const goalContract = articleGoalContract();
  const coverage = buildGoalRequirementCoverage({
    goalContract,
    composition: articleCompositionWithRequirementIds(goalContract),
  });

  assert.deepEqual(coverage.entries[0], {
    requirementId: goalContract.requirements[0]!.id,
    producerTaskIds: ["task-build-article"],
    artifactRefs: ["artifact.article_html"],
    evaluatorTaskIds: ["task-verify-article"],
    evaluatorProfileRefs: ["evaluator.article-browser-quality"],
    requiredEvidenceKinds: ["artifact-ref", "screenshot", "url"],
  });
});

test("node classification gives explicit prompt type precedence over ambiguous structural text", () => {
  const explicitVerifier = coverageTask({
    id: "summarize-test-results",
    requirementIds: ["requirement.test"],
    nodeType: "verify",
    outputArtifactRefs: ["artifact.verification_report"],
  });
  const inferredVerifier = { ...explicitVerifier, nodePromptSpec: undefined };

  assert.equal(classifyWorkflowCompositionTask(explicitVerifier), "verify");
  assert.equal(classifyWorkflowCompositionTask(inferredVerifier), "verify");
});

test("coverage rejects a producer as its only evaluator", async () => {
  const db = await createTestPostgresDb();
  const goalContract = softwareGoalContract();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: "software",
    });

    const validation = await validateWorkflowCompositionPlan(
      db,
      packet,
      selfEvaluatingComposition(goalContract),
      { scope: "software", goalContract },
    );

    assert.equal(validation.ok, false);
    assert.equal(
      validation.issues.some((issue) => issue.code === "requirement_evaluator_not_independent"),
      true,
    );
  } finally {
    await db.close();
  }
});

test("coverage rejects an evaluator that can only reach a producer transitively", async () => {
  const db = await createTestPostgresDb();
  const goalContract = softwareGoalContract();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: "software",
    });
    const composition = validComposition(goalContract);
    const producer = composition.tasks.find((task) => task.id === "implement-feature")!;
    const evaluator = composition.tasks.find((task) => task.id === "verify-feature")!;
    const reviewer = composition.tasks.find((task) => task.id === "review-code-quality")!;
    const coordination: WorkflowCompositionTask = {
      ...producer,
      id: "coordinate-verification",
      name: "Coordinate verification inputs",
      responsibility: "Assemble producer outputs for later verification.",
      requirementIds: [],
      nodePromptSpec: nodePromptSpec("general", []),
      templateSlotRef: "coordination",
      dependsOn: [producer.id],
      outputArtifactRefs: [],
    };
    evaluator.dependsOn = [coordination.id];
    reviewer.dependsOn = [coordination.id];
    composition.tasks.splice(composition.tasks.indexOf(evaluator), 0, coordination);

    const validation = await validateWorkflowCompositionPlan(db, packet, composition, {
      scope: "software",
      goalContract,
    });

    assert.equal(
      validation.issues.some((issue) => issue.code === "requirement_evaluator_not_independent"),
      true,
    );
  } finally {
    await db.close();
  }
});

test("coverage does not exempt implementation work merely because its name says coordinate", async () => {
  const db = await createTestPostgresDb();
  const goalContract = softwareGoalContract();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: "software",
    });
    const composition = validComposition(goalContract);
    const task = composition.tasks.find((item) => item.id === "implement-feature")!;
    task.id = "implement-coordinate-state";
    task.name = "Implement coordinated state updates";
    task.responsibility = "Implement and coordinate state updates across modules.";
    task.requirementIds = [];

    const validation = await validateWorkflowCompositionPlan(db, packet, composition, {
      scope: "software",
      goalContract,
    });

    assert.equal(
      validation.issues.some((issue) => issue.code === "task_without_requirement_coverage"),
      true,
    );
  } finally {
    await db.close();
  }
});

test("coverage exempts only an explicit general coordination slot", async () => {
  const db = await createTestPostgresDb();
  const goalContract = softwareGoalContract();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: "software",
    });
    const composition = validComposition(goalContract);
    const producer = composition.tasks.find((task) => task.id === "implement-feature")!;
    composition.tasks.push({
      ...producer,
      id: "coordinate-results",
      name: "Coordinate results",
      responsibility: "Fan in task metadata without evaluating requirements.",
      requirementIds: [],
      nodePromptSpec: nodePromptSpec("general", []),
      templateSlotRef: "coordination",
      dependsOn: [producer.id],
      outputArtifactRefs: [],
    });

    const validation = await validateWorkflowCompositionPlan(db, packet, composition, {
      scope: "software",
      goalContract,
    });

    assert.equal(
      validation.issues.some((issue) =>
        issue.code === "task_without_requirement_coverage"
        && issue.message.includes("coordinate-results")
      ),
      false,
    );
  } finally {
    await db.close();
  }
});

test("compound requirements form parallel producer branches and a dependent verification wave", () => {
  const goalContract = subscriptionGoalContract();
  const composition = subscriptionCompositionWithRequirementIds(goalContract);
  const coverage = buildGoalRequirementCoverage({ goalContract, composition });
  const producerTasks = composition.tasks.filter((task) => task.nodePromptSpec?.nodeType === "implement");
  const verifier = composition.tasks.find((task) => task.id === "task-verify-subscription");

  assert.deepEqual(
    new Set(coverage.entries.map((entry) => entry.requirementId)),
    new Set(goalContract.requirements.map((requirement) => requirement.id)),
  );
  assert.equal(producerTasks.filter((task) => task.dependsOn.length === 0).length >= 2, true);
  assert.deepEqual(new Set(verifier?.dependsOn), new Set(producerTasks.map((task) => task.id)));
  assert.deepEqual(
    new Set(verifier?.requirementIds),
    new Set(goalContract.requirements.map((requirement) => requirement.id)),
  );
});

test("planning artifacts do not count as observable outcome producers", () => {
  const goalContract = subscriptionGoalContract();
  const composition = subscriptionCompositionWithRequirementIds(goalContract);
  const planTask = {
    ...composition.tasks[0]!,
    id: "task-plan-subscription",
    requirementIds: goalContract.requirements.map((requirement) => requirement.id),
    nodePromptSpec: nodePromptSpec("plan", ["artifact.implementation_plan"]),
    outputArtifactRefs: ["artifact.implementation_plan"],
  };
  composition.tasks.unshift(planTask);

  const coverage = buildGoalRequirementCoverage({ goalContract, composition });

  assert.equal(coverage.entries.every((entry) => !entry.producerTaskIds.includes(planTask.id)), true);
});

test("producer dependencies require declared upstream artifact flow", async () => {
  const db = await createTestPostgresDb();
  const goalContract = subscriptionGoalContract();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: "software",
    });
    const composition = subscriptionCompositionWithRequirementIds(goalContract);
    const producers = composition.tasks.filter((task) => task.nodePromptSpec?.nodeType === "implement");
    producers[1]!.dependsOn = [producers[0]!.id];
    producers[1]!.inputArtifactRefs = [];

    const validation = await validateWorkflowCompositionPlan(db, packet, composition, { scope: "software", goalContract });

    assert.equal(validation.issues.some((issue) => issue.code === "producer_dependency_without_artifact_flow"), true);
  } finally {
    await db.close();
  }
});

test("target requirement scope rejects empty, unknown, and out-of-scope requirement ids", async () => {
  const db = await createTestPostgresDb();
  const goalContract = subscriptionGoalContract();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: "software",
    });
    const composition = subscriptionCompositionWithRequirementIds(goalContract);
    const billingRequirementId = goalContract.requirements[1]!.id;

    const emptyScope = await validateWorkflowCompositionPlan(db, packet, composition, {
      scope: "software",
      goalContract,
      targetRequirementIds: [],
    });
    assert.equal(emptyScope.issues.some((issue) => issue.code === "target_requirement_scope_empty"), true);

    const unknownScope = await validateWorkflowCompositionPlan(db, packet, composition, {
      scope: "software",
      goalContract,
      targetRequirementIds: ["requirement.unknown"],
    });
    assert.equal(unknownScope.issues.some((issue) => issue.code === "unknown_target_requirement_id"), true);

    const billingScope = await validateWorkflowCompositionPlan(db, packet, composition, {
      scope: "software",
      goalContract,
      targetRequirementIds: [billingRequirementId],
    });
    assert.equal(billingScope.issues.some((issue) => issue.code === "requirement_outside_target_scope"), true);
  } finally {
    await db.close();
  }
});

test("validator reports unknown and incomplete blocking requirement coverage", async () => {
  const db = await createTestPostgresDb();
  const goalContract = softwareGoalContract();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: "software",
    });
    const composition = validComposition(goalContract);
    composition.tasks.forEach((compositionTask) => {
      compositionTask.requirementIds = [];
    });
    composition.tasks[2]!.requirementIds = [goalContract.requirements[0]!.id, "requirement.unknown"];
    composition.tasks[2]!.outputArtifactRefs = [];

    const validation = await validateWorkflowCompositionPlan(db, packet, composition, {
      scope: "software",
      goalContract,
    });

    for (const code of [
      "unknown_requirement_id",
      "requirement_missing_artifact",
      "requirement_missing_evaluator",
      "requirement_missing_evidence",
      "task_without_requirement_coverage",
    ]) {
      assert.equal(validation.issues.some((issue) => issue.code === code), true, `missing ${code}`);
    }
  } finally {
    await db.close();
  }
});

function validComposition(goalContract = softwareGoalContract()): WorkflowCompositionPlan {
  const requirementIds = goalContract.requirements.map((requirement) => requirement.id);
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Software Dynamic Feature Workflow",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Use explorer-maker-checker-summarizer flow.",
    tasks: [
      task(
        "understand-repo",
        requirementIds,
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
        requirementIds,
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
        requirementIds,
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
        requirementIds,
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
        requirementIds,
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
        [],
        ["verify-feature", "review-code-quality"],
        "agent.software-summarizer",
        "profile.software-summarizer-codex",
        ["skill.software-summary"],
        ["tool.workspace-read"],
        ["instruction.software-summarizer"],
        ["artifact.completion_report"],
        "evaluator.software-completion-quality",
        "summary",
      ),
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function validGoalDesignPackage(goalContract: GoalContractV1): GoalDesignPackageV1 {
  const requirementIds = goalContract.requirements.map((requirement) => requirement.id);
  const artifactRefs = goalContract.expectedArtifactRefs;
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: 1,
    goalContract,
    evaluatorContracts: goalContract.requirements.map((requirement, index) => ({
      schemaVersion: "southstar.requirement_evaluator_contract.v1",
      id: `eval-${index + 1}`,
      requirementId: requirement.id,
      acceptanceCriteria: requirement.acceptanceCriteria,
      requiredEvidenceKinds: ["test_result"],
      independence: "independent",
      failureClassifications: ["implementation_gap"],
    })),
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: 1,
      slices: [{
        id: "slice-main",
        requirementIds,
        outcome: goalContract.summary,
        stateOrArtifactOwner: artifactRefs[0] ?? "artifact.outcome",
        mutationBoundary: "single cohesive test fixture boundary",
        expectedArtifactRefs: artifactRefs,
        evaluatorContractRefs: goalContract.requirements.map((_, index) => `eval-${index + 1}`),
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: ["slice-main"],
      rationale: "single test fixture slice",
    },
    templatePolicy: { mode: "auto" },
    goalDesignSkillRef: "skill.southstar-goal-design",
    goalDesignSkillVersionRef: "skill.southstar-goal-design@test",
    workspaceDiscoveryHash: "workspace-discovery-test",
    mode: "review_before_compose",
  });
}

function simpleBugfixComposition(): WorkflowCompositionPlan {
  const requirementIds = softwareGoalContract("fix a typo bug in the todo form").requirements.map((requirement) => requirement.id);
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Simple Bugfix Workflow",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "Use the smallest sufficient implement and verify loop for a low-risk bugfix.",
    tasks: [
      task(
        "implement-fix",
        requirementIds,
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
        requirementIds,
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

function articleCompositionWithRequirementIds(goalContract: GoalContractV1): WorkflowCompositionPlan {
  const [requirementId] = goalContract.requirements.map((requirement) => requirement.id);
  return coverageComposition([
    coverageTask({
      id: "task-build-article",
      requirementIds: [requirementId!],
      nodeType: "implement",
      outputArtifactRefs: ["artifact.article_html"],
    }),
    coverageTask({
      id: "task-verify-article",
      requirementIds: [requirementId!],
      nodeType: "verify",
      dependsOn: ["task-build-article"],
      outputArtifactRefs: ["artifact.verification_report"],
      evaluatorProfileRef: "evaluator.article-browser-quality",
      mcpGrantRefs: ["mcp.browser-playwright"],
    }),
  ]);
}

function subscriptionCompositionWithRequirementIds(goalContract: GoalContractV1): WorkflowCompositionPlan {
  const producerIds = [
    "task-implement-account-access",
    "task-implement-billing",
    "task-implement-cancellation-refund",
    "task-implement-admin-audit",
  ];
  const producers = goalContract.requirements.map((requirement, index) => coverageTask({
    id: producerIds[index]!,
    requirementIds: [requirement.id],
    nodeType: "implement",
    outputArtifactRefs: [`artifact.subscription_${index + 1}`],
  }));
  return coverageComposition([
    ...producers,
    coverageTask({
      id: "task-verify-subscription",
      requirementIds: goalContract.requirements.map((requirement) => requirement.id),
      nodeType: "verify",
      dependsOn: producerIds,
      outputArtifactRefs: ["artifact.verification_report"],
      evaluatorProfileRef: "evaluator.subscription-quality",
      toolGrantRefs: ["tool.test-runner"],
    }),
  ]);
}

function selfEvaluatingComposition(goalContract: GoalContractV1): WorkflowCompositionPlan {
  const composition = validComposition(goalContract);
  composition.tasks.forEach((compositionTask) => {
    compositionTask.requirementIds = [];
  });
  const producer = composition.tasks.find((compositionTask) => compositionTask.id === "implement-feature")!;
  producer.requirementIds = [goalContract.requirements[0]!.id];
  producer.nodePromptSpec = nodePromptSpec("verify", producer.outputArtifactRefs);
  return composition;
}

function coverageComposition(tasks: WorkflowCompositionTask[]): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Coverage fixture",
    selectedWorkflowTemplateRef: "template.coverage",
    rationale: "Exercise deterministic Goal Contract coverage.",
    tasks,
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function coverageTask(input: {
  id: string;
  requirementIds: string[];
  nodeType: "implement" | "verify";
  dependsOn?: string[];
  outputArtifactRefs: string[];
  evaluatorProfileRef?: string;
  toolGrantRefs?: string[];
  mcpGrantRefs?: string[];
}): WorkflowCompositionTask {
  return {
    id: input.id,
    name: input.id,
    responsibility: input.id,
    requirementIds: input.requirementIds,
    nodePromptSpec: nodePromptSpec(input.nodeType, input.outputArtifactRefs),
    dependsOn: input.dependsOn ?? [],
    templateSlotRef: input.id,
    agentDefinitionRef: `agent.${input.id}`,
    agentProfileRef: `profile.${input.id}`,
    instructionRefs: [],
    skillRefs: [],
    toolGrantRefs: input.toolGrantRefs ?? [],
    mcpGrantRefs: input.mcpGrantRefs ?? [],
    vaultLeasePolicyRefs: [],
    inputArtifactRefs: [],
    outputArtifactRefs: input.outputArtifactRefs,
    evaluatorProfileRef: input.evaluatorProfileRef ?? `evaluator.${input.id}`,
    recoveryStrategyRefs: [],
    rationale: input.id,
  };
}

function nodePromptSpec(
  nodeType: "plan" | "implement" | "verify" | "summary" | "general",
  expectedOutputs: string[],
): NonNullable<WorkflowCompositionTask["nodePromptSpec"]> {
  return {
    nodeType,
    goal: `${nodeType} the requirement`,
    requirements: ["Satisfy the linked Goal Contract requirement."],
    boundaries: [],
    nonGoals: [],
    deliverableDocuments: [],
    expectedOutputs,
    testCases: [],
    acceptanceCriteria: ["Produce evidence for the linked requirement."],
  };
}

function task(
  id: string,
  requirementIds: string[],
  dependsOn: string[],
  agentDefinitionRef: string,
  agentProfileRef: string,
  skillRefs: string[],
  toolGrantRefs: string[],
  instructionRefs: string[],
  outputArtifactRefs: string[],
  evaluatorProfileRef: string,
  nodeType?: "summary",
): WorkflowCompositionTask {
  return {
    id,
    name: id,
    responsibility: id,
    requirementIds,
    ...(nodeType ? { nodePromptSpec: nodePromptSpec(nodeType, outputArtifactRefs) } : {}),
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
