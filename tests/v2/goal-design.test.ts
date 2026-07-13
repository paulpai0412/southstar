import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { syncLibraryFileToGraph } from "../../src/v2/design-library/files/library-file-store.ts";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { RequirementValidationBindingV1 } from "../../src/v2/design-library/types.ts";
import {
  confirmGoalRequirementDraft,
  finalizeGoalRequirementDraft,
  type GoalRequirementDraftV1,
} from "../../src/v2/orchestration/goal-requirement-draft.ts";
import {
  finalizeGoalContract,
  type GoalContractV1,
} from "../../src/v2/orchestration/goal-contract.ts";
import {
  createLlmGoalDesigner,
  designGoalSlicesWithLlm,
  designGoalWithLlm,
  finalizeGoalDesignPackage,
  finalizeGoalDesignPackageV2,
  goalDesignPackageHash,
  loadGoalDesignSkillPg,
  validateGoalDesignPackage,
  validateGoalDesignPackageV2,
  type GoalDesignPackageV2,
  type GoalDesignPackageV1,
  type GoalSliceV1,
  type WorkflowTemplatePolicyV1,
  type WorkspaceGoalDiscoveryV1,
} from "../../src/v2/orchestration/goal-design.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("Goal Design uses the approved Library SOP and derives variable outcome slices", async () => {
  const db = await createTestPostgresDb();
  try {
    await syncGoalDesignSkill(db);
    const prompts: string[] = [];
    const contract = articleGoalContract();
    const requirementId = contract.requirements[0]!.id;

    const designed = await designGoalWithLlm(db, {
      goalContract: contract,
      workspaceDiscovery: discovery(contract.workspace.cwd),
      mode: "review_before_compose",
      templatePolicy: { mode: "auto" },
      client: {
        async generateText({ prompt }) {
          prompts.push(prompt);
          return JSON.stringify({
            evaluatorContracts: [{
              id: "eval-offline",
              requirementId,
              acceptanceCriteria: [...contract.requirements[0]!.acceptanceCriteria],
              requiredEvidenceKinds: ["screenshot"],
              independence: "independent",
              failureClassifications: ["network_dependency"],
            }],
            slicePlan: {
              revision: 1,
              slices: [{
                id: "slice-article",
                requirementIds: [requirementId],
                outcome: "deliver the offline article",
                stateOrArtifactOwner: "article.html",
                mutationBoundary: "one self-contained HTML artifact",
                expectedArtifactRefs: [contract.expectedArtifactRefs[0]!],
                evaluatorContractRefs: ["eval-offline"],
                dependsOnSliceIds: [],
                dependencyArtifactRefs: [],
              }],
            },
            compositionStrategy: {
              mode: "single-run",
              sliceIds: ["slice-article"],
              rationale: "one atomic artifact boundary",
            },
          });
        },
      },
      model: "inline-goal-design-test",
    });

    assert.match(prompts[0] ?? "", /smallest cohesive outcome slices/i);
    assert.match(prompts[0] ?? "", /Southstar Goal Design/);
    assert.match(prompts[0] ?? "", /GoalDesignOutputSchema:/);
    assert.match(prompts[0] ?? "", /AllowedRequirementIds:/);
    assert.match(prompts[0] ?? "", new RegExp(requirementId));
    assert.match(prompts[0] ?? "", new RegExp(`AllowedGoalArtifactRefs: ${escapeRegExp(JSON.stringify(contract.expectedArtifactRefs))}`));
    assert.match(prompts[0] ?? "", /compositionStrategy\.mode: "single-run" \| "per-slice-runs"/);
    assert.match(prompts[0] ?? "", /evaluatorContracts\[\]\.independence must be "independent"/);
    assert.equal(designed.package.slicePlan.slices.length, 1);
    assert.equal(designed.package.goalDesignSkillVersionRef, designed.skill.versionRef);
    assert.equal(validateGoalDesignPackage(designed.package).length, 0);
  } finally {
    await db.close();
  }
});

test("Goal Design revision prompt returns a host-finalized package or clarification", async () => {
  const db = await createTestPostgresDb();
  try {
    await syncGoalDesignSkill(db);
    const prompts: string[] = [];
    const skill = await loadGoalDesignSkillPg(db);
    const base = packageValue(articleGoalContract());
    const current = packageWithSkill(base, skill);
    const designer = createLlmGoalDesigner(db, {
      model: "inline-goal-revision-test",
      client: {
        async generateText({ prompt }) {
          prompts.push(prompt);
          return JSON.stringify({
            kind: "revision",
            summary: "Updated the outcome boundary.",
            changedSliceIds: ["slice-article"],
            package: {
              evaluatorContracts: current.evaluatorContracts,
              slicePlan: {
                slices: [{
                  ...current.slicePlan.slices[0]!,
                  outcome: "deliver revised offline article",
                }],
              },
              compositionStrategy: current.compositionStrategy,
            },
          });
        },
      },
    });

    const result = await designer.revise({
      currentPackage: current,
      message: "make the article outcome more explicit",
      selectedSliceId: "slice-article",
    });

    assert.equal(result.kind, "revision");
    if (result.kind !== "revision") assert.fail("expected revision");
    assert.match(prompts[0] ?? "", /CurrentGoalDesignPackage/);
    assert.match(prompts[0] ?? "", /Do not change templatePolicy/);
    assert.equal(result.package.revision, current.revision + 1);
    assert.equal(result.package.parentRevision, current.revision);
    assert.equal(result.package.templatePolicy.mode, current.templatePolicy.mode);
    assert.equal(result.package.slicePlan.slices[0]!.outcome, "deliver revised offline article");
  } finally {
    await db.close();
  }
});

test("Goal Design skill resolution fails closed for zero or multiple approved SOPs", async () => {
  const db = await createTestPostgresDb();
  try {
    await assert.rejects(loadGoalDesignSkillPg(db), /exactly one approved Goal Design skill/);
    await upsertGoalDesignSkillObject(db, "skill.goal-design-a");
    await upsertGoalDesignSkillObject(db, "skill.goal-design-b");
    await assert.rejects(loadGoalDesignSkillPg(db), /exactly one approved Goal Design skill/);
  } finally {
    await db.close();
  }
});

test("Goal Design rejects duplicate requirement ownership and artifact-free dependencies", () => {
  const contract = articleGoalContract();
  const requirementId = contract.requirements[0]!.id;
  const pkg = packageValue(contract);
  const duplicateOwner: GoalDesignPackageV1 = {
    ...pkg,
    slicePlan: {
      ...pkg.slicePlan,
      slices: [
      slice("a", [requirementId], contract.expectedArtifactRefs),
      slice("b", [requirementId], contract.expectedArtifactRefs),
      ],
    },
  };

  assert.equal(
    validateGoalDesignPackage(duplicateOwner).some((issue) => issue.code === "requirement_owner_count"),
    true,
  );

  const falseDependency: GoalDesignPackageV1 = {
    ...pkg,
    slicePlan: {
      ...pkg.slicePlan,
      slices: [
      slice("a", [requirementId], contract.expectedArtifactRefs),
      slice("b", [], [], { dependsOnSliceIds: ["a"], dependencyArtifactRefs: [] }),
      ],
    },
    compositionStrategy: {
      ...pkg.compositionStrategy,
      sliceIds: ["a", "b"],
    },
  };
  assert.equal(
    validateGoalDesignPackage(falseDependency).some((issue) => issue.code === "dependency_without_artifact_flow"),
    true,
  );
});

test("Goal Design requires evaluator criteria to cover requirement criteria", () => {
  const contract = articleGoalContract();
  const pkg = packageValue(contract);
  const drifted: GoalDesignPackageV1 = {
    ...pkg,
    evaluatorContracts: [{
      ...pkg.evaluatorContracts[0]!,
      acceptanceCriteria: ["A different criterion invented by the evaluator"],
    }],
  };

  assert.equal(
    validateGoalDesignPackage(drifted).some((issue) => issue.code === "evaluator_criteria_mismatch"),
    true,
  );
});

test("Goal Design package hash is host-owned and tamper-evident", () => {
  const contract = articleGoalContract();
  const pkg = packageValue(contract);

  assert.equal(pkg.packageHash, goalDesignPackageHash(pkg));
  assert.equal(validateGoalDesignPackage({ ...pkg, packageHash: "bad" }).some((issue) => issue.code === "package_hash_mismatch"), true);
});

test("Slice designer receives confirmed bindings and cannot invent requirements or evaluator contracts", async () => {
  const prompts: string[] = [];
  const staged = stagedGoalInput();
  const binding = validationBinding(staged.requirementDraft, staged.goalContract);
  const pkg = await designGoalSlicesWithLlm({
    goalContract: staged.goalContract,
    requirementDraft: staged.requirementDraft,
    validationBindings: [binding],
    workspaceDiscovery: discovery(staged.goalContract.workspace.cwd),
    mode: "review_before_compose",
    templatePolicy: { mode: "auto" },
    skill: {
      objectKey: "skill.southstar-goal-design",
      versionRef: "skill.southstar-goal-design@v2",
      stateHash: "goal-design-state-v2",
      body: "# Southstar Goal Design\nCreate cohesive outcome slices from confirmed requirements.",
    },
    client: {
      async generateText({ prompt }) {
        prompts.push(prompt);
        return JSON.stringify({
          slicePlan: {
            slices: [{
              id: "article-delivery",
              requirementIds: [staged.goalContract.requirements[0]!.id],
              outcome: "Deliver the verified offline article",
              stateOrArtifactOwner: "article/article.html",
              mutationBoundary: "one self-contained HTML artifact",
              expectedArtifactRefs: binding.artifactContractRefs,
              evaluatorContractRefs: [binding.id],
              dependsOnSliceIds: [],
              dependencyArtifactRefs: [],
            }],
          },
          compositionStrategy: {
            mode: "single-run",
            sliceIds: ["article-delivery"],
            rationale: "one cohesive artifact boundary",
          },
        });
      },
    },
    model: "inline-slice-test",
  });

  assert.match(prompts[0] ?? "", /ValidationBindings:/);
  assert.match(prompts[0] ?? "", new RegExp(binding.evaluatorProfileRef));
  assert.doesNotMatch(prompts[0] ?? "", /evaluatorContracts/);
  assert.equal(pkg.schemaVersion, "southstar.goal_design_package.v2");
  assert.equal(pkg.requirementDraftHash, staged.requirementDraft.draftHash);
  assert.equal(pkg.validationBindings[0]!.evaluatorProfileRef, binding.evaluatorProfileRef);
  assert.deepEqual(pkg.slicePlan.slices[0]!.evaluatorContractRefs, [binding.id]);
  assert.equal(validateGoalDesignPackageV2(pkg).length, 0);
});

test("Package V2 rejects unresolved bindings, criteria drift, and Slice-owned invented binding refs", () => {
  const staged = stagedGoalInput();
  const binding = validationBinding(staged.requirementDraft, staged.goalContract);
  const pkg = packageV2(staged.requirementDraft, staged.goalContract, binding);
  const missingBindings: GoalDesignPackageV2 = {
    ...pkg,
    validationBindings: [],
  };
  assert.equal(
    validateGoalDesignPackageV2(missingBindings).some((issue) => issue.code === "requirement_missing_validation_binding"),
    true,
  );
  const drifted: GoalDesignPackageV2 = {
    ...pkg,
    validationBindings: [{ ...binding, acceptanceCriteria: ["invented criterion"] }],
  };
  assert.equal(
    validateGoalDesignPackageV2(drifted).some((issue) => issue.code === "binding_criteria_mismatch"),
    true,
  );
  const inventedRef: GoalDesignPackageV2 = {
    ...pkg,
    slicePlan: {
      ...pkg.slicePlan,
      slices: [{ ...pkg.slicePlan.slices[0]!, evaluatorContractRefs: ["binding.invented"] }],
    },
  };
  assert.equal(
    validateGoalDesignPackageV2(inventedRef).some((issue) => issue.code === "unknown_evaluator_ref"),
    true,
  );
});

function articleGoalContract(): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt: "Turn input.md into a self-contained article/article.html that opens offline",
    cwd: "/workspace/article",
    interpretation: {
      domain: "design/article",
      intent: "create_offline_article",
      workType: "general",
      summary: "Create an offline HTML article",
      requirements: [{
        statement: "The article opens without network access",
        acceptanceCriteria: ["article/article.html loads with the network disabled"],
        blocking: true,
        source: "explicit",
        expectedArtifacts: [{ description: "Self-contained article HTML", path: "article/article.html", mediaType: "text/html" }],
      }],
      expectedArtifactRefs: ["artifact.article_html"],
      requiredCapabilities: ["capability.workspace-read", "capability.workspace-write"],
      nonGoals: [],
      assumptions: [],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}

function stagedGoalInput(): { requirementDraft: GoalRequirementDraftV1; goalContract: GoalContractV1 } {
  const requirementDraft = finalizeGoalRequirementDraft({
    goalPrompt: "Turn input.md into a self-contained article/article.html that opens offline",
    cwd: "/workspace/article",
    summary: "Create an offline HTML article",
    requirements: [{
      title: "Offline delivery",
      statement: "The article opens without network access",
      source: "explicit",
      blocking: true,
      userVisibleBehaviors: ["Open the article locally"],
      businessRules: ["No network dependency"],
      acceptanceCriteria: [{
        statement: "article/article.html loads with the network disabled",
        evidenceIntent: ["browser interaction", "screenshot"],
      }],
      expectedOutcomeArtifacts: [{ description: "Self-contained article HTML", mediaType: "text/html" }],
      verificationIntent: ["Open with the network disabled"],
      assumptions: [],
      openQuestions: [],
      riskTags: [],
      interactionContractRefs: [],
    }],
    nonGoals: [],
    blockingInputs: [],
  });
  const goalContract = confirmGoalRequirementDraft(requirementDraft, {
    domain: "design/article",
    intent: "create_offline_article",
    workType: "general",
    expectedArtifactRefs: ["artifact.article-html"],
    requiredCapabilities: ["capability.workspace-read", "capability.workspace-write"],
    assumptions: [],
    requestedSideEffects: ["workspace-write"],
  });
  return { requirementDraft, goalContract };
}

function validationBinding(
  requirementDraft: GoalRequirementDraftV1,
  goalContract: GoalContractV1,
): RequirementValidationBindingV1 {
  const requirement = goalContract.requirements[0]!;
  const criterion = requirementDraft.requirements[0]!.acceptanceCriteria[0]!;
  return {
    schemaVersion: "southstar.requirement_validation_binding.v1",
    id: "binding.offline-article",
    requirementId: requirement.id,
    criterionIds: [criterion.id],
    acceptanceCriteria: [...requirement.acceptanceCriteria],
    artifactContractRefs: ["artifact.article-html"],
    artifactContractVersionRefs: ["artifact.article-html@v2"],
    evaluatorProfileRef: "evaluator.offline-browser",
    evaluatorProfileVersionRef: "evaluator.offline-browser@v3",
    verificationMode: "browser_interaction",
    criterionChecks: [{
      criterionId: criterion.id,
      procedureRef: "procedure.offline-open",
      expectedEvidenceKinds: ["screenshot"],
    }],
    requiredEvidenceKinds: ["screenshot"],
    independence: "independent",
    failureClassifications: ["network_dependency"],
  };
}

function packageV2(
  requirementDraft: GoalRequirementDraftV1,
  goalContract: GoalContractV1,
  binding: RequirementValidationBindingV1,
): GoalDesignPackageV2 {
  return finalizeGoalDesignPackageV2({
    schemaVersion: "southstar.goal_design_package.v2",
    revision: 1,
    goalContract,
    requirementDraftHash: requirementDraft.draftHash,
    validationBindings: [binding],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: 1,
      slices: [{
        id: "slice-offline-article",
        requirementIds: [goalContract.requirements[0]!.id],
        outcome: "Deliver the verified offline article",
        stateOrArtifactOwner: "article/article.html",
        mutationBoundary: "one self-contained HTML artifact",
        expectedArtifactRefs: binding.artifactContractRefs,
        evaluatorContractRefs: [binding.id],
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: ["slice-offline-article"],
      rationale: "one cohesive artifact boundary",
    },
    templatePolicy: { mode: "auto" },
    goalDesignSkillRef: "skill.southstar-goal-design",
    goalDesignSkillVersionRef: "skill.southstar-goal-design@v2",
    workspaceDiscoveryHash: "discovery-hash",
    mode: "review_before_compose",
  });
}

function discovery(cwd: string): WorkspaceGoalDiscoveryV1 {
  return {
    schemaVersion: "southstar.workspace_goal_discovery.v1",
    cwd,
    entries: [],
    instructionDocuments: [],
    projectMetadata: [],
    truncated: false,
    discoveryHash: "discovery-hash",
  };
}

function packageValue(
  goalContract: GoalContractV1,
  overrides: { slices?: GoalSliceV1[]; templatePolicy?: WorkflowTemplatePolicyV1 } = {},
): GoalDesignPackageV1 {
  const requirementId = goalContract.requirements[0]!.id;
  const evaluatorId = "eval-offline";
  const slices = overrides.slices ?? [slice("slice-article", [requirementId], goalContract.expectedArtifactRefs)];
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: 1,
    goalContract,
    evaluatorContracts: [{
      schemaVersion: "southstar.requirement_evaluator_contract.v1",
      id: evaluatorId,
      requirementId,
      acceptanceCriteria: [...goalContract.requirements[0]!.acceptanceCriteria],
      requiredEvidenceKinds: ["screenshot"],
      independence: "independent",
      failureClassifications: ["network_dependency"],
    }],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-fills",
      revision: 1,
      slices,
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: slices.map((candidate) => candidate.id),
      rationale: "one atomic artifact boundary",
    },
    templatePolicy: overrides.templatePolicy ?? { mode: "auto" },
    goalDesignSkillRef: "skill.southstar-goal-design",
    goalDesignSkillVersionRef: "skill.southstar-goal-design@v1",
    workspaceDiscoveryHash: "discovery-hash",
    mode: "review_before_compose",
  });
}

function packageWithSkill(
  current: GoalDesignPackageV1,
  skill: { objectKey: string; versionRef: string },
): GoalDesignPackageV1 {
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: current.revision,
    ...(current.parentRevision !== undefined ? { parentRevision: current.parentRevision } : {}),
    goalContract: current.goalContract,
    evaluatorContracts: current.evaluatorContracts,
    slicePlan: current.slicePlan,
    compositionStrategy: current.compositionStrategy,
    templatePolicy: current.templatePolicy,
    goalDesignSkillRef: skill.objectKey,
    goalDesignSkillVersionRef: skill.versionRef,
    workspaceDiscoveryHash: current.workspaceDiscoveryHash,
    mode: current.mode,
  });
}

function slice(
  id: string,
  requirementIds: string[],
  expectedArtifactRefs: string[],
  overrides: Partial<GoalSliceV1> = {},
): GoalSliceV1 {
  return {
    id,
    requirementIds,
    outcome: `outcome ${id}`,
    stateOrArtifactOwner: `owner ${id}`,
    mutationBoundary: `boundary ${id}`,
    expectedArtifactRefs,
    evaluatorContractRefs: ["eval-offline"],
    dependsOnSliceIds: [],
    dependencyArtifactRefs: [],
    ...overrides,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function syncGoalDesignSkill(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<void> {
  await syncLibraryFileToGraph(db, {
    root: join(import.meta.dirname, "../../library"),
    relativePath: "skills/southstar-goal-design.skill.md",
  });
}

async function upsertGoalDesignSkillObject(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  objectKey: string,
): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: `${objectKey}@v1`,
    state: {
      title: objectKey,
      scope: "global",
      purpose: "goal_design",
      body: "# Goal Design",
    },
  });
}
