import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { RequirementValidationBindingV3 } from "../../src/v2/design-library/types.ts";
import {
  confirmGoalRequirementDraft,
  finalizeGoalRequirementDraft,
  goalRequirementDraftHash,
  type GoalRequirementDraftV1,
} from "../../src/v2/orchestration/goal-requirement-draft.ts";
import {
  type GoalContractV1,
} from "../../src/v2/orchestration/goal-contract.ts";
import {
  designGoalSlicesWithLlm,
  finalizeGoalDesignPackageV3,
  goalDesignPackageV3FromUnknown,
  loadGoalDesignSkillPg,
  reviseGoalSlicesWithLlm,
  validateGoalDesignPackageV3,
  type GoalDesignPackageV3,
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

test("Goal Design Package V2 is rejected instead of reinterpreted with V3 provenance", () => {
  const staged = stagedGoalInput();
  const binding = validationBinding(staged.requirementDraft, staged.goalContract);
  const pkg = packageV3(staged.requirementDraft, staged.goalContract, binding);
  assert.equal(goalDesignPackageV3FromUnknown({
    ...pkg,
    schemaVersion: "southstar.goal_design_package.v2",
  }), undefined);
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
              expectedArtifactRefs: binding.criterionBindings.map((item) => item.artifactContractRef),
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
  assert.match(prompts[0] ?? "", new RegExp(binding.criterionBindings[0]!.evaluatorProfileRef));
  assert.doesNotMatch(prompts[0] ?? "", /evaluatorContracts/);
  assert.equal(pkg.schemaVersion, "southstar.goal_design_package.v3");
  assert.equal(pkg.requirementDraftHash, staged.requirementDraft.draftHash);
  assert.equal(pkg.criterionPromptVersion, "southstar.goal_requirement.atomic_criterion.v1");
  assert.match(pkg.criterionSchemaHash, /^[a-f0-9]{64}$/);
  assert.equal(
    pkg.validationBindings[0]!.criterionBindings[0]!.evaluatorProfileRef,
    binding.criterionBindings[0]!.evaluatorProfileRef,
  );
  assert.deepEqual(pkg.slicePlan.slices[0]!.evaluatorContractRefs, [binding.id]);
  assert.equal(validateGoalDesignPackageV3(pkg).length, 0);
});

test("Slice designer rejects Criterion contract drift even when the observable claim is unchanged", async () => {
  const staged = stagedGoalInput();
  const binding = validationBinding(staged.requirementDraft, staged.goalContract);
  const drifted = structuredClone(staged.requirementDraft);
  drifted.requirements[0]!.acceptanceCriteria[0]!.requiredAssurance = ["browser_interaction"];
  const { draftHash: _draftHash, ...withoutDraftHash } = drifted;
  drifted.draftHash = goalRequirementDraftHash(withoutDraftHash);
  let called = false;

  await assert.rejects(
    () => designGoalSlicesWithLlm({
      goalContract: staged.goalContract,
      requirementDraft: drifted,
      validationBindings: [binding],
      workspaceDiscovery: discovery(staged.goalContract.workspace.cwd),
      mode: "review_before_compose",
      templatePolicy: { mode: "auto" },
      skill: {
        objectKey: "skill.southstar-goal-design",
        versionRef: "skill.southstar-goal-design@v2",
        stateHash: "goal-design-state-v2",
        body: "Create cohesive outcome slices from confirmed requirements.",
      },
      client: {
        async generateText() {
          called = true;
          throw new Error("Slice LLM must not run for stale Criterion lineage");
        },
      },
      model: "inline-slice-contract-drift",
    }),
    /confirmed requirement does not match Goal Contract/,
  );
  assert.equal(called, false);
});

test("staged Slice designer revises Package V3 without changing frozen bindings", async () => {
  const staged = stagedGoalInput();
  const binding = validationBinding(staged.requirementDraft, staged.goalContract);
  const current = packageV3(staged.requirementDraft, staged.goalContract, binding);
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
              expectedArtifactRefs: binding.criterionBindings.map((item) => item.artifactContractRef),
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

test("Package V3 rejects unresolved bindings, criteria drift, and Slice-owned invented binding refs", () => {
  const staged = stagedGoalInput();
  const binding = validationBinding(staged.requirementDraft, staged.goalContract);
  const pkg = packageV3(staged.requirementDraft, staged.goalContract, binding);
  const missingBindings: GoalDesignPackageV3 = {
    ...pkg,
    validationBindings: [],
  };
  assert.equal(
    validateGoalDesignPackageV3(missingBindings).some((issue) => issue.code === "requirement_missing_validation_binding"),
    true,
  );
  const drifted: GoalDesignPackageV3 = {
    ...pkg,
    validationBindings: [{
      ...binding,
      criterionBindings: binding.criterionBindings.map((item, index) => index === 0 ? {
        ...item,
        criterionContract: { ...item.criterionContract, observableClaim: "invented criterion" },
      } : item),
    }],
  };
  assert.equal(
    validateGoalDesignPackageV3(drifted).some((issue) => issue.code === "binding_criteria_mismatch"),
    true,
  );
  const legacyBinding: GoalDesignPackageV3 = {
    ...pkg,
    validationBindings: [{
      ...binding,
      schemaVersion: "southstar.requirement_validation_binding.v2",
    } as unknown as RequirementValidationBindingV3],
  };
  assert.equal(
    validateGoalDesignPackageV3(legacyBinding).some((issue) => issue.code === "invalid_validation_binding"),
    true,
  );
  const inventedCriterionId: GoalDesignPackageV3 = {
    ...pkg,
    validationBindings: [{
      ...binding,
      criterionBindings: [{
        ...binding.criterionBindings[0]!,
        criterionContract: {
          ...binding.criterionBindings[0]!.criterionContract,
          id: "criterion.invented",
        },
      }, ...binding.criterionBindings.slice(1)],
    }],
  };
  assert.equal(
    validateGoalDesignPackageV3(inventedCriterionId).some((issue) => issue.code === "binding_criteria_mismatch"),
    true,
  );
  const reversedCriteria: GoalDesignPackageV3 = {
    ...pkg,
    validationBindings: [{
      ...binding,
      criterionBindings: [...binding.criterionBindings].reverse(),
    }],
  };
  assert.equal(
    validateGoalDesignPackageV3(reversedCriteria).some((issue) => issue.code === "binding_criteria_mismatch"),
    true,
  );
  const inventedRef: GoalDesignPackageV3 = {
    ...pkg,
    slicePlan: {
      ...pkg.slicePlan,
      slices: [{ ...pkg.slicePlan.slices[0]!, evaluatorContractRefs: ["binding.invented"] }],
    },
  };
  assert.equal(
    validateGoalDesignPackageV3(inventedRef).some((issue) => issue.code === "unknown_evaluator_ref"),
    true,
  );
});

test("validation binding freezes the complete confirmed Criterion contract", () => {
  const staged = stagedGoalInput();
  const binding = validationBinding(staged.requirementDraft, staged.goalContract);
  assert.deepEqual(
    binding.criterionBindings.map((item) => item.criterionContract),
    staged.goalContract.requirements[0]!.acceptanceCriteria,
  );
});

test("Goal Design requires an audited risk acceptance when an assurance child is omitted", () => {
  const staged = stagedGoalInput();
  const binding = validationBinding(staged.requirementDraft, staged.goalContract);
  const base = packageV3(staged.requirementDraft, staged.goalContract, binding);
  const originalCriterion = staged.goalContract.requirements[0]!.acceptanceCriteria[1]!;
  const withoutDerivedHashes = (pkg: GoalDesignPackageV3) => {
    const {
      goalContractHash: _goalContractHash,
      validationBindingsHash: _validationBindingsHash,
      slicePlanHash: _slicePlanHash,
      packageHash: _packageHash,
      criterionPromptVersion: _criterionPromptVersion,
      criterionSchemaHash: _criterionSchemaHash,
      ...input
    } = pkg;
    return input;
  };
  const acceptance = {
    schemaVersion: "southstar.assurance_risk_acceptance.v1" as const,
    id: "assurance-risk-acceptance-test",
    criterionId: originalCriterion.id,
    criterionVersion: originalCriterion.version,
    omittedAssurance: ["browser_interaction"] as const,
    reason: "The deterministic artifact evidence is sufficient for this bounded release.",
    approvalId: "assurance-approval-test",
    approvedBy: "operator:test",
    approvedAt: "2026-07-21T00:00:00.000Z",
    auditEventRef: "assurance-risk-acceptance-audit-test",
  };
  const bindingWithoutOriginalCriterion = binding.criterionBindings.filter((child) => child.criterionContract.id !== originalCriterion.id);
  const baseWithOmittedCriterionArtifact = {
    ...base,
    slicePlan: {
      ...base.slicePlan,
      slices: base.slicePlan.slices.map((slice) => ({
        ...slice,
        expectedArtifactRefs: bindingWithoutOriginalCriterion.map((child) => child.artifactContractRef),
      })),
    },
  };
  assert.throws(() => finalizeGoalDesignPackageV3({
    ...withoutDerivedHashes(baseWithOmittedCriterionArtifact),
    validationBindings: [{
      ...binding,
      criterionBindings: bindingWithoutOriginalCriterion,
    }],
  }), /binding criteria must preserve confirmed Criterion identity and order|invalid Goal Design package/);
  const accepted = finalizeGoalDesignPackageV3({
    ...withoutDerivedHashes(baseWithOmittedCriterionArtifact),
    validationBindings: [{
      ...binding,
      criterionBindings: bindingWithoutOriginalCriterion,
    }],
    assuranceRiskAcceptances: [acceptance],
  });
  assert.deepEqual(validateGoalDesignPackageV3(accepted), []);
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
      acceptanceCriteria: [
        {
          observableClaim: "article/article.html exists as one accepted HTML artifact",
          blocking: true,
          verificationIntent: ["Inspect the accepted artifact path and media type"],
          requiredAssurance: ["deterministic"],
          evidenceIntent: ["artifact-ref"],
        },
        {
          observableClaim: "article/article.html loads with the network disabled",
          blocking: true,
          verificationIntent: ["Open the accepted article artifact while network access is disabled"],
          requiredAssurance: ["browser_interaction"],
          evidenceIntent: ["url", "screenshot"],
        },
      ],
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
): RequirementValidationBindingV3 {
  const requirement = goalContract.requirements[0]!;
  const criteria = requirementDraft.requirements[0]!.acceptanceCriteria;
  return {
    schemaVersion: "southstar.requirement_validation_binding.v3",
    id: "binding.offline-article",
    requirementId: requirement.id,
    criterionBindings: criteria.map((criterion, index) => ({
      criterionContract: { ...requirement.acceptanceCriteria[index]! },
      artifactContractRef: index === 0 ? "artifact.article-source" : "artifact.article-html",
      artifactContractVersionRef: index === 0 ? "artifact.article-source@v1" : "artifact.article-html@v2",
      evaluatorProfileRef: index === 0 ? "evaluator.article-structure" : "evaluator.offline-browser",
      evaluatorProfileVersionRef: index === 0 ? "evaluator.article-structure@v1" : "evaluator.offline-browser@v3",
      verificationMode: criterion.requiredAssurance[0]!,
      procedureRef: index === 0 ? "procedure.artifact-exists" : "procedure.offline-open",
      expectedEvidenceKinds: index === 0 ? ["artifact-ref"] : ["screenshot"],
      independence: "independent",
      failureClassifications: index === 0 ? ["artifact_missing"] : ["network_dependency"],
    })),
  };
}

function packageV3(
  requirementDraft: GoalRequirementDraftV1,
  goalContract: GoalContractV1,
  binding: RequirementValidationBindingV3,
): GoalDesignPackageV3 {
  return finalizeGoalDesignPackageV3({
    schemaVersion: "southstar.goal_design_package.v3",
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
        expectedArtifactRefs: binding.criterionBindings.map((item) => item.artifactContractRef),
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
