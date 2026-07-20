import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { RequirementValidationBindingV1 } from "../../src/v2/design-library/types.ts";
import {
  confirmGoalRequirementDraft,
  finalizeGoalRequirementDraft,
  type GoalRequirementDraftV1,
} from "../../src/v2/orchestration/goal-requirement-draft.ts";
import {
  type GoalContractV1,
} from "../../src/v2/orchestration/goal-contract.ts";
import {
  designGoalSlicesWithLlm,
  finalizeGoalDesignPackageV2,
  loadGoalDesignSkillPg,
  reviseGoalSlicesWithLlm,
  validateGoalDesignPackageV2,
  type GoalDesignPackageV2,
  type WorkspaceGoalDiscoveryV1,
} from "../../src/v2/orchestration/goal-design.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

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

test("staged Slice designer revises Package V2 without changing frozen bindings", async () => {
  const staged = stagedGoalInput();
  const binding = validationBinding(staged.requirementDraft, staged.goalContract);
  const current = packageV2(staged.requirementDraft, staged.goalContract, binding);
  const result = await reviseGoalSlicesWithLlm({
    currentPackage: current,
    goalContract: staged.goalContract,
    requirementDraft: staged.requirementDraft,
    validationBindings: [binding],
    workspaceDiscovery: discovery(staged.goalContract.workspace.cwd),
    mode: "review_before_compose",
    templatePolicy: { mode: "auto" },
    skill: {
      objectKey: current.goalDesignSkillRef,
      versionRef: current.goalDesignSkillVersionRef,
      stateHash: "goal-design-state-v2",
      body: "Create cohesive outcome slices from confirmed requirements.",
    },
    message: "make the article outcome more explicit",
    selectedSliceId: current.slicePlan.slices[0]!.id,
    client: {
      async generateText({ prompt }) {
        assert.match(prompt, /CurrentGoalDesignPackage/);
        assert.match(prompt, /Frozen validation bindings|ValidationBindings/);
        return JSON.stringify({
          kind: "revision",
          summary: "Made the article outcome explicit.",
          changedSliceIds: ["article-delivery"],
          slicePlan: {
            slices: [{
              id: "article-delivery",
              requirementIds: [staged.goalContract.requirements[0]!.id],
              outcome: "Deliver the verified offline article with explicit offline loading",
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
    model: "inline-slice-revision-test",
  });

  assert.equal(result.kind, "revision");
  if (result.kind !== "revision") assert.fail("expected revision");
  assert.equal(result.changedSliceIds.length, 1);
  assert.equal(result.slicePlan.slices[0]!.evaluatorContractRefs[0], binding.id);
  assert.equal(result.slicePlan.slices[0]!.outcome, "Deliver the verified offline article with explicit offline loading");
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
        evidenceIntent: ["url", "screenshot"],
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
