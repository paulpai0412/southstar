import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { findLibraryObjectByKey, upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { installLibraryImportCandidates } from "../../src/v2/design-library/importers/library-import-draft-store.ts";
import { reconcileLibraryFilesPg } from "../../src/v2/design-library/files/library-reconcile-service.ts";
import type { LibraryImportLlmProvider } from "../../src/v2/design-library/importers/library-llm-import-analyzer.ts";
import { contentHashForPayload } from "../../src/v2/design-library/canonical-json.ts";
import type { GoalValidationResolutionV2, WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import {
  DeterministicFixtureComposer,
  alignFixtureCompositionWithGoalDesignPackage,
  deterministicFixtureComposition,
  seedDeterministicWorkflowGraph,
} from "./fixtures/deterministic-workflow-composer.ts";
import { createWorkflowRunPg, getResourceByKeyPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  finalizeGoalContract,
  goalContractHash,
  requirementSpecFromGoalContract,
  type GoalContractInterpreter,
  type GoalContractV1,
} from "../../src/v2/orchestration/goal-contract.ts";
import {
  finalizeGoalDesignPackageV3,
  type GoalDesignPackageV3,
  type GoalSliceDesigner,
} from "../../src/v2/orchestration/goal-design.ts";
import {
  confirmGoalRequirementsPg,
  designAndPersistGoalSlicesPg,
  loadCurrentGoalDesignPackagePg,
  loadCurrentGoalRequirementDraftPg,
  resolveAndPersistGoalValidationPg,
  resumeGoalValidationAfterLibraryImportPg,
  persistGoalValidationResolutionPg,
  createStagedGoalSliceRevisionPg,
  persistGoalRequirementDraftRevisionPg,
  preparePostgresGoalRequirementDraft,
  reviseGoalDesignFromChatPg,
  reviseGoalSlicePg,
  reviseGoalTemplatePolicyPg,
  reviseGoalRequirementPg,
  reviseGoalRequirementFromChatPg,
  loadCurrentUiInteractionContractPg,
  reviseUiInteractionContractPg,
} from "../../src/v2/orchestration/goal-design-draft-service.ts";
import { finalizeGoalRequirementDraft, goalRequirementDraftHash, type GoalRequirementDraftInputV1 } from "../../src/v2/orchestration/goal-requirement-draft.ts";
import { finalizeUiInteractionContract } from "../../src/v2/orchestration/ui-interaction-contract.ts";
import { resolveGoalValidationPg } from "../../src/v2/orchestration/goal-validation-resolver.ts";
import {
  createPostgresPlannerDraft as createCanonicalPostgresPlannerDraft,
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
  patchPostgresPlannerDraftTaskProfileOverride,
  type CreatePostgresPlannerDraftInput,
  validatePostgresPlannerDraft,
} from "../../src/v2/ui-api/postgres-run-api.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { confirmGoalDesignPg } from "../../src/v2/orchestration/run-goal-service.ts";
import { resolveTestPostgresAdminUrl } from "./postgres-test-utils.ts";
import { fixedGoalInterpreter, softwareGoalContract } from "./fixtures/goal-contract.ts";
import { canonicalGoalDesignPackageFixture } from "./fixtures/goal-design.ts";

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

test("planner draft creation rejects missing and incompatible Goal Design packages", async () => {
  await withDb(async (db) => {
    const goalContract = softwareGoalContract("reject non-canonical planner creation");
    for (const [packageValue, expectedCode] of [
      [undefined, "canonical_goal_design_package_required"],
      [{ schemaVersion: "southstar.goal_design_package.v1" }, "canonical_goal_design_package_invalid"],
      [{ schemaVersion: "southstar.goal_design_package.v3" }, "canonical_goal_design_package_invalid"],
    ] as const) {
      let interpreterCalled = false;
      await assert.rejects(
        () => createCanonicalPostgresPlannerDraft(db, {
          goalPrompt: goalContract.originalPrompt,
          cwd: goalContract.workspace.cwd,
          goalInterpreter: {
            async interpret() {
              interpreterCalled = true;
              return goalContract;
            },
          },
          ...(packageValue === undefined ? {} : { goalDesignPackage: packageValue }),
        } as unknown as CreatePostgresPlannerDraftInput),
        new RegExp(expectedCode),
      );
      assert.equal(interpreterCalled, false);
    }
    await assert.rejects(
      () => createCanonicalPostgresPlannerDraft(db, {
        goalPrompt: goalContract.originalPrompt,
        cwd: goalContract.workspace.cwd,
        goalInterpreter: fixedGoalInterpreter(goalContract),
        goalDesignPackage: canonicalGoalDesignPackageFixture(goalContract),
        goalRequirementDraftHash: "0".repeat(64),
      }),
      /canonical_goal_design_package_invalid: Goal Design package requirementDraftHash does not match/,
    );
  });
});

async function createCanonicalPlannerDraftFixture(
  db: SouthstarDb,
  input: Omit<CreatePostgresPlannerDraftInput, "goalDesignPackage"> & {
    goalDesignPackage?: CreatePostgresPlannerDraftInput["goalDesignPackage"];
  },
) {
  if (input.goalDesignPackage) {
    return await createCanonicalPostgresPlannerDraft(db, input as CreatePostgresPlannerDraftInput);
  }
  const snapshot = {
    ...input,
    ...(input.libraryHints ? { libraryHints: structuredClone(input.libraryHints) } : {}),
    ...(input.compositionPlan ? { compositionPlan: structuredClone(input.compositionPlan) } : {}),
  };
  const goalContract = input.goalDesignPackage?.goalContract ?? await input.goalInterpreter.interpret({
      goalPrompt: input.goalPrompt,
      cwd: input.cwd ?? process.cwd(),
      libraryVocabulary: { scopes: [], capabilityRefs: [], artifactRefs: [], evaluatorRefs: [] },
    });
  const goalDesignPackage = input.goalDesignPackage
    ?? canonicalGoalDesignPackageFixture(goalContract, input.goalRequirementDraftHash);
  const compositionPlan = snapshot.compositionPlan
    ? alignFixtureCompositionWithGoalDesignPackage(snapshot.compositionPlan, goalDesignPackage)
    : undefined;
  const composer = snapshot.composer
    ? {
        async compose(composeInput: ComposeWorkflowInput) {
          return alignFixtureCompositionWithGoalDesignPackage(
            await snapshot.composer!.compose(composeInput),
            goalDesignPackage,
          );
        },
      }
    : undefined;
  await seedCanonicalValidationEdges(db, goalDesignPackage);
  return await createCanonicalPostgresPlannerDraft(db, {
    ...snapshot,
    goalInterpreter: input.goalDesignPackage ? input.goalInterpreter : fixedGoalInterpreter(goalContract),
    goalDesignPackage,
    ...(compositionPlan ? { compositionPlan } : {}),
    ...(composer ? { composer } : {}),
  });
}

async function seedCanonicalValidationEdges(
  db: SouthstarDb,
  goalDesignPackage: CreatePostgresPlannerDraftInput["goalDesignPackage"],
): Promise<void> {
  for (const binding of goalDesignPackage.validationBindings) {
    for (const criterionBinding of binding.criterionBindings) {
      const artifactRef = criterionBinding.artifactContractRef;
      const current = await findLibraryObjectByKey(db, artifactRef);
      await upsertLibraryObject(db, {
        objectKey: artifactRef,
        objectKind: "artifact_contract",
        status: "approved",
        headVersionId: criterionBinding.artifactContractVersionRef,
        state: {
          ...(current?.state ?? {}),
          scope: goalDesignPackage.goalContract.domain,
          artifactType: "implementation_report",
          requiredFields: ["summary"],
          evidenceFields: ["summary"],
          mediaTypes: ["application/json"],
          validationRules: ["Must describe the implemented requirement."],
          evidenceKinds: ["test-result"],
          schemaRef: "southstar.artifact.implementation_report.v1",
          provenanceRequirements: ["workspace-artifact"],
        },
      });
    }
    const evaluatorRefs = new Set(binding.criterionBindings.map((criterionBinding) => criterionBinding.evaluatorProfileRef));
    for (const evaluatorRef of evaluatorRefs) {
      const evaluator = await findLibraryObjectByKey(db, evaluatorRef);
      const evaluatorBindings = binding.criterionBindings.filter((criterionBinding) => criterionBinding.evaluatorProfileRef === evaluatorRef);
      await upsertLibraryObject(db, {
        objectKey: evaluatorRef,
        objectKind: "evaluator_profile",
        status: "approved",
        headVersionId: evaluatorBindings[0]!.evaluatorProfileVersionRef,
        state: {
          ...(evaluator?.state ?? {}),
          scope: goalDesignPackage.goalContract.domain,
          evaluators: [{ id: `${evaluatorRef}-schema`, kind: "schema", config: {}, required: true }],
          onFailure: { defaultStrategy: "request-workflow-revision" },
          requiredInputs: ["accepted-artifact"],
          evidenceKinds: [...new Set(evaluatorBindings.flatMap((criterionBinding) => criterionBinding.expectedEvidenceKinds))],
          verificationModes: [...new Set(evaluatorBindings.map((criterionBinding) => criterionBinding.verificationMode))],
          verificationProcedures: evaluatorBindings.map((criterionBinding) => ({
            id: criterionBinding.procedureRef,
            checkKind: criterionBinding.verificationMode,
            instruction: "Verify the accepted implementation report against the frozen criterion.",
            allowedEvidenceKinds: [...criterionBinding.expectedEvidenceKinds],
          })),
          resultSchemaRef: "southstar.requirement_evaluator_result.v2",
          independencePolicy: "independent",
          failureClassifications: [...new Set(evaluatorBindings.flatMap((criterionBinding) => criterionBinding.failureClassifications))],
        },
      });
    }
  }
  const artifacts = await db.query<{ object_key: string }>(
    "select object_key from southstar.library_objects where status = 'approved' and object_kind = 'artifact_contract'",
  );
  for (const evaluatorRef of new Set(goalDesignPackage.validationBindings.flatMap((binding) => binding.criterionBindings.map((criterionBinding) => criterionBinding.evaluatorProfileRef)))) {
    for (const artifact of artifacts.rows) {
      await upsertLibraryEdge(db, {
        fromObjectKey: evaluatorRef,
        edgeType: "validates_artifact",
        toObjectKey: artifact.object_key,
        scope: goalDesignPackage.goalContract.domain,
      });
    }
  }
}

const FIXTURE_TASK_IDS = [
  "understand-repo",
  "review-spec",
  "implement-feature",
  "verify-feature",
  "review-code-quality",
  "summarize-completion",
];

test("Goal submission persists requirements_review before Slice design", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const result = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: "Create an offline article",
      cwd,
      requirementInterpreter: requirementDraftInterpreter("Create an offline article", cwd),
    });
    assert.equal(result.status, "requirements_review");
    assert.equal(result.phase, "requirements_review");
    assert.equal(result.confirmable, true);
    assert.deepEqual(result.validationIssues, []);
    const stored = await getResourceByKeyPg(db, "planner_draft", result.draftId);
    assert.equal((stored!.payload as Record<string, unknown>).goalDesignPhase, "requirements_review");
    assert.equal((stored!.payload as Record<string, unknown>).goalRequirementDraftId, result.draftId);
    assert.equal((stored!.payload as Record<string, unknown>).goalRequirementDraftHash, result.goalRequirementDraftHash);
    assert.equal(((stored!.payload as Record<string, any>).goalRequirementDraft as { revision: number }).revision, 1);
    assert.equal((stored!.payload as Record<string, unknown>).goalDesignPackage, undefined);
    assert.deepEqual(await loadCurrentGoalRequirementDraftPg(db, result.draftId), result.goalRequirementDraft);
    const orchestration = await getPostgresPlannerDraftOrchestration(db, { draftId: result.draftId });
    assert.equal("goalContractHash" in orchestration, false);
    assert.equal(orchestration.goalRequirementDraftId, result.draftId);
    assert.equal(orchestration.goalRequirementDraftHash, result.goalRequirementDraftHash);
    assert.equal(orchestration.confirmable, true);
    assert.deepEqual(orchestration.validationIssues, []);
    assert.equal((stored!.payload as Record<string, unknown>).confirmable, true);
    assert.deepEqual((stored!.payload as Record<string, unknown>).validationIssues, []);
    assert.equal((stored!.summary as Record<string, unknown>).confirmable, true);
    assert.deepEqual((stored!.summary as Record<string, unknown>).validationIssues, []);
  });
});

test("Goal submission persists blocking open questions for requirements review and blocks confirmation", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Create an offline article with a review decision";
    const input = validGoalRequirementDraftInput(goalPrompt, cwd);
    input.requirements[0]!.openQuestions = ["Should the review decision be persisted locally?"];
    const semanticDraft = finalizeGoalRequirementDraft(input);
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return semanticDraft; },
        async revise() { return { kind: "revision", draft: semanticDraft, summary: "unchanged" }; },
      },
    });

    assert.equal(draft.status, "requirements_review");
    assert.equal(draft.confirmable, false);
    assert.ok(draft.validationIssues.some((entry) => entry.code === "blocking_requirement_has_open_question"));
    assert.ok(await getResourceByKeyPg(db, "planner_draft", draft.draftId));
    assert.deepEqual(await loadCurrentGoalRequirementDraftPg(db, draft.draftId), semanticDraft);
    await assert.rejects(
      () => confirmGoalRequirementsPg(db, {
        draftId: draft.draftId,
        expectedDraftHash: draft.goalRequirementDraftHash,
        goalContractMetadata: {
          domain: "design/article",
          intent: "review",
          workType: "general",
          expectedArtifactRefs: [],
          requiredCapabilities: [],
          assumptions: [],
          requestedSideEffects: [],
        },
      }),
      /goal_requirement_not_confirmable/,
    );
  });
});

test("visual requirements remain unconfirmable until a versioned UI contract is confirmed", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Create a review interaction";
    const semanticDraft = visualRequirementDraft(goalPrompt, cwd);
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return semanticDraft; },
        async revise() { return { kind: "revision", draft: semanticDraft, summary: "unchanged" }; },
      },
    });
    assert.equal(draft.confirmable, false);
    assert.ok(draft.validationIssues.some((entry) => entry.code === "missing_ui_interaction_contract"));
    await assert.rejects(
      () => confirmGoalRequirementsPg(db, {
        draftId: draft.draftId,
        expectedDraftHash: draft.goalRequirementDraftHash,
        goalContractMetadata: {
          domain: "design/article",
          intent: "review",
          workType: "general",
          expectedArtifactRefs: [],
          requiredCapabilities: [],
          assumptions: [],
          requestedSideEffects: [],
        },
      }),
      /goal_requirement_not_confirmable/,
    );

    const requirement = draft.goalRequirementDraft.requirements[0]!;
    const created = await reviseUiInteractionContractPg(db, {
      draftId: draft.draftId,
      contractId: "ui-review",
      contract: visualContractInput(requirement.id, requirement.acceptanceCriteria[0]!.id),
    });
    assert.equal(created.confirmable, false);
    assert.ok(created.validationIssues.some((entry) => entry.code === "unconfirmed_ui_interaction_contract"));
    const contract = created.uiInteractionContracts![0]!;
    const confirmed = await reviseUiInteractionContractPg(db, {
      draftId: draft.draftId,
      contractId: contract.id,
      expectedContractHash: contract.contractHash,
      patch: { kind: "confirm" },
    });
    assert.equal(confirmed.confirmable, true);
    assert.deepEqual(confirmed.validationIssues, []);
    const current = await loadCurrentUiInteractionContractPg(db, { draftId: draft.draftId, contractId: "ui-review" });
    assert.equal(current.status, "confirmed");
    assert.equal(current.revision, 2);
    assert.equal(current.parentRevision, 1);
    assert.ok(await getResourceByKeyPg(db, "ui_interaction_contract_revision", `${draft.draftId}:ui-review:revision:1`));
    assert.ok(await getResourceByKeyPg(db, "ui_interaction_contract_revision", `${draft.draftId}:ui-review:revision:2`));
  });
});

test("Requirement preparation persists LLM-designed UI contracts before visual review", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Create a review interaction";
    const semanticDraft = visualRequirementDraft(goalPrompt, cwd);
    const requirement = semanticDraft.requirements[0]!;
    const generatedContract = finalizeUiInteractionContract(
      visualContractInput(requirement.id, requirement.acceptanceCriteria[0]!.id),
      semanticDraft,
      { id: "ui-review" },
    );
    const result = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return semanticDraft; },
        async revise() { return { kind: "revision", draft: semanticDraft, summary: "unchanged" }; },
        async designUiInteractionContracts() { return [generatedContract]; },
      },
    });
    assert.equal(result.confirmable, false);
    assert.equal(result.validationIssues.some((entry) => entry.code === "missing_ui_interaction_contract"), false);
    assert.equal(result.validationIssues.some((entry) => entry.code === "unconfirmed_ui_interaction_contract"), true);
    const stored = await loadCurrentUiInteractionContractPg(db, { draftId: result.draftId, contractId: "ui-review" });
    assert.equal(stored.contractHash, generatedContract.contractHash);
    assert.equal(stored.status, "draft");
  });
});

test("Requirement revisions preserve reviewable UI contracts when their bindings remain valid", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Create a review interaction";
    const semanticDraft = visualRequirementDraft(goalPrompt, cwd);
    const requirement = semanticDraft.requirements[0]!;
    const generatedContract = finalizeUiInteractionContract(
      visualContractInput(requirement.id, requirement.acceptanceCriteria[0]!.id),
      semanticDraft,
      { id: "ui-review" },
    );
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return semanticDraft; },
        async revise() { return { kind: "revision", draft: semanticDraft, summary: "unchanged" }; },
        async designUiInteractionContracts() { return [generatedContract]; },
      },
    });

    const revised = await reviseGoalRequirementPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      requirementId: requirement.id,
      patch: { statement: "A learner can reveal the answer for a card after clarification." },
    });

    assert.equal(revised.uiInteractionContracts?.length, 1);
    assert.equal(revised.uiInteractionContracts?.[0]?.id, "ui-review");
    assert.equal(revised.validationIssues.some((entry) => entry.code === "missing_ui_interaction_contract"), false);
    assert.equal(revised.validationIssues.some((entry) => entry.code === "unconfirmed_ui_interaction_contract"), true);
    assert.equal((await loadCurrentUiInteractionContractPg(db, { draftId: draft.draftId, contractId: "ui-review" })).status, "draft");
    const persisted = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal((persisted?.payload as { uiInteractionContractHashes?: Record<string, string> }).uiInteractionContractHashes?.["ui-review"], revised.uiInteractionContracts?.[0]?.contractHash);
  });
});

test("Requirement revisions preserve unaffected UI contracts when regeneration is partial", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Create two review interactions";
    const semanticDraft = multiVisualRequirementDraft(goalPrompt, cwd);
    const firstRequirement = semanticDraft.requirements[0]!;
    const secondRequirement = semanticDraft.requirements[1]!;
    const firstContract = finalizeUiInteractionContract(
      visualContractInput(firstRequirement.id, firstRequirement.acceptanceCriteria[0]!.id),
      semanticDraft,
      { id: "ui-review-first" },
    );
    const secondContract = finalizeUiInteractionContract(
      visualContractInput(secondRequirement.id, secondRequirement.acceptanceCriteria[0]!.id),
      semanticDraft,
      { id: "ui-review-second" },
    );
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return semanticDraft; },
        async revise() { return { kind: "revision", draft: semanticDraft, summary: "unchanged" }; },
        async designUiInteractionContracts() { return [firstContract, secondContract]; },
      },
    });

    const revised = await reviseGoalRequirementPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      requirementId: firstRequirement.id,
      patch: { statement: "The first learner can reveal the answer for a card after clarification." },
      uiInteractionContracts: [firstContract],
    });

    assert.deepEqual(
      revised.uiInteractionContracts?.map((contract) => contract.id).sort(),
      ["ui-review-first", "ui-review-second"],
    );
    assert.equal(revised.validationIssues.some((entry) => entry.code === "missing_ui_interaction_contract"), false);
    assert.equal(await loadCurrentUiInteractionContractPg(db, {
      draftId: draft.draftId,
      contractId: "ui-review-second",
    }).then((contract) => contract.status), "draft");
  });
});

test("Missing current UI contracts can be recovered from persisted revisions", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Recover a review interaction";
    const semanticDraft = visualRequirementDraft(goalPrompt, cwd);
    const requirement = semanticDraft.requirements[0]!;
    const generatedContract = finalizeUiInteractionContract(
      visualContractInput(requirement.id, requirement.acceptanceCriteria[0]!.id),
      semanticDraft,
      { id: "ui-review" },
    );
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return semanticDraft; },
        async revise() { return { kind: "revision", draft: semanticDraft, summary: "unchanged" }; },
        async designUiInteractionContracts() { return [generatedContract]; },
      },
    });
    await db.query(
      `update southstar.runtime_resources
          set payload_json = payload_json - 'uiInteractionContracts' - 'uiInteractionContractHashes'
        where resource_type = 'planner_draft' and resource_key = $1`,
      [draft.draftId],
    );
    const recovered = await loadCurrentUiInteractionContractPg(db, {
      draftId: draft.draftId,
      contractId: "ui-review",
    });
    assert.equal(recovered.status, "draft");
    assert.equal(recovered.revision, 2);
    const confirmed = await reviseUiInteractionContractPg(db, {
      draftId: draft.draftId,
      contractId: recovered.id,
      expectedContractHash: recovered.contractHash,
      patch: { kind: "confirm" },
    });
    assert.equal(confirmed.uiInteractionContracts?.[0]?.status, "confirmed");
    assert.equal(confirmed.validationIssues.some((entry) => entry.code === "missing_ui_interaction_contract"), false);
  });
});

test("Changed requirement criteria rebase a persisted UI contract for review", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Rebase a review interaction";
    const semanticDraft = visualRequirementDraft(goalPrompt, cwd);
    const requirement = semanticDraft.requirements[0]!;
    const generatedContract = finalizeUiInteractionContract(
      visualContractInput(requirement.id, requirement.acceptanceCriteria[0]!.id),
      semanticDraft,
      { id: "ui-review" },
    );
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return semanticDraft; },
        async revise() { return { kind: "revision", draft: semanticDraft, summary: "unchanged" }; },
        async designUiInteractionContracts() { return [generatedContract]; },
      },
    });

    const revised = await reviseGoalRequirementPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      requirementId: requirement.id,
      patch: { acceptanceCriteria: [{
        ...atomicCriterion("Reveal changes the card into its answer state."),
        id: requirement.acceptanceCriteria[0]!.id,
      }] },
    });

    assert.equal(revised.validationIssues.some((entry) => entry.code === "missing_ui_interaction_contract"), false);
    const recovered = await loadCurrentUiInteractionContractPg(db, {
      draftId: draft.draftId,
      contractId: "ui-review",
    });
    assert.equal(recovered.status, "draft");
    assert.equal(recovered.revision, 2);
    assert.equal(recovered.criterionBindings[0]?.criterionId, revised.goalRequirementDraft.requirements[0]?.acceptanceCriteria[0]?.id);
  });
});

test("Chat requirement revisions regenerate missing UI contracts for visual requirements", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Create a review interaction";
    const semanticDraft = visualRequirementDraft(goalPrompt, cwd);
    const requirement = semanticDraft.requirements[0]!;
    const generatedContract = finalizeUiInteractionContract(
      visualContractInput(requirement.id, requirement.acceptanceCriteria[0]!.id),
      semanticDraft,
      { id: "ui-review" },
    );
    let designCalls = 0;
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return semanticDraft; },
        async revise() { return { kind: "revision", draft: semanticDraft, summary: "unchanged" }; },
        async designUiInteractionContracts() {
          designCalls += 1;
          return designCalls === 1 ? [] : [generatedContract];
        },
      },
    });
    assert.ok(draft.validationIssues.some((entry) => entry.code === "missing_ui_interaction_contract"));

    const revised = await reviseGoalRequirementFromChatPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      message: "Keep the requirement and regenerate the visual contract for review.",
      selectedRequirementId: requirement.id,
      requirementInterpreter: {
        async interpret() { return semanticDraft; },
        async revise() { return { kind: "revision", draft: semanticDraft, summary: "unchanged" }; },
        async designUiInteractionContracts() { return [generatedContract]; },
      },
    });

    if ("kind" in revised) assert.fail("expected a persisted revision");
    assert.equal(revised.uiInteractionContracts?.length, 1);
    assert.equal(revised.uiInteractionContracts?.[0]?.id, "ui-review");
    assert.equal(revised.validationIssues.some((entry) => entry.code === "missing_ui_interaction_contract"), false);
    assert.equal(revised.validationIssues.some((entry) => entry.code === "unconfirmed_ui_interaction_contract"), true);
  });
});

test("Chat requirement revisions design UI contracts against the persisted requirement criteria", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Revise a review interaction";
    const initialDraft = visualRequirementDraft(goalPrompt, cwd);
    const initialRequirement = initialDraft.requirements[0]!;
    const initialContract = finalizeUiInteractionContract(
      visualContractInput(initialRequirement.id, initialRequirement.acceptanceCriteria[0]!.id),
      initialDraft,
      { id: "ui-review" },
    );
    const revisedDraft = finalizeGoalRequirementDraft({
      goalPrompt,
      cwd,
      summary: "Review a card and reveal its revised answer.",
      requirements: [{
        title: "Review card",
        statement: "A learner can reveal the revised answer for a card.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["The revised answer is hidden until requested."],
        businessRules: [],
        acceptanceCriteria: [atomicCriterion("Reveal changes the card into its revised answer state.")],
        expectedOutcomeArtifacts: [{ description: "Revised review interaction" }],
        verificationIntent: ["Exercise the revised reveal."],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: ["ui-review"],
      }],
      nonGoals: [],
      blockingInputs: [],
    });
    const revisedRequirement = revisedDraft.requirements[0]!;
    const revisedContract = finalizeUiInteractionContract(
      visualContractInput(revisedRequirement.id, revisedRequirement.acceptanceCriteria[0]!.id),
      revisedDraft,
      { id: "ui-review" },
    );
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return initialDraft; },
        async revise() { return { kind: "revision", draft: revisedDraft, summary: "revised" }; },
        async designUiInteractionContracts() { return [initialContract]; },
      },
    });

    const revised = await reviseGoalRequirementFromChatPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      message: "Revise the visual requirement.",
      selectedRequirementId: initialRequirement.id,
      requirementInterpreter: {
        async interpret() { return initialDraft; },
        async revise() { return { kind: "revision", draft: revisedDraft, summary: "revised" }; },
        async designUiInteractionContracts() { return [revisedContract]; },
      },
    });

    if ("kind" in revised) assert.fail("expected a persisted revision");
    assert.equal(revised.uiInteractionContracts?.[0]?.criterionBindings[0]?.criterionId, revised.goalRequirementDraft.requirements[0]?.acceptanceCriteria[0]?.id);
    assert.equal(revised.validationIssues.some((entry) => entry.code === "missing_ui_interaction_contract"), false);
  });
});

test("Chat requirement revisions reject stale generated UI contract criteria instead of rebinding by array position", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const goalPrompt = "Rebind a review interaction";
    const initialDraft = visualRequirementDraft(goalPrompt, cwd);
    const initialRequirement = initialDraft.requirements[0]!;
    const initialContract = finalizeUiInteractionContract(
      visualContractInput(initialRequirement.id, initialRequirement.acceptanceCriteria[0]!.id),
      initialDraft,
      { id: "ui-review" },
    );
    const revisedDraft = finalizeGoalRequirementDraft({
      goalPrompt,
      cwd,
      summary: "Review a card and reveal its revised answer.",
      requirements: [{
        title: "Review card",
        statement: "A learner can reveal the revised answer for a card.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["The revised answer is hidden until requested."],
        businessRules: [],
        acceptanceCriteria: [atomicCriterion("Reveal changes the card into its revised answer state.")],
        expectedOutcomeArtifacts: [{ description: "Revised review interaction" }],
        verificationIntent: ["Exercise the revised reveal."],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: ["ui-review"],
      }],
      nonGoals: [],
      blockingInputs: [],
    });
    const revisedRequirement = revisedDraft.requirements[0]!;
    const validRevisedContract = finalizeUiInteractionContract(
      visualContractInput(revisedRequirement.id, revisedRequirement.acceptanceCriteria[0]!.id),
      revisedDraft,
      { id: "ui-review" },
    );
    const staleGeneratedContract = {
      ...structuredClone(validRevisedContract),
      criterionBindings: structuredClone(initialContract.criterionBindings),
    };
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: {
        async interpret() { return initialDraft; },
        async revise() { return { kind: "revision", draft: revisedDraft, summary: "revised" }; },
        async designUiInteractionContracts() { return [initialContract]; },
      },
    });

    await assert.rejects(
      () => reviseGoalRequirementFromChatPg(db, {
        draftId: draft.draftId,
        expectedDraftHash: draft.goalRequirementDraftHash,
        message: "Rebind the revised visual requirement.",
        selectedRequirementId: initialRequirement.id,
        requirementInterpreter: {
          async interpret() { return initialDraft; },
          async revise() { return { kind: "revision", draft: revisedDraft, summary: "revised" }; },
          async designUiInteractionContracts() { return [staleGeneratedContract]; },
        },
      }),
      /generated UI interaction contract is incompatible with the revised criteria/,
    );
    const unchanged = await loadCurrentGoalRequirementDraftPg(db, draft.draftId);
    assert.equal(unchanged.draftHash, draft.goalRequirementDraftHash);
  });
});

test("Requirement revisions stale an unmaterialized generated DAG draft by source lineage", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: "Create an offline article",
      cwd,
      requirementInterpreter: requirementDraftInterpreter("Create an offline article", cwd),
    });
    const generatedDraftId = "generated-dag-for-requirement-lineage";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: generatedDraftId,
      scope: "planner",
      status: "validated",
      payload: {
        goalRequirementDraftId: draft.draftId,
        goalRequirementDraftHash: draft.goalRequirementDraftHash,
      },
      summary: {
        goalRequirementDraftId: draft.draftId,
        goalRequirementDraftHash: draft.goalRequirementDraftHash,
      },
    });
    const revised = await reviseGoalRequirementPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      requirementId: draft.goalRequirementDraft.requirements[0]!.id,
      patch: { statement: "Changed observable outcome" },
    });
    assert.equal(revised.invalidated?.dagDraft, true);
    assert.equal((await getResourceByKeyPg(db, "planner_draft", generatedDraftId))?.status, "stale");
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: generatedDraftId }),
      /canonical_goal_design_package_required/,
    );
  });
});

test("Requirement revisions are frozen while Goal Design is composing", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: "Create an offline article",
      cwd,
      requirementInterpreter: requirementDraftInterpreter("Create an offline article", cwd),
    });
    await db.query(
      `update southstar.runtime_resources
          set payload_json = payload_json || '{"goalDesignPhase":"composing"}'::jsonb
        where resource_type = 'planner_draft' and resource_key = $1`,
      [draft.draftId],
    );

    await assert.rejects(
      () => reviseGoalRequirementPg(db, {
        draftId: draft.draftId,
        expectedDraftHash: draft.goalRequirementDraftHash,
        requirementId: draft.goalRequirementDraft.requirements[0]!.id,
        patch: { statement: "Must not change during composition" },
      }),
      /goal_requirements_frozen/,
    );
  });
});

test("Requirement revision persistence preserves the first hash on duplicate revision races", async () => {
  await withDb(async (db) => {
    const cwd = process.cwd();
    const first = finalizeGoalRequirementDraft(validGoalRequirementDraftInput("Immutable revision", cwd));
    await persistGoalRequirementDraftRevisionPg(db, { draftId: "immutable-race", draft: first });
    const conflicting = finalizeGoalRequirementDraft({
      ...validGoalRequirementDraftInput("Immutable revision", cwd),
      requirements: [{
        ...validGoalRequirementDraftInput("Immutable revision", cwd).requirements[0]!,
        statement: "A different revision payload must not overwrite the first.",
      }],
    });
    await assert.rejects(
      () => persistGoalRequirementDraftRevisionPg(db, { draftId: "immutable-race", draft: conflicting }),
      /goal_requirement_revision_conflict/,
    );
    const stored = await db.one<{ payload_json: GoalRequirementDraftInputV1 }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'goal_requirement_draft_revision' and resource_key = $1",
      ["immutable-race:revision:1"],
    );
    assert.equal((stored.payload_json as any).draftHash, first.draftHash);
  });
});

test("Requirement confirmation is hash-bound and idempotent", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    await seedGoalRequirementVocabulary(db);
    const cwd = process.cwd();
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: "Create an offline article",
      cwd,
      requirementInterpreter: requirementDraftInterpreter("Create an offline article", cwd),
    });
    const input = {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      goalContractMetadata: {
        domain: "design/article",
        intent: "publish_article",
        workType: "general" as const,
        expectedArtifactRefs: [],
        requiredCapabilities: [],
        assumptions: [],
        requestedSideEffects: [],
      },
    };
    const first = await confirmGoalRequirementsPg(db, input);
    const replay = await confirmGoalRequirementsPg(db, input);
    assert.equal(first.status, "validation_resolving");
    assert.equal(first.phase, "validation_resolving");
    assert.equal(first.confirmable, false);
    assert.equal(replay.confirmable, false);
    assert.deepEqual(first.validationIssues, []);
    assert.deepEqual(replay.validationIssues, []);
    assert.equal(first.goalContractHash, replay.goalContractHash);
    assert.equal(first.goalRequirementDraftHash, replay.goalRequirementDraftHash);
    const confirmation = await getResourceByKeyPg(db, "goal_contract_confirmation", draft.draftId);
    assert.deepEqual(
      (confirmation?.payload as any).criterionAssignments,
      first.goalContract!.requirements.flatMap((requirement) => requirement.acceptanceCriteria.map((criterion) => ({
        requirementId: requirement.id,
        proposedCriterionId: criterion.id,
        criterionId: criterion.id,
        criterionVersion: criterion.version,
      }))),
    );
    const orchestration = await getPostgresPlannerDraftOrchestration(db, { draftId: draft.draftId });
    assert.equal(orchestration.confirmable, false);
    assert.deepEqual(orchestration.validationIssues, []);
  });
});

test("Requirement confirmation rebuilds a stale Goal Contract after a draft revision", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Reconfirm a revised offline article requirement");
    const requirement = goal.goalRequirementDraft.requirements[0]!;
    const criterion = requirement.acceptanceCriteria[0]!;
    const revised = await reviseGoalRequirementPg(db, {
      draftId: goal.draftId,
      expectedDraftHash: goal.goalRequirementDraftHash,
      requirementId: requirement.id,
      patch: {
        acceptanceCriteria: [{
          id: criterion.id,
          observableClaim: `${criterion.observableClaim} with the revised acceptance wording.`,
          blocking: criterion.blocking,
          verificationIntent: [...criterion.verificationIntent],
          requiredAssurance: [...criterion.requiredAssurance],
          evidenceIntent: [...criterion.evidenceIntent],
        }],
      },
    });

    // Reproduce a stale validation-stage row: the latest Requirement Draft is
    // present, but an older Goal Contract was retained by the resume path.
    await db.query(
      `update southstar.runtime_resources
          set payload_json = payload_json || $2::jsonb,
              status = 'validation_ready'
        where resource_type = 'planner_draft' and resource_key = $1`,
      [goal.draftId, JSON.stringify({
        goalContract: goal.goalContract,
        goalContractHash: goal.goalContractHash,
        goalDesignPhase: "validation_ready",
      })],
    );

    const reconfirmed = await confirmGoalRequirementsPg(db, {
      draftId: goal.draftId,
      expectedDraftHash: revised.goalRequirementDraftHash,
      goalContractMetadata: {
        domain: "design/article",
        intent: "publish_article",
        workType: "general",
        expectedArtifactRefs: [],
        requiredCapabilities: [],
        assumptions: [],
        requestedSideEffects: [],
      },
    });

    assert.equal(reconfirmed.status, "validation_resolving");
    assert.equal(
      reconfirmed.goalContract?.requirements[0]?.acceptanceCriteria[0]?.version,
      criterion.version + 1,
    );
    assert.notEqual(reconfirmed.goalContractHash, goal.goalContractHash);
  });
});

test("confirmed requirements with gaps create one immutable linked Library import draft", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Create an offline article with validation");
    const missing = validationResolution(goal, false);
    let candidateCalls = 0;
    const provider: LibraryImportLlmProvider = async ({ prompt }) => {
      candidateCalls += 1;
      return validationImportCandidates(prompt);
    };

    const first = await resolveAndPersistGoalValidationPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      resolver: async () => missing,
      libraryImportLlmProvider: provider,
    });
    const replay = await resolveAndPersistGoalValidationPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      resolver: async () => missing,
      libraryImportLlmProvider: provider,
    });

    assert.equal(first.status, "library_review");
    assert.equal(replay.status, "library_review");
    assert.equal(replay.libraryImportDraftId, first.libraryImportDraftId);
    assert.equal(candidateCalls, 1);
    const importDraft = await getResourceByKeyPg(db, "library_import_draft", first.libraryImportDraftId!);
    assert.equal((importDraft!.payload as any).originGoalDraftId, goal.draftId);
    assert.equal((importDraft!.payload as any).originGoalContractHash, goal.goalContractHash);
    assert.equal((importDraft!.payload as any).originGoalRequirementDraftHash, goal.goalRequirementDraftHash);
    assert.equal((importDraft!.payload as any).originGoalValidationResolutionHash, missing.resolutionHash);
    assert.match((importDraft!.payload as any).requestPrompt, /one complete reusable Library candidate proposal/);
    assert.match((importDraft!.payload as any).requestPrompt, /Do not create unrelated domain, capability, agent, skill, tool, MCP, workflow/);
    const gapSource = JSON.parse((importDraft!.payload as any).source.content);
    assert.equal(gapSource.schemaVersion, "southstar.goal_validation_import_request.v1");
    assert.deepEqual(gapSource.gaps.map((gap: any) => gap.requirementId), [goal.goalContract.requirements[0]!.id]);
    assert.deepEqual(
      gapSource.requirements[0].acceptanceCriteria,
      goal.goalContract.requirements[0]!.acceptanceCriteria,
    );
    const coverageConstraint = (importDraft!.payload as any).coverageConstraints[0];
    assert.equal(coverageConstraint.requirementStatement, goal.goalContract.requirements[0]!.statement);
    assert.deepEqual(
      coverageConstraint.criterionStatements.map((criterion: any) => criterion.statement),
      goal.goalRequirementDraft.requirements[0]!.acceptanceCriteria.map((criterion) => criterion.observableClaim),
    );
    const resolutionCount = await db.one<{ count: string }>(
      "select count(*) from southstar.runtime_resources where resource_type = 'goal_validation_resolution_revision' and resource_key like $1",
      [`${goal.draftId}:%`],
    );
    assert.equal(Number(resolutionCount.count), 1);
  });
});

test("candidate install resumes the same Goal draft and reaches validation_ready", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-goal-validation-resume-"));
    try {
      await mkdir(join(libraryRoot, "skills"), { recursive: true });
      await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.test-goal", "goal_design"));
      await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.test-composer", "composer_guidance"));
      const goal = await createConfirmedGoalRequirementDraft(db, "Create an offline article with a reusable evaluator");
      const provider = realGoalValidationImportProvider();
      const waiting = await resolveAndPersistGoalValidationPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        libraryImportLlmProvider: provider,
      });
      assert.ok(waiting.libraryImportDraftId);

      const response = await handleRuntimeRoute({
        db,
        libraryRoot,
        libraryImportLlmProvider: provider,
      } as any, new Request(`http://local/api/v2/library/import-drafts/${waiting.libraryImportDraftId}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedCandidateIds: ["artifact.offline-html", "evaluator.offline-html"],
          actor: "operator",
          reason: "approved Goal validation candidates",
        }),
      }));
      const envelope = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(envelope));
      assert.equal(envelope.result.goalValidationResume.ok, true);
      const unexpectedFollowUp = envelope.result.goalValidationResume.libraryImportDraftId
        ? await getResourceByKeyPg(db, "library_import_draft", envelope.result.goalValidationResume.libraryImportDraftId)
        : undefined;
      assert.equal(
        envelope.result.goalValidationResume.status,
        "validation_ready",
        JSON.stringify({ resume: envelope.result.goalValidationResume, followUp: unexpectedFollowUp?.payload }),
      );

      const stored = await getResourceByKeyPg(db, "planner_draft", goal.draftId);
      assert.equal((stored!.payload as any).goalDesignPhase, "validation_ready");
      assert.equal((stored!.payload as any).goalContractHash, goal.goalContractHash);
      assert.equal((stored!.payload as any).goalRequirementDraftHash, goal.goalRequirementDraftHash);
      assert.equal((stored!.payload as any).goalValidationResolution.gaps.length, 0);
      assert.equal((stored!.payload as any).goalValidationResolution.ready, true);
      const plannerDraftCount = await db.one<{ count: string }>(
        "select count(*) from southstar.runtime_resources where resource_type = 'planner_draft'",
      );
      const runCount = await db.one<{ count: string }>("select count(*) from southstar.workflow_runs");
      assert.equal(Number(plannerDraftCount.count), 1);
      assert.equal(Number(runCount.count), 0);
    } finally {
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("installed Goal validation repairs stale Contract lineage before resume", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-goal-validation-stale-contract-"));
    try {
      await mkdir(join(libraryRoot, "skills"), { recursive: true });
      await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.test-goal", "goal_design"));
      await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.test-composer", "composer_guidance"));
      const goal = await createConfirmedGoalRequirementDraft(db, "Repair stale Goal Contract before Slice Design");
      const provider = realGoalValidationImportProvider();
      const waiting = await resolveAndPersistGoalValidationPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        libraryImportLlmProvider: provider,
      });
      assert.ok(waiting.libraryImportDraftId);

      const driftedDraft = structuredClone(goal.goalRequirementDraft);
      driftedDraft.requirements[0]!.acceptanceCriteria[0]!.version += 1;
      const { draftHash: _draftHash, ...withoutDraftHash } = driftedDraft;
      driftedDraft.draftHash = goalRequirementDraftHash(withoutDraftHash);
      await db.query(
        `update southstar.runtime_resources
            set payload_json = payload_json || $2::jsonb
          where resource_type = 'planner_draft' and resource_key = $1`,
        [goal.draftId, JSON.stringify({
          goalRequirementDraft: driftedDraft,
          goalRequirementDraftHash: driftedDraft.draftHash,
        })],
      );
      await db.query(
        `update southstar.runtime_resources
            set payload_json = payload_json || $2::jsonb
          where resource_type = 'library_import_draft' and resource_key = $1`,
        [waiting.libraryImportDraftId, JSON.stringify({ originGoalRequirementDraftHash: driftedDraft.draftHash })],
      );

      const response = await handleRuntimeRoute({
        db,
        libraryRoot,
        libraryImportLlmProvider: provider,
      } as any, new Request(`http://local/api/v2/library/import-drafts/${waiting.libraryImportDraftId}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedCandidateIds: ["artifact.offline-html", "evaluator.offline-html"],
          actor: "operator",
          reason: "repair stale Goal Contract lineage",
        }),
      }));
      const envelope = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(envelope));
      assert.equal(envelope.result.goalValidationResume.ok, true, JSON.stringify(envelope));

      const stored = await getResourceByKeyPg(db, "planner_draft", goal.draftId);
      const contract = (stored!.payload as any).goalContract;
      assert.equal(contract.requirements[0].acceptanceCriteria[0].version, 2);
      assert.equal((stored!.payload as any).goalDesignPhase, "validation_ready");
      const resume = await getResourceByKeyPg(db, "goal_validation_resume", waiting.libraryImportDraftId!);
      assert.equal((resume!.payload as any).originGoalContractHash, (stored!.payload as any).goalContractHash);
      assert.equal((resume!.payload as any).resolutionHash, envelope.result.goalValidationResume.resolutionHash);
    } finally {
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("validation_ready continues on the same planner draft into a V2 Slice review", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Create an offline article with frozen validation");
    await upsertLibraryObject(db, {
      objectKey: "artifact.offline-html",
      objectKind: "artifact_contract",
      status: "approved",
      headVersionId: "artifact.offline-html@1",
      state: {},
    });
    await upsertLibraryObject(db, {
      objectKey: "evaluator.offline-html",
      objectKind: "evaluator_profile",
      status: "approved",
      headVersionId: "evaluator.offline-html@1",
      state: {},
    });
    const resolution = validationResolution(goal, true);
    const validation = await resolveAndPersistGoalValidationPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      resolver: async () => resolution,
    });
    assert.equal(validation.status, "validation_ready");
    let receivedBindingId: string | undefined;
    const sliceDesigner: GoalSliceDesigner = {
      async design(input) {
        const binding = input.validationBindings[0]!;
        receivedBindingId = binding.id;
        return finalizeGoalDesignPackageV3({
          schemaVersion: "southstar.goal_design_package.v3",
          revision: 1,
          goalContract: input.goalContract,
          requirementDraftHash: input.requirementDraft.draftHash,
          validationBindings: input.validationBindings,
          slicePlan: {
            schemaVersion: "southstar.goal_slice_plan.v1",
            goalContractHash: "host-filled",
            revision: 1,
            slices: [{
              id: "slice-offline-article",
              requirementIds: [input.goalContract.requirements[0]!.id],
              outcome: "Deliver a verified offline article",
              stateOrArtifactOwner: binding.criterionBindings[0]!.artifactContractRef,
              mutationBoundary: "one offline article artifact",
              expectedArtifactRefs: binding.criterionBindings.map((criterionBinding) => criterionBinding.artifactContractRef),
              evaluatorContractRefs: [binding.id],
              dependsOnSliceIds: [],
              dependencyArtifactRefs: [],
            }],
          },
          compositionStrategy: {
            mode: "single-run",
            sliceIds: ["slice-offline-article"],
            rationale: "one cohesive outcome boundary",
          },
          templatePolicy: input.templatePolicy,
          goalDesignSkillRef: input.skill.objectKey,
          goalDesignSkillVersionRef: input.skill.versionRef,
          workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
          mode: input.mode,
        });
      },
      async revise(input) {
        return {
          kind: "revision",
          slicePlan: { slices: input.currentPackage.slicePlan.slices },
          compositionStrategy: input.currentPackage.compositionStrategy,
          summary: "unchanged",
          changedSliceIds: [],
        };
      },
    };

    const designed = await designAndPersistGoalSlicesPg(db, {
      draftId: goal.draftId,
      expectedResolutionHash: resolution.resolutionHash,
      sliceDesigner,
    });

    assert.equal(designed.draftId, goal.draftId);
    assert.equal(designed.status, "ready_for_review");
    assert.equal(designed.phase, "slice_review");
    assert.equal(designed.goalDesignPackage.schemaVersion, "southstar.goal_design_package.v3");
    assert.equal(receivedBindingId, resolution.bindings[0]!.id);
    assert.equal((await loadCurrentGoalDesignPackagePg(db, goal.draftId)).packageHash, designed.goalDesignPackageHash);
    const revisionResource = await getResourceByKeyPg(
      db,
      "goal_design_package_revision",
      `${goal.draftId}:revision:${designed.goalDesignPackage.revision}`,
    );
    const persistedPackage = (revisionResource?.payload as { goalDesignPackage?: typeof designed.goalDesignPackage })?.goalDesignPackage;
    assert.ok(persistedPackage);
    assert.equal(persistedPackage.goalDesignSkillRef, designed.goalDesignPackage.goalDesignSkillRef);
    assert.equal(persistedPackage.goalDesignSkillVersionRef, designed.goalDesignPackage.goalDesignSkillVersionRef);
    assert.equal(persistedPackage.criterionPromptVersion, "southstar.goal_requirement.atomic_criterion.v1");
    assert.match(persistedPackage.criterionSchemaHash, /^[a-f0-9]{64}$/);
    const stored = await getResourceByKeyPg(db, "planner_draft", goal.draftId);
    assert.equal(stored?.status, "ready_for_review");
    assert.equal((stored?.payload as any).goalDesignPhase, "slice_review");
    assert.deepEqual(
      (stored?.payload as any).goalContract.requirements[0].acceptanceCriteria,
      goal.goalContract.requirements[0]!.acceptanceCriteria,
    );
    const plannerDraftCount = await db.one<{ count: string }>(
      "select count(*) from southstar.runtime_resources where resource_type = 'planner_draft'",
    );
    assert.equal(Number(plannerDraftCount.count), 1);
  });
});

test("Requirement review through validated DAG has no late validation candidate gap", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    await seedGoalRequirementVocabulary(db);
    await seedInlineArticleValidationAndCompositionGraph(db);
    const goal = await createConfirmedGoalRequirementDraft(db, "Create a verified offline article without late validation discovery");
    const validation = await resolveAndPersistGoalValidationPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      resolver: async (resolverDb, input) => resolveGoalValidationPg(resolverDb, {
        ...input,
        ranker: ({ artifactCandidates, evaluatorCandidatesByArtifact }) => {
          const artifact = artifactCandidates.find((candidate) => candidate.ref === "artifact.offline-document");
          const evaluator = evaluatorCandidatesByArtifact["artifact.offline-document"]?.find((candidate) => candidate.ref === "evaluator.offline-document");
          if (!artifact || !evaluator) return { recommendations: [] };
          return {
            artifactRef: artifact.ref,
            artifactVersionRef: artifact.versionRef,
            evaluatorRef: evaluator.ref,
            evaluatorVersionRef: evaluator.versionRef,
            verificationMode: "browser_interaction",
            procedureRef: "procedure.open-offline",
            expectedEvidenceKinds: ["screenshot"],
          };
        },
      }),
    });
    assert.equal(validation.status, "validation_ready", JSON.stringify(validation.validationGaps));
    assert.deepEqual(validation.validationGaps, []);
    assert.equal(validation.validationBindings.length, 1);
    const validationView = await getPostgresPlannerDraftOrchestration(db, { draftId: goal.draftId });
    assert.equal(validationView.goalDesignPhase, "validation_ready");

    const sliced = await designAndPersistGoalSlicesPg(db, {
      draftId: goal.draftId,
      expectedResolutionHash: validation.goalValidationResolution.resolutionHash,
      sliceDesigner: inlineArticleSliceDesigner(),
    });
    assert.equal(sliced.phase, "slice_review");
    const sliceView = await getPostgresPlannerDraftOrchestration(db, { draftId: goal.draftId });
    assert.equal(sliceView.goalDesignPhase, "slice_review");
    const composer: WorkflowComposer = {
      async compose(input) { return inlineArticleComposition(input.goalContract, sliced.goalDesignPackage.slicePlan.slices[0]!.id); },
    };
    const composed = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: goal.goalContract.originalPrompt,
      cwd: goal.goalContract.workspace.cwd,
      goalInterpreter: fixedGoalInterpreter(goal.goalContract),
      goalDesignPackage: sliced.goalDesignPackage,
      goalRequirementDraftId: goal.draftId,
      goalRequirementDraftHash: goal.goalRequirementDraftHash,
      composer,
    });
    assert.equal(composed.status, "validated", JSON.stringify(composed.validationIssues));
    assert.deepEqual(composed.validationIssues, []);
    const composedView = await getPostgresPlannerDraftOrchestration(db, { draftId: composed.draftId });
    assert.equal(composedView.status, "validated");
    assert.deepEqual(composedView.validationIssues, []);
    const stored = await getResourceByKeyPg(db, "planner_draft", composed.draftId);
    const coverage = (stored!.payload as any).goalRequirementCoverage;
    assert.equal(coverage.entries[0]!.criterionIds.length > 0, true);
    assert.deepEqual(
      coverage.entries[0]!.acceptanceCriteria,
      goal.goalContract.requirements[0]!.acceptanceCriteria.map((criterion) => criterion.observableClaim),
    );
    assert.equal(coverage.entries[0]!.validationBindingId, validation.validationBindings[0]!.id);
  });
});

test("Goal-linked candidate install rejects a partial selection before writing Library files", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-goal-validation-partial-"));
    try {
      await mkdir(join(libraryRoot, "skills"), { recursive: true });
      await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.test-goal", "goal_design"));
      await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.test-composer", "composer_guidance"));
      const goal = await createConfirmedGoalRequirementDraft(db, "Create an offline article through partial Library approval");
      const provider = realGoalValidationImportProvider();
      const waiting = await resolveAndPersistGoalValidationPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        libraryImportLlmProvider: provider,
      });
      const firstDraftId = waiting.libraryImportDraftId!;

      const partialResponse = await handleRuntimeRoute({ db, libraryRoot, libraryImportLlmProvider: provider } as any,
        new Request(`http://local/api/v2/library/import-drafts/${firstDraftId}/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            selectedCandidateIds: ["artifact.offline-html"],
            actor: "operator",
            reason: "approve the artifact contract first",
          }),
        }));
      const partialEnvelope = await partialResponse.json() as any;
      assert.equal(partialResponse.status, 400, JSON.stringify(partialEnvelope));
      assert.match(partialEnvelope.error, /complete artifact\/evaluator candidate pair/);
      assert.equal((await getResourceByKeyPg(db, "library_import_draft", firstDraftId))?.status, "draft");
      assert.equal(await findLibraryObjectByKey(db, "artifact.offline-html"), null);
    } finally {
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("candidate store refuses a partial Goal-linked install before a follow-up round can be created", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-goal-validation-same-resolution-"));
    try {
      await mkdir(join(libraryRoot, "skills"), { recursive: true });
      await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.test-goal", "goal_design"));
      await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.test-composer", "composer_guidance"));
      const goal = await createConfirmedGoalRequirementDraft(db, "Keep the same unresolved validation resolution after one approval");
      const missing = validationResolution(goal, false);
      const waiting = await resolveAndPersistGoalValidationPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        resolver: async () => missing,
        libraryImportLlmProvider: async ({ prompt }) => validationImportCandidates(prompt),
      });
      await assert.rejects(() => installLibraryImportCandidates(db, {
          root: libraryRoot,
          draftId: waiting.libraryImportDraftId!,
          selectedCandidateIds: ["artifact.offline-html"],
          actor: "operator",
          reason: "partial Goal-linked proposal must be rejected",
        }), /complete artifact\/evaluator candidate pair/);
      assert.equal((await getResourceByKeyPg(db, "library_import_draft", waiting.libraryImportDraftId!))?.status, "draft");
    } finally {
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("Requirement revision marks linked validation import candidates stale", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Create an offline article and revise its evidence");
    const waiting = await resolveAndPersistGoalValidationPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      resolver: async () => validationResolution(goal, false),
      libraryImportLlmProvider: async ({ prompt }) => validationImportCandidates(prompt),
    });
    assert.ok(waiting.libraryImportDraftId);

    await reviseGoalRequirementPg(db, {
      draftId: goal.draftId,
      expectedDraftHash: goal.goalRequirementDraftHash,
      requirementId: goal.goalRequirementDraft.requirements[0]!.id,
      patch: { statement: "Create an offline article with updated observable evidence." },
    });

    const importDraft = await getResourceByKeyPg(db, "library_import_draft", waiting.libraryImportDraftId);
    assert.equal(importDraft?.status, "stale");
    const staleLibraryRoot = await mkdtemp(join(tmpdir(), "southstar-stale-goal-import-"));
    try {
      await assert.rejects(
        () => installLibraryImportCandidates(db, {
          root: staleLibraryRoot,
          draftId: waiting.libraryImportDraftId!,
          selectedCandidateIds: ["artifact.offline-html", "evaluator.offline-html"],
          reason: "must not install candidates for a stale Requirement revision",
        }),
        /library import draft is already stale/,
      );
    } finally {
      await rm(staleLibraryRoot, { recursive: true, force: true });
    }
    await assert.rejects(
      () => resumeGoalValidationAfterLibraryImportPg(db, {
        libraryImportDraftId: waiting.libraryImportDraftId!,
        resolver: async () => validationResolution(goal, true),
      }),
      /goal_validation_import_stale/,
    );
  });
});

test("Library install rejects a linked candidate when the persisted validation resolution hash changed", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-goal-validation-stale-resolution-"));
    try {
      await mkdir(join(libraryRoot, "skills"), { recursive: true });
      await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.test-goal", "goal_design"));
      await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.test-composer", "composer_guidance"));
      const goal = await createConfirmedGoalRequirementDraft(db, "Reject candidates from a superseded validation resolution");
      const original = validationResolution(goal, false);
      const waiting = await resolveAndPersistGoalValidationPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        resolver: async () => original,
        libraryImportLlmProvider: async ({ prompt }) => validationImportCandidates(prompt),
      });
      const { resolutionHash: _oldHash, ...changedWithoutHash } = original;
      const changedPayload = {
        ...changedWithoutHash,
        gaps: changedWithoutHash.gaps.map((gap) => ({ ...gap, message: `${gap.message}; resolution reranked` })),
      };
      const changed: GoalValidationResolutionV2 = {
        ...changedPayload,
        resolutionHash: contentHashForPayload(changedPayload),
      };
      await persistGoalValidationResolutionPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        expectedGoalRequirementDraftHash: goal.goalRequirementDraftHash,
        resolution: changed,
      });

      const response = await handleRuntimeRoute({
        db,
        libraryRoot,
        libraryImportLlmProvider: realGoalValidationImportProvider(),
      } as any, new Request(`http://local/api/v2/library/import-drafts/${waiting.libraryImportDraftId}/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectedCandidateIds: ["artifact.offline-html", "evaluator.offline-html"],
          actor: "operator",
          reason: "must reject candidates bound to the previous resolution",
        }),
      }));
      const envelope = await response.json() as any;
      assert.equal(response.status, 409, JSON.stringify(envelope));
      assert.equal(envelope.ok, false);
      assert.match(envelope.error, /goal_validation_import_stale/);
      assert.equal((await getResourceByKeyPg(db, "library_import_draft", waiting.libraryImportDraftId!))?.status, "stale");
      assert.equal(await findLibraryObjectByKey(db, "artifact.offline-html"), null);
    } finally {
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("Library install rechecks Goal validation under the install transaction lock", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-goal-validation-install-race-"));
    try {
      await mkdir(join(libraryRoot, "skills"), { recursive: true });
      await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.test-goal", "goal_design"));
      await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.test-composer", "composer_guidance"));
      const goal = await createConfirmedGoalRequirementDraft(db, "Reject a candidate superseded during install preflight");
      const original = validationResolution(goal, false);
      const { resolutionHash: _oldHash, ...changedWithoutHash } = original;
      const changedPayload = {
        ...changedWithoutHash,
        gaps: changedWithoutHash.gaps.map((gap) => ({ ...gap, message: `${gap.message}; changed during ontology analysis` })),
      };
      const changed: GoalValidationResolutionV2 = {
        ...changedPayload,
        resolutionHash: contentHashForPayload(changedPayload),
      };
      let changedDuringInstall = false;
      const resolveProvider = realGoalValidationImportProvider();
      const provider: LibraryImportLlmProvider = async (request) => {
        const { prompt } = request;
        if (prompt.startsWith("Generate ontology edges")) {
          if (!changedDuringInstall) {
            changedDuringInstall = true;
            await persistGoalValidationResolutionPg(db, {
              draftId: goal.draftId,
              expectedGoalContractHash: goal.goalContractHash,
              expectedGoalRequirementDraftHash: goal.goalRequirementDraftHash,
              resolution: changed,
            });
          }
          return { proposedEdges: [] };
        }
        return await resolveProvider(request);
      };
      const waiting = await resolveAndPersistGoalValidationPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        libraryImportLlmProvider: provider,
      });

      const response = await handleRuntimeRoute({ db, libraryRoot, libraryImportLlmProvider: provider } as any,
        new Request(`http://local/api/v2/library/import-drafts/${waiting.libraryImportDraftId}/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            selectedCandidateIds: ["artifact.offline-html", "evaluator.offline-html"],
            actor: "operator",
            reason: "transaction guard must reject the superseded origin",
          }),
        }));
      const envelope = await response.json() as any;
      assert.equal(changedDuringInstall, true);
      assert.equal(response.status, 409, JSON.stringify(envelope));
      assert.match(envelope.error, /goal_validation_import_stale/);
      assert.equal((await getResourceByKeyPg(db, "library_import_draft", waiting.libraryImportDraftId!))?.status, "stale");
      assert.equal(await findLibraryObjectByKey(db, "artifact.offline-html"), null);
    } finally {
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("a post-commit Library install reuses its validated proposal without a second rank pass", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-goal-validation-post-commit-error-"));
    try {
      await mkdir(join(libraryRoot, "skills"), { recursive: true });
      await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.test-goal", "goal_design"));
      await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.test-composer", "composer_guidance"));
      const goal = await createConfirmedGoalRequirementDraft(db, "Keep Library install committed if validation retry fails");
      let rankCalls = 0;
      const resolveProvider = realGoalValidationImportProvider();
      const provider: LibraryImportLlmProvider = async (request) => {
        const { prompt } = request;
        if (prompt.startsWith("Rank only the supplied approved artifact contracts")) {
          rankCalls += 1;
          // The initial Goal validation is the only semantic rank pass.  The
          // post-commit resume must use the installed proposal coverage and
          // never call this ranker again.
          if (rankCalls > 1) throw new Error("temporary ranker outage after committed install");
        }
        if (prompt.startsWith("Generate ontology edges")) return { proposedEdges: [] };
        return await resolveProvider(request);
      };
      const waiting = await resolveAndPersistGoalValidationPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        libraryImportLlmProvider: provider,
      });

      const response = await handleRuntimeRoute({ db, libraryRoot, libraryImportLlmProvider: provider } as any,
        new Request(`http://local/api/v2/library/import-drafts/${waiting.libraryImportDraftId}/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            selectedCandidateIds: ["artifact.offline-html", "evaluator.offline-html"],
            actor: "operator",
            reason: "commit valid candidates before retrying Goal validation",
          }),
        }));
      const envelope = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(envelope));
      assert.equal(envelope.result.installed, true);
      assert.equal(envelope.result.goalValidationResume.ok, true);
      assert.equal(envelope.result.goalValidationResume.status, "validation_ready");
      assert.equal(rankCalls, 1);
      assert.equal((await getResourceByKeyPg(db, "library_import_draft", waiting.libraryImportDraftId!))?.status, "installed");
      assert.equal((await findLibraryObjectByKey(db, "artifact.offline-html"))?.status, "approved");
      assert.equal((await getResourceByKeyPg(db, "planner_draft", goal.draftId))?.status, "validation_ready");
    } finally {
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("a post-commit resume does not require the validation LLM provider", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-goal-validation-resume-provider-missing-"));
    try {
      await mkdir(join(libraryRoot, "skills"), { recursive: true });
      await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.test-goal", "goal_design"));
      await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.test-composer", "composer_guidance"));
      const goal = await createConfirmedGoalRequirementDraft(db, "Report how to resume after the validation provider is removed");
      const waiting = await resolveAndPersistGoalValidationPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        libraryImportLlmProvider: realGoalValidationImportProvider(),
      });

      const response = await handleRuntimeRoute({ db, libraryRoot } as any,
        new Request(`http://local/api/v2/library/import-drafts/${waiting.libraryImportDraftId}/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            selectedCandidateIds: ["artifact.offline-html", "evaluator.offline-html"],
            actor: "operator",
            reason: "preserve structured readiness after the committed install",
          }),
        }));
      const envelope = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(envelope));
      assert.equal(envelope.result.installed, true);
      assert.equal(envelope.result.goalValidationResume.ok, true);
      assert.equal(envelope.result.goalValidationResume.status, "validation_ready");
      assert.equal((await getResourceByKeyPg(db, "library_import_draft", waiting.libraryImportDraftId!))?.status, "installed");
      assert.equal((await findLibraryObjectByKey(db, "artifact.offline-html"))?.status, "approved");
      assert.equal((await getResourceByKeyPg(db, "planner_draft", goal.draftId))?.status, "validation_ready");
    } finally {
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("confirm-requirements route resolves validation and returns the linked Library review", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Create an offline article through the planner route");
    let rankPrompt = "";
    const resolveProvider = realGoalValidationImportProvider();
    const provider: LibraryImportLlmProvider = async (request) => {
      const { prompt } = request;
      if (prompt.startsWith("Rank only the supplied approved artifact contracts")) {
        rankPrompt = prompt;
      }
      return await resolveProvider(request);
    };
    const response = await handleRuntimeRoute({
      db,
      goalInterpreter: fixedGoalInterpreter(goal.goalContract),
      libraryImportLlmProvider: provider,
    } as any, new Request(`http://local/api/v2/planner/drafts/${goal.draftId}/confirm-requirements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedDraftHash: goal.goalRequirementDraftHash, actor: "operator" }),
    }));

    assert.equal(response.status, 200);
    const envelope = await response.json() as any;
    assert.equal(envelope.result.status, "library_review");
    assert.equal(envelope.result.phase, "library_review");
    assert.match(envelope.result.libraryImportDraftId, /^library-import-goal-/);
    assert.equal(envelope.result.goalValidationResolution.ready, false);
    const stored = await getResourceByKeyPg(db, "planner_draft", goal.draftId);
    assert.equal((stored!.payload as any).goalDesignPhase, "library_review");
    assert.equal((stored!.payload as any).libraryImportDraftId, envelope.result.libraryImportDraftId);
    assert.match(rankPrompt, /Allowed verificationMode values: deterministic, browser_interaction, semantic_review, human_approval/);
    assert.match(rankPrompt, /Use only refs and versionRefs supplied below/);
    assert.match(rankPrompt, /Do not add Requirements or Acceptance Criteria/);
  });
});

test("confirm-requirements stream reports Requirement coverage and proposal revision lifecycle", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Create an offline article through the streamed planner route");
    const provider = realGoalValidationImportProvider();
    const response = await handleRuntimeRoute({
      db,
      goalInterpreter: fixedGoalInterpreter(goal.goalContract),
      libraryImportLlmProvider: provider,
      libraryChatHeartbeatMs: 5,
    } as any, new Request(`http://local/api/v2/planner/drafts/${goal.draftId}/confirm-requirements/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ expectedDraftHash: goal.goalRequirementDraftHash, actor: "operator" }),
    }));
    const events = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(events, /event: goal\.validation\.started/);
    assert.match(events, /event: goal\.validation\.requirement\.started/);
    assert.match(events, /event: goal\.validation\.requirement\.completed/);
    assert.match(events, /event: library\.import\.candidates\.validated/);
    assert.match(events, /event: goal\.validation\.library_review/);
    assert.match(events, /event: goal_requirements/);
    assert.match(events, /event: done/);
  });
});

test("confirm-requirements route fails closed with actionable readiness when the Library LLM provider is missing", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    await seedGoalRequirementVocabulary(db);
    const cwd = process.cwd();
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: "Create an offline article but require configured validation",
      cwd,
      requirementInterpreter: requirementDraftInterpreter("Create an offline article but require configured validation", cwd),
    });
    const response = await handleRuntimeRoute({ db } as any,
      new Request(`http://local/api/v2/planner/drafts/${draft.draftId}/confirm-requirements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedDraftHash: draft.goalRequirementDraftHash, actor: "operator" }),
      }));
    const envelope = await response.json() as any;
    assert.equal(response.status, 503, JSON.stringify(envelope));
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, "goal_validation_provider_not_configured");
    assert.equal(envelope.status, "configuration_required");
    assert.deepEqual(envelope.readiness.missing, ["libraryImportLlmProvider"]);
    assert.match(envelope.readiness.action, /configure/i);
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal((stored?.payload as any).goalDesignPhase, "requirements_review");
    assert.equal(stored?.status, "requirements_review");
  });
});

test("Goal validation resolution fails closed with a structured provider configuration error", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Resolve validation only with a configured provider");
    await assert.rejects(
      () => resolveAndPersistGoalValidationPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
      }),
      (error: any) => error?.code === "goal_validation_provider_not_configured"
        && error?.status === 503
        && error?.readiness?.missing?.[0] === "libraryImportLlmProvider",
    );
  });
});

test("Goal validation persistence rejects a self-declared ready resolution without canonical bindings", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Reject a self-declared ready validation result");
    const valid = validationResolution(goal, true);
    const { resolutionHash: _resolutionHash, ...withoutHash } = valid;
    const unboundWithoutHash = {
      ...withoutHash,
      bindings: [],
      ready: true,
    };
    const unbound = {
      ...unboundWithoutHash,
      resolutionHash: contentHashForPayload(unboundWithoutHash),
    };

    await assert.rejects(
      () => persistGoalValidationResolutionPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        expectedGoalRequirementDraftHash: goal.goalRequirementDraftHash,
        resolution: unbound,
        actor: "test",
      }),
      /goal_validation_resolution_invalid/,
    );
  });
});

test("Requirement confirmation fails closed without interpreter or approved metadata", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    const cwd = process.cwd();
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: "Create an offline article",
      cwd,
      requirementInterpreter: requirementDraftInterpreter("Create an offline article", cwd),
    });
    await assert.rejects(
      () => confirmGoalRequirementsPg(db, {
        draftId: draft.draftId,
        expectedDraftHash: draft.goalRequirementDraftHash,
      }),
      /goal_requirement_contract_metadata_missing/,
    );
  });
});

test("Goal validation persistence locks every pinned Criterion artifact and evaluator version", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Persist only approved pinned validation bindings");
    const resolution = validationResolution(goal, true);
    await upsertLibraryObject(db, {
      objectKey: "artifact.offline-html",
      objectKind: "artifact_contract",
      status: "approved",
      headVersionId: "artifact.offline-html@1",
      state: {},
    });
    await upsertLibraryObject(db, {
      objectKey: "evaluator.offline-html",
      objectKind: "evaluator_profile",
      status: "approved",
      headVersionId: "evaluator.offline-html@1",
      state: {},
    });
    await persistGoalValidationResolutionPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      expectedGoalRequirementDraftHash: goal.goalRequirementDraftHash,
      resolution,
    });

    await db.query(
      "update southstar.library_objects set head_version_id = $2 where object_key = $1",
      ["evaluator.offline-html", "evaluator.offline-html@2"],
    );
    await assert.rejects(
      () => persistGoalValidationResolutionPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        expectedGoalRequirementDraftHash: goal.goalRequirementDraftHash,
        resolution,
      }),
      /goal_validation_library_binding_stale: evaluator\.offline-html@1/,
    );

    await db.query(
      "update southstar.library_objects set head_version_id = $2, status = 'draft' where object_key = $1",
      ["evaluator.offline-html", "evaluator.offline-html@1"],
    );
    await assert.rejects(
      () => persistGoalValidationResolutionPg(db, {
        draftId: goal.draftId,
        expectedGoalContractHash: goal.goalContractHash,
        expectedGoalRequirementDraftHash: goal.goalRequirementDraftHash,
        resolution,
      }),
      /goal_validation_library_binding_stale: evaluator\.offline-html@1/,
    );
  });
});

test("editing a confirmed Criterion versions it and stales every dependent resource", async () => {
  await withDb(async (db) => {
    await seedGoalDesignSkill(db);
    await seedGoalRequirementVocabulary(db);
    const cwd = process.cwd();
    const draft = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: "Create an offline article",
      cwd,
      requirementInterpreter: requirementDraftInterpreter("Create an offline article", cwd),
    });
    await confirmGoalRequirementsPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      goalContractMetadata: {
        domain: "design/article",
        intent: "publish_article",
        workType: "general",
        expectedArtifactRefs: [],
        requiredCapabilities: [],
        assumptions: [],
        requestedSideEffects: [],
      },
    });
    await db.query(
      `update southstar.runtime_resources
          set payload_json = payload_json || $2::jsonb,
              summary_json = summary_json || $3::jsonb
        where resource_type = 'planner_draft' and resource_key = $1`,
      [draft.draftId, JSON.stringify({
        workflow: { workflowId: "old-workflow" },
        workflowManifestHash: "old-workflow-hash",
        goalRequirementCoverage: { entries: [] },
        goalRequirementCoverageHash: "old-coverage-hash",
        orchestrationSnapshot: { old: true },
        plannerTrace: { old: true },
        slicePlan: { slices: [] },
      }), JSON.stringify({ workflowId: "old-workflow", taskSummaries: [{ id: "old-task" }] })],
    );
    await upsertRuntimeResourcePg(db, {
      resourceType: "goal_validation_resolution",
      resourceKey: draft.draftId,
      scope: "planner",
      status: "ready",
      payload: { draftId: draft.draftId },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "goal_slice_plan",
      resourceKey: draft.draftId,
      scope: "planner",
      status: "ready",
      payload: { draftId: draft.draftId },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "goal_requirement_coverage",
      resourceKey: draft.draftId,
      scope: "planner",
      status: "ready",
      payload: {
        draftId: draft.draftId,
        goalRequirementDraftId: draft.draftId,
        goalRequirementDraftHash: draft.goalRequirementDraftHash,
      },
    });
    const dagDraftId = `${draft.draftId}:dag`;
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: dagDraftId,
      scope: "planner",
      status: "validated",
      payload: {
        goalRequirementDraftId: draft.draftId,
        goalRequirementDraftHash: draft.goalRequirementDraftHash,
      },
    });
    const runId = `run-${randomUUID()}`;
    await createWorkflowRunPg(db, {
      id: runId,
      status: "completed",
      domain: "design/article",
      goalPrompt: draft.goalRequirementDraft.originalPrompt,
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: JSON.stringify({
        draftId: dagDraftId,
        goalRequirementDraftId: draft.draftId,
        goalRequirementDraftHash: draft.goalRequirementDraftHash,
      }),
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "evidence_packet",
      resourceKey: `${draft.draftId}:evidence`,
      runId,
      scope: "evaluator",
      status: "complete",
      payload: {
        schemaVersion: "southstar.evidence_packet.v1",
        id: `${draft.draftId}:evidence`,
        runId,
        taskId: "task-evaluator",
        evidenceItems: [],
        completeness: { required: 0, present: 0, missing: 0 },
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "requirement_evaluator_result",
      resourceKey: `${draft.draftId}:evaluation`,
      runId,
      scope: "evaluator",
      status: "passed",
      payload: {
        schemaVersion: "southstar.requirement_evaluator_result.v2",
        requirementId: draft.goalRequirementDraft.requirements[0]!.id,
        validationBindingId: "binding-test",
        artifactRefs: ["artifact-test"],
        evaluatorId: "evaluator-test",
        evaluatorTaskId: "task-evaluator",
        evaluatorProfileRef: "evaluator.test",
        evaluatorProfileVersionRef: "evaluator.test@v1",
        verdict: "passed",
        criteriaResults: [{ criterionId: draft.goalRequirementDraft.requirements[0]!.acceptanceCriteria[0]!.id, verdict: "passed", evidenceRefs: [`${draft.draftId}:evidence`], findings: [] }],
        evidenceRefs: [`${draft.draftId}:evidence`],
        findings: [],
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "goal_outcome",
      resourceKey: `goal-outcome:${runId}`,
      runId,
      scope: "evaluator",
      status: "satisfied",
      payload: {
        schemaVersion: "southstar.goal_outcome.v1",
        runId,
        outcomeStatus: "satisfied",
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "validator_result",
      resourceKey: `${draft.draftId}:validator`,
      runId,
      scope: "evaluator",
      status: "passed",
      payload: {
        draftId: draft.draftId,
        goalRequirementDraftId: draft.draftId,
        goalRequirementDraftHash: draft.goalRequirementDraftHash,
      },
    });
    const criterion = draft.goalRequirementDraft.requirements[0]!.acceptanceCriteria[0]!;
    const revised = await reviseGoalRequirementPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      requirementId: draft.goalRequirementDraft.requirements[0]!.id,
      patch: {
        acceptanceCriteria: [{
          id: criterion.id,
          observableClaim: "The accepted article opens offline and renders its title.",
          blocking: criterion.blocking,
          verificationIntent: [...criterion.verificationIntent],
          requiredAssurance: [...criterion.requiredAssurance],
          evidenceIntent: [...criterion.evidenceIntent],
        }],
      },
    });
    assert.equal(revised.status, "requirements_review");
    assert.equal(revised.invalidated?.validationBindings, true);
    assert.equal(revised.invalidated?.slicePlan, true);
    assert.equal(revised.invalidated?.dagDraft, true);
    assert.equal(revised.invalidated?.evidence, true);
    assert.equal(revised.invalidated?.evaluation, true);
    assert.equal(revised.goalRequirementDraft.requirements[0]!.acceptanceCriteria[0]!.id, criterion.id);
    assert.equal(revised.goalRequirementDraft.requirements[0]!.acceptanceCriteria[0]!.version, criterion.version + 1);
    const validation = await getResourceByKeyPg(db, "goal_validation_resolution", draft.draftId);
    const slice = await getResourceByKeyPg(db, "goal_slice_plan", draft.draftId);
    const coverage = await getResourceByKeyPg(db, "goal_requirement_coverage", draft.draftId);
    const dag = await getResourceByKeyPg(db, "planner_draft", dagDraftId);
    const evidence = await getResourceByKeyPg(db, "evidence_packet", `${draft.draftId}:evidence`);
    const evaluation = await getResourceByKeyPg(db, "requirement_evaluator_result", `${draft.draftId}:evaluation`);
    const validatorResult = await getResourceByKeyPg(db, "validator_result", `${draft.draftId}:validator`);
    const sourceDraft = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    const outcome = await getResourceByKeyPg(db, "goal_outcome", `goal-outcome:${runId}`);
    assert.equal(validation?.status, "stale");
    assert.equal(slice?.status, "stale");
    assert.equal(coverage?.status, "stale");
    assert.equal(dag?.status, "stale");
    assert.equal(evidence?.status, "stale");
    assert.equal(evaluation?.status, "stale");
    assert.equal(validatorResult?.status, "stale");
    assert.equal(outcome?.status, "stale");
    assert.equal("workflow" in (sourceDraft?.payload ?? {}), false);
    assert.equal("workflowManifestHash" in (sourceDraft?.payload ?? {}), false);
    assert.equal("goalRequirementCoverage" in (sourceDraft?.payload ?? {}), false);
    assert.equal("orchestrationSnapshot" in (sourceDraft?.payload ?? {}), false);
    assert.equal("slicePlan" in (sourceDraft?.payload ?? {}), false);
  });
});

test("planner draft persists a design/article Goal Contract and uses its domain", async () => {
  await withDb(async (db) => {
    const goalPrompt = "Turn notes.md into an offline HTML article";
    const goalContract = articleGoalContract(goalPrompt);
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    await upsertLibraryObject(db, {
      objectKey: "domain.design-article",
      objectKind: "domain_taxonomy",
      status: "approved",
      headVersionId: "domain.design-article@v1",
      state: { scope: "design/article" },
    });
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt,
      cwd: "/workspace/article",
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer: new DeterministicFixtureComposer(),
    });
    assert.equal(draft.status, "validated", JSON.stringify(draft.validationIssues));

    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal((stored!.payload as any).goalContract.domain, "design/article");
    assert.equal((stored!.payload as any).goalContract.originalPrompt, goalPrompt);
    assert.equal((stored!.payload as any).workflow.domain, "design/article");
    assert.equal((stored!.summary as any).goalContractHash, draft.goalContractHash);
    assert.equal((stored!.summary as any).domain, "design/article");
    assert.equal(draft.goalPrompt, goalPrompt);
  });
});

test("generated planner DAG keeps source requirement lineage through materialization", async () => {
  await withDb(async (db) => {
    const cwd = await mkdtemp(join(tmpdir(), "southstar-goal-lineage-"));
    try {
    const goalPrompt = "Turn notes.md into an offline HTML article";
    const goalContract = articleGoalContract(goalPrompt);
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    await upsertLibraryObject(db, {
      objectKey: "domain.design-article",
      objectKind: "domain_taxonomy",
      status: "approved",
      headVersionId: "domain.design-article@lineage-test",
      state: { scope: "design/article" },
    });
    await seedGoalDesignSkill(db);
    const sourceRequirement = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt,
      cwd,
      requirementInterpreter: requirementDraftInterpreter(goalPrompt, cwd),
    });
    await confirmGoalRequirementsPg(db, {
      draftId: sourceRequirement.draftId,
      expectedDraftHash: sourceRequirement.goalRequirementDraftHash,
      goalContractMetadata: {
        domain: "design/article",
        intent: "publish_article",
        workType: "general",
        expectedArtifactRefs: [],
        requiredCapabilities: [],
        assumptions: [],
        requestedSideEffects: [],
      },
    });
    await assert.rejects(
      () => createCanonicalPlannerDraftFixture(db, {
        goalPrompt,
        cwd,
        goalInterpreter: fixedGoalInterpreter(goalContract),
        composer: new DeterministicFixtureComposer(),
        goalRequirementDraftId: sourceRequirement.draftId,
        goalRequirementDraftHash: sourceRequirement.goalRequirementDraftHash,
      }),
      /goal_requirement_draft_stale/,
    );
    await db.query(
      `update southstar.runtime_resources
          set status = 'validation_ready',
              payload_json = payload_json || '{"goalDesignPhase":"validation_ready"}'::jsonb,
              updated_at = now()
        where resource_type = 'planner_draft' and resource_key = $1`,
      [sourceRequirement.draftId],
    );
    await db.query(
      `update southstar.runtime_resources
          set payload_json = payload_json || jsonb_build_object('goalRequirementDraftHash', $2::text),
              updated_at = now()
        where resource_type = 'planner_draft' and resource_key = $1`,
      [sourceRequirement.draftId, "0".repeat(64)],
    );
    await assert.rejects(
      () => createCanonicalPlannerDraftFixture(db, {
        goalPrompt,
        cwd,
        goalInterpreter: fixedGoalInterpreter(goalContract),
        composer: new DeterministicFixtureComposer(),
        goalRequirementDraftId: sourceRequirement.draftId,
        goalRequirementDraftHash: sourceRequirement.goalRequirementDraftHash,
      }),
      /goal_requirement_draft_stale/,
    );
    await db.query(
      `update southstar.runtime_resources
          set payload_json = payload_json || jsonb_build_object('goalRequirementDraftHash', $2::text),
              updated_at = now()
        where resource_type = 'planner_draft' and resource_key = $1`,
      [sourceRequirement.draftId, sourceRequirement.goalRequirementDraftHash],
    );
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{goalRequirementDraft,draftHash}', to_jsonb($2::text), false),
              updated_at = now()
        where resource_type = 'planner_draft' and resource_key = $1`,
      [sourceRequirement.draftId, "0".repeat(64)],
    );
    await assert.rejects(
      () => createCanonicalPlannerDraftFixture(db, {
        goalPrompt,
        cwd,
        goalInterpreter: fixedGoalInterpreter(goalContract),
        composer: new DeterministicFixtureComposer(),
        goalRequirementDraftId: sourceRequirement.draftId,
        goalRequirementDraftHash: sourceRequirement.goalRequirementDraftHash,
      }),
      /goal_requirement_draft_stale/,
    );
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{goalRequirementDraft,draftHash}', to_jsonb($2::text), false),
              updated_at = now()
        where resource_type = 'planner_draft' and resource_key = $1`,
      [sourceRequirement.draftId, sourceRequirement.goalRequirementDraftHash],
    );
    await assert.rejects(
      () => createCanonicalPlannerDraftFixture(db, {
        goalPrompt,
        cwd: "/workspace/article",
        goalInterpreter: fixedGoalInterpreter(goalContract),
        composer: new DeterministicFixtureComposer(),
        goalRequirementDraftId: sourceRequirement.draftId,
        goalRequirementDraftHash: sourceRequirement.goalRequirementDraftHash,
      }),
      /goal_requirement_source_workspace_mismatch/,
    );
    await assert.rejects(
      () => createCanonicalPlannerDraftFixture(db, {
        goalPrompt,
        cwd,
        projectRef: "different-project",
        goalInterpreter: fixedGoalInterpreter(goalContract),
        composer: new DeterministicFixtureComposer(),
        goalRequirementDraftId: sourceRequirement.draftId,
        goalRequirementDraftHash: sourceRequirement.goalRequirementDraftHash,
      }),
      /goal_requirement_source_workspace_mismatch/,
    );
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt,
      cwd,
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer: new DeterministicFixtureComposer(),
      goalRequirementDraftId: sourceRequirement.draftId,
      goalRequirementDraftHash: sourceRequirement.goalRequirementDraftHash,
    });
    assert.equal(draft.status, "validated", JSON.stringify(draft.validationIssues));
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal((stored!.payload as any).goalRequirementDraftId, sourceRequirement.draftId);
    assert.equal((stored!.payload as any).goalRequirementDraftHash, sourceRequirement.goalRequirementDraftHash);
    assert.equal((stored!.payload as any).plannerRequest.goalRequirementDraftId, sourceRequirement.draftId);
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const runtime = await db.one<{ runtime_context_json: any }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    assert.equal(runtime.runtime_context_json.goalRequirementDraftId, sourceRequirement.draftId);
    assert.equal(runtime.runtime_context_json.goalRequirementDraftHash, sourceRequirement.goalRequirementDraftHash);
    const revised = await reviseGoalRequirementPg(db, {
      draftId: sourceRequirement.draftId,
      expectedDraftHash: sourceRequirement.goalRequirementDraftHash,
      requirementId: sourceRequirement.goalRequirementDraft.requirements[0]!.id,
      patch: { statement: "Revise the source requirement and stale its materialized DAG lineage" },
    });
    assert.notEqual(revised.goalRequirementDraftHash, sourceRequirement.goalRequirementDraftHash);
    const staleDag = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal(staleDag?.status, "stale");
    assert.equal((staleDag?.payload as any).supersededByDraftHash, revised.goalRequirementDraftHash);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("planner draft snapshots source lineage before asynchronous validation", async () => {
  await withDb(async (db) => {
    const cwd = await mkdtemp(join(tmpdir(), "southstar-goal-lineage-snapshot-"));
    try {
      const goalPrompt = "Turn notes.md into an offline HTML article";
      const goalContract = articleGoalContract(goalPrompt);
      await seedDeterministicWorkflowGraph(db, goalContract.domain);
      await upsertLibraryObject(db, {
        objectKey: "domain.design-article",
        objectKind: "domain_taxonomy",
        status: "approved",
        headVersionId: "domain.design-article@snapshot-test",
        state: { scope: "design/article" },
      });
      await seedGoalDesignSkill(db);
      const sourceRequirement = await preparePostgresGoalRequirementDraft(db, {
        goalPrompt,
        cwd,
        projectRef: "snapshot-project",
        requirementInterpreter: requirementDraftInterpreter(goalPrompt, cwd, "snapshot-project"),
      });
      await confirmGoalRequirementsPg(db, {
        draftId: sourceRequirement.draftId,
        expectedDraftHash: sourceRequirement.goalRequirementDraftHash,
        goalContractMetadata: {
          domain: "design/article",
          intent: "publish_article",
          workType: "general",
          expectedArtifactRefs: [],
          requiredCapabilities: [],
          assumptions: [],
          requestedSideEffects: [],
        },
      });
      await db.query(
        `update southstar.runtime_resources
            set status = 'validation_ready',
                payload_json = payload_json || '{"goalDesignPhase":"validation_ready"}'::jsonb,
                updated_at = now()
          where resource_type = 'planner_draft' and resource_key = $1`,
        [sourceRequirement.draftId],
      );
      const goalDesignPackage = canonicalGoalDesignPackageFixture(
        goalContract,
        sourceRequirement.goalRequirementDraftHash,
      );
      await seedCanonicalValidationEdges(db, goalDesignPackage);
      const mutableInput = {
        goalPrompt,
        cwd,
        projectRef: "snapshot-project",
        compositionPlan: alignFixtureCompositionWithGoalDesignPackage(
          deterministicFixtureComposition(goalContract),
          goalDesignPackage,
        ),
        goalInterpreter: fixedGoalInterpreter(goalContract),
        goalDesignPackage,
        composer: new DeterministicFixtureComposer(),
        goalRequirementDraftId: sourceRequirement.draftId,
        goalRequirementDraftHash: sourceRequirement.goalRequirementDraftHash,
      };
      const expectedCompositionPlan = structuredClone(mutableInput.compositionPlan);
      const draftPromise = createCanonicalPlannerDraftFixture(db, mutableInput);
      mutableInput.cwd = "/workspace/mutated";
      mutableInput.projectRef = "mutated-project";
      mutableInput.goalRequirementDraftId = "mutated-source";
      mutableInput.goalRequirementDraftHash = "f".repeat(64);
      mutableInput.compositionPlan.tasks[0]!.name = "Mutated after request";
      const draft = await draftPromise;
      assert.equal(draft.status, "validated");
      const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
      assert.equal((stored!.payload as any).plannerRequest.cwd, cwd);
      assert.equal((stored!.payload as any).plannerRequest.projectRef, "snapshot-project");
      assert.equal((stored!.payload as any).plannerRequest.goalRequirementDraftId, sourceRequirement.draftId);
      assert.equal((stored!.payload as any).plannerRequest.goalRequirementDraftHash, sourceRequirement.goalRequirementDraftHash);
      assert.deepEqual((stored!.payload as any).plannerRequest.compositionPlan, expectedCompositionPlan);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("planner draft gives the Goal interpreter approved Library vocabulary", async () => {
  await withDb(async (db) => {
    const goalPrompt = "Turn notes.md into an offline HTML article";
    const goalContract = articleGoalContract(goalPrompt);
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    await upsertLibraryObject(db, {
      objectKey: "domain.design-article",
      objectKind: "domain_taxonomy",
      status: "approved",
      headVersionId: "domain.design-article@v1",
      state: { scope: "design/article" },
    });
    await upsertLibraryObject(db, {
      objectKey: "capability.article-workspace-read",
      objectKind: "capability_spec",
      status: "approved",
      headVersionId: "capability.article-workspace-read@v1",
      state: { scope: "design/article" },
    });
    await upsertLibraryObject(db, {
      objectKey: "artifact.article_html",
      objectKind: "artifact_contract",
      status: "approved",
      headVersionId: "artifact.article_html@v1",
      state: { scope: "design/article" },
    });
    let vocabulary: Parameters<GoalContractInterpreter["interpret"]>[0]["libraryVocabulary"];
    const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract);
    await seedCanonicalValidationEdges(db, goalDesignPackage);

    await createCanonicalPlannerDraftFixture(db, {
      goalPrompt,
      cwd: "/workspace/article",
      goalDesignPackage,
      goalInterpreter: {
        async interpret(input) {
          vocabulary = input.libraryVocabulary;
          return structuredClone(goalContract);
        },
      },
      composer: {
        async compose(input) {
          return alignFixtureCompositionWithGoalDesignPackage(
            deterministicFixtureComposition(input.goalContract),
            goalDesignPackage,
          );
        },
      },
    });

    assert.ok(vocabulary?.scopes.includes("design/article"));
    assert.ok(vocabulary?.capabilityRefs.some((ref) => ref.startsWith("capability.")));
    assert.ok(vocabulary?.artifactRefs.some((ref) => ref.startsWith("artifact.")));
  });
});

test("dag-validated Goal Design can fork one staged Slice revision without changing Requirements", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Revise the staged slices after DAG validation");
    await seedOfflineHtmlValidationObjects(db);
    const resolution = validationResolution(goal, true);
    await persistGoalValidationResolutionPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      expectedGoalRequirementDraftHash: goal.goalRequirementDraftHash,
      resolution,
      actor: "test",
    });
    const designed = await designAndPersistGoalSlicesPg(db, {
      draftId: goal.draftId,
      expectedResolutionHash: resolution.resolutionHash,
      sliceDesigner: inlineArticleSliceDesigner(),
    });
    const source = await getResourceByKeyPg(db, "planner_draft", goal.draftId);
    assert.ok(source);
    await upsertRuntimeResourcePg(db, {
      id: source.id,
      resourceType: "planner_draft",
      resourceKey: goal.draftId,
      scope: source.scope,
      status: source.status,
      ...(source.title ? { title: source.title } : {}),
      payload: {
        ...source.payload,
        goalDesignPhase: "dag_validated",
        composedDraftId: "draft-composed-existing",
      },
      summary: {
        ...source.summary,
        goalDesignPhase: "dag_validated",
      },
    });

    const revision = await createStagedGoalSliceRevisionPg(db, {
      draftId: goal.draftId,
      expectedPackageHash: designed.goalDesignPackageHash,
    });

    assert.notEqual(revision.draftId, goal.draftId);
    assert.equal(revision.phase, "slice_review");
    assert.equal(revision.parentDraftId, goal.draftId);
    assert.equal(revision.parentPackageHash, designed.goalDesignPackageHash);
    assert.equal(revision.goalRequirementDraftHash, goal.goalRequirementDraftHash);
    assert.equal(revision.goalContractHash, goal.goalContractHash);
    assert.equal(revision.goalDesignPackageHash, designed.goalDesignPackageHash);
    assert.deepEqual(revision.goalRequirementDraft, goal.goalRequirementDraft);
    assert.equal(
      (await getPostgresPlannerDraftOrchestration(db, { draftId: goal.draftId })).goalDesignPhase,
      "dag_validated",
    );
    assert.equal(
      (await getPostgresPlannerDraftOrchestration(db, { draftId: revision.draftId })).goalDesignPhase,
      "slice_review",
    );

    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: "draft-composed-existing",
      scope: "planner",
      status: "validated",
      payload: { goalDesignPackageHash: designed.goalDesignPackageHash },
      summary: { goalDesignPackageHash: designed.goalDesignPackageHash },
    });
    await db.query(
      `insert into southstar.workflow_runs (
        id, status, domain, goal_prompt, workflow_manifest_json, execution_projection_json,
        snapshot_json, runtime_context_json, metrics_json, created_at, updated_at
      ) values ($1, 'created', 'software', 'goal', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        $2::jsonb, '{}'::jsonb, now(), now())`,
      ["run-composed-existing", JSON.stringify({ draftId: "draft-composed-existing" })],
    );

    const edited = await reviseGoalSlicePg(db, {
      draftId: revision.draftId,
      sliceId: revision.goalDesignPackage.slicePlan.slices[0]!.id,
      expectedPackageHash: revision.goalDesignPackageHash,
      patch: { outcome: "Review the revised staged Slice" },
    });
    assert.equal(edited.revision, revision.goalDesignPackage.revision + 1);
    const editedView = await getPostgresPlannerDraftOrchestration(db, { draftId: revision.draftId });
    assert.equal(editedView.goalDesignPackageHash, edited.packageHash);
    assert.equal(editedView.goalDesignPackage?.revision, edited.revision);
    const parentAfterEdit = await getResourceByKeyPg(db, "planner_draft", goal.draftId);
    assert.ok(parentAfterEdit);
    assert.equal(parentAfterEdit.status, "ready_for_review");
    assert.equal((parentAfterEdit.payload as Record<string, unknown>).goalDesignPhase, "dag_validated");

    const repeated = await createStagedGoalSliceRevisionPg(db, {
      draftId: goal.draftId,
      expectedPackageHash: designed.goalDesignPackageHash,
    });
    assert.equal(repeated.draftId, revision.draftId);
  });
});

test("removed V1 Goal Design drafts are not readable", async () => {
  await withDb(async (db) => {
    const legacy = packageRevision(1);
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: "legacy-v1-draft",
      scope: "planner",
      status: "ready_for_review",
      payload: { goalDesignPackage: legacy },
      summary: { goalDesignPackageHash: legacy.packageHash },
    });

    for (const operation of [
      () => loadCurrentGoalDesignPackagePg(db, "legacy-v1-draft"),
      () => patchPostgresPlannerDraftTaskProfileOverride(db, {
        draftId: "legacy-v1-draft",
        taskId: "task-build",
        profileOverride: { provider: "pi", model: "pi-default" },
      }),
      () => validatePostgresPlannerDraft(db, { draftId: "legacy-v1-draft" }),
      () => createPostgresRunFromDraft(db, { draftId: "legacy-v1-draft" }),
    ]) {
      await assert.rejects(operation, /canonical_goal_design_package_invalid/);
    }
    const stored = await getResourceByKeyPg(db, "planner_draft", "legacy-v1-draft");
    assert.equal(stored?.status, "invalid");
    assert.equal(
      ((stored?.payload as { canonicalDiagnostic?: { code?: string } }).canonicalDiagnostic?.code),
      "canonical_goal_design_package_invalid",
    );
    const view = await getPostgresPlannerDraftOrchestration(db, { draftId: "legacy-v1-draft" });
    assert.ok(view.blockers.some((blocker) => blocker.includes("canonical_goal_design_package_invalid")));
    assert.ok(view.validationIssues.some((issue) => issue.code === "canonical_goal_design_package_invalid"));
  });
});

test("canonical draft operations reject and persist a mismatched stored Goal Design package hash", async () => {
  await withDb(async (db) => {
    const goalContract = softwareGoalContract("reject stale stored package lineage");
    const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract);
    const operations = [
      (draftId: string) => loadCurrentGoalDesignPackagePg(db, draftId),
      (draftId: string) => patchPostgresPlannerDraftTaskProfileOverride(db, {
        draftId,
        taskId: "task-build",
        profileOverride: { provider: "pi", model: "pi-default" },
      }),
      (draftId: string) => validatePostgresPlannerDraft(db, { draftId }),
    ];
    for (const [index, operation] of operations.entries()) {
      const draftId = `stale-package-hash-${index}`;
      await upsertRuntimeResourcePg(db, {
        resourceType: "planner_draft",
        resourceKey: draftId,
        scope: "planner",
        status: "validated",
        payload: {
          goalDesignPackage,
          goalDesignPackageHash: "stale-package-hash",
        },
      });

      const view = await getPostgresPlannerDraftOrchestration(db, { draftId });
      assert.equal(view.goalDesignPackage, undefined);
      assert.ok(view.blockers.some((blocker) => blocker.includes("canonical_goal_design_package_invalid")));
      assert.ok(view.validationIssues.some((issue) => issue.code === "canonical_goal_design_package_invalid"));

      await assert.rejects(
        () => operation(draftId),
        /canonical_goal_design_package_invalid: planner draft .* stored Goal Design package hash does not match its canonical package/,
      );
      const stored = await getResourceByKeyPg(db, "planner_draft", draftId);
      assert.equal(stored?.status, "invalid");
      assert.equal(
        ((stored?.payload as { canonicalDiagnostic?: { code?: string } }).canonicalDiagnostic?.code),
        "canonical_goal_design_package_invalid",
      );
    }
  });
});

test("Goal Design confirmation durably rejects V1 and mismatched stored package lineage", async () => {
  await withDb(async (db) => {
    const goalContract = softwareGoalContract("reject incompatible Goal Design confirmation");
    const canonicalPackage = canonicalGoalDesignPackageFixture(goalContract);
    const legacyPackage = packageRevision(1);
    const cases = [
      {
        draftId: "confirm-legacy-v1-package",
        packageValue: legacyPackage,
        storedPackageHash: legacyPackage.packageHash,
        expectedPackageHash: legacyPackage.packageHash,
      },
      {
        draftId: "confirm-mismatched-v2-package-hash",
        packageValue: canonicalPackage,
        storedPackageHash: "stale-package-hash",
        expectedPackageHash: canonicalPackage.packageHash,
      },
    ];
    for (const item of cases) {
      await upsertRuntimeResourcePg(db, {
        resourceType: "planner_draft",
        resourceKey: item.draftId,
        scope: "planner",
        status: "ready_for_review",
        payload: {
          goalDesignPhase: "slice_review",
          goalDesignPackage: item.packageValue,
          goalDesignPackageHash: item.storedPackageHash,
        },
      });

      await assert.rejects(
        () => confirmGoalDesignPg({ db, goalInterpreter: fixedGoalInterpreter(goalContract) }, {
          draftId: item.draftId,
          expectedPackageHash: item.expectedPackageHash,
        }),
        /canonical_goal_design_package_invalid/,
      );
      const stored = await getResourceByKeyPg(db, "planner_draft", item.draftId);
      assert.equal(stored?.status, "invalid");
      assert.equal(
        ((stored?.payload as { canonicalDiagnostic?: { code?: string } }).canonicalDiagnostic?.code),
        "canonical_goal_design_package_invalid",
      );
    }
  });
});

test("removed V1 Goal Design packages are rejected durably by every Slice revision path", async () => {
  await withDb(async (db) => {
    const legacy = packageRevision(1);
    const goalContract = softwareGoalContract("reject V1 chat Slice revision");
    const cases = [
      {
        draftId: "legacy-v1-staged-revision",
        phase: "dag_validated",
        operation: (draftId: string) => createStagedGoalSliceRevisionPg(db, {
          draftId,
          expectedPackageHash: legacy.packageHash,
        }),
      },
      {
        draftId: "legacy-v1-slice-revision",
        phase: "slice_review",
        operation: (draftId: string) => reviseGoalSlicePg(db, {
          draftId,
          sliceId: "slice-legacy",
          expectedPackageHash: legacy.packageHash,
          patch: { outcome: "must not revise V1" },
        }),
      },
      {
        draftId: "legacy-v1-template-revision",
        phase: "slice_review",
        operation: (draftId: string) => reviseGoalTemplatePolicyPg(db, {
          draftId,
          expectedPackageHash: legacy.packageHash,
          templatePolicy: { mode: "auto" },
        }),
      },
      {
        draftId: "legacy-v1-chat-revision",
        phase: "slice_review",
        operation: (draftId: string) => reviseGoalDesignFromChatPg({
          db,
          goalInterpreter: fixedGoalInterpreter(goalContract),
        }, {
          draftId,
          expectedPackageHash: legacy.packageHash,
          message: "must not revise V1 through chat",
        }),
      },
    ];
    for (const item of cases) {
      await upsertRuntimeResourcePg(db, {
        resourceType: "planner_draft",
        resourceKey: item.draftId,
        scope: "planner",
        status: "ready_for_review",
        payload: {
          goalDesignPhase: item.phase,
          goalDesignPackage: legacy,
          goalDesignPackageHash: legacy.packageHash,
        },
      });

      await assert.rejects(() => item.operation(item.draftId), /canonical_goal_design_package_invalid/);
      const stored = await getResourceByKeyPg(db, "planner_draft", item.draftId);
      assert.equal(stored?.status, "invalid");
      assert.equal(
        ((stored?.payload as { canonicalDiagnostic?: { code?: string } }).canonicalDiagnostic?.code),
        "canonical_goal_design_package_invalid",
      );
    }
  });
});

test("Package V3 review chat revises through the JSON and SSE planner routes", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Review an offline article");
    await seedOfflineHtmlValidationObjects(db);
    const resolution = validationResolution(goal, true);
    await persistGoalValidationResolutionPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      expectedGoalRequirementDraftHash: goal.goalRequirementDraftHash,
      resolution,
      actor: "test",
    });
    const designed = await designAndPersistGoalSlicesPg(db, {
      draftId: goal.draftId,
      expectedResolutionHash: resolution.resolutionHash,
      sliceDesigner: inlineArticleSliceDesigner(),
    });
    const stagedSliceDesigner = {
      ...inlineArticleSliceDesigner(),
      async revise(input: any) {
        const currentSlice = input.currentPackage.slicePlan.slices[0];
        return {
          kind: "revision" as const,
          summary: "Updated the staged Slice outcome.",
          changedSliceIds: [currentSlice.id],
          slicePlan: {
            schemaVersion: "southstar.goal_slice_plan.v1" as const,
            goalContractHash: "host-filled",
            revision: input.currentPackage.revision + 1,
            slices: [{ ...currentSlice, outcome: "Review the revised offline article" }],
          },
          compositionStrategy: input.currentPackage.compositionStrategy,
        };
      },
    };
    const routeContext = {
      db,
      goalInterpreter: fixedGoalInterpreter(goal.goalContract),
      goalSliceDesigner: stagedSliceDesigner,
      plannerClient: { generate: async () => { throw new Error("planner must not run"); } },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor must not run"); } },
    };
    const response = await handleRuntimeRoute(routeContext, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${goal.draftId}/revise`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "revise the article outcome",
          expectedPackageHash: designed.goalDesignPackageHash,
        }),
      },
    ));
    assert.equal(response.status, 200, await response.clone().text());
    const revised = (await response.json() as { result: { package: GoalDesignPackageV3; draftStatus: string } }).result;
    assert.equal(revised.package.schemaVersion, "southstar.goal_design_package.v3");
    assert.equal(revised.package.revision, designed.goalDesignPackage.revision + 1);
    assert.equal(revised.package.slicePlan.slices[0]!.outcome, "Review the revised offline article");
    assert.equal(revised.draftStatus, "ready_for_review");

    const streamResponse = await handleRuntimeRoute(routeContext, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${goal.draftId}/revise/stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "revise the article outcome again",
          expectedPackageHash: revised.package.packageHash,
        }),
      },
    ));
    const events = await streamResponse.text();
    assert.match(events, /event: goal_design/);
    assert.match(events, /southstar\.goal_design_package\.v3/);
    assert.match(events, /event: done/);
    assert.doesNotMatch(events, /event: error/);
  });
});

test("Package V3 confirmation rejects stale hashes and materializes exactly one run", async () => {
  await withDb(async (db) => {
    await seedInlineArticleValidationAndCompositionGraph(db);
    await seedOfflineHtmlValidationObjects(db);
    const goal = await createConfirmedGoalRequirementDraft(db, "Deliver a verified offline article", "/tmp");
    const resolution = validationResolution(goal, true);
    await persistGoalValidationResolutionPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      expectedGoalRequirementDraftHash: goal.goalRequirementDraftHash,
      resolution,
      actor: "test",
    });
    const designed = await designAndPersistGoalSlicesPg(db, {
      draftId: goal.draftId,
      expectedResolutionHash: resolution.resolutionHash,
      sliceDesigner: inlineArticleSliceDesigner(),
    });
    let composerCalls = 0;
    const context = {
      db,
      goalInterpreter: fixedGoalInterpreter(goal.goalContract),
      goalSliceDesigner: inlineArticleSliceDesigner(),
      composer: {
        async compose(input: ComposeWorkflowInput) {
          composerCalls += 1;
          return inlineArticleComposition(
            input.goalContract,
            input.goalDesignPackage!.slicePlan.slices[0]!.id,
            "artifact.offline-html",
            "evaluator.offline-html",
          );
        },
      },
    };

    await assert.rejects(
      () => confirmGoalDesignPg(context, {
        draftId: goal.draftId,
        expectedPackageHash: "0".repeat(64),
      }),
      /goal_design_package_stale/,
    );
    assert.equal(composerCalls, 0);

    const first = await confirmGoalDesignPg(context, {
      draftId: goal.draftId,
      expectedPackageHash: designed.goalDesignPackageHash,
    });
    const replay = await confirmGoalDesignPg(context, {
      draftId: goal.draftId,
      expectedPackageHash: designed.goalDesignPackageHash,
    });
    assert.equal(first.runId, replay.runId);
    assert.equal(first.draftStatus, "validated");
    assert.equal(first.goalDesignPhase, "dag_validated");
    assert.equal(composerCalls, 1);
    const runCount = await db.one<{ count: string }>("select count(*)::text as count from southstar.workflow_runs");
    assert.equal(runCount.count, "1");
    const source = await getPostgresPlannerDraftOrchestration(db, { draftId: goal.draftId });
    assert.equal(source.goalDesignPhase, "dag_validated");
  });
});

test("run materialization restores a missing manifest domain from the validated Goal Contract", async () => {
  await withDb(async (db) => {
    const goalPrompt = "Turn notes.md into an offline HTML article";
    const goalContract = articleGoalContract(goalPrompt);
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt,
      cwd: "/workspace/article",
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer: new DeterministicFixtureComposer(),
    });
    const storedDraft = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.ok(storedDraft);
    const payload = structuredClone(storedDraft.payload) as Record<string, any>;
    delete payload.workflow.domain;
    payload.workflowManifestHash = contentHashForPayload(payload.workflow);
    await upsertRuntimeResourcePg(db, {
      id: storedDraft.id,
      resourceType: "planner_draft",
      resourceKey: draft.draftId,
      scope: storedDraft.scope,
      status: storedDraft.status,
      ...(storedDraft.title ? { title: storedDraft.title } : {}),
      payload,
      summary: storedDraft.summary,
      metrics: storedDraft.metrics,
    });

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const storedRun = await db.one<{ domain: string; workflow_manifest_json: { domain?: string } }>(
      "select domain, workflow_manifest_json from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    assert.equal(storedRun.domain, goalContract.domain);
    assert.equal(storedRun.workflow_manifest_json.domain, goalContract.domain);
  });
});

test("direct run creation rejects a legacy validated draft without explicit Goal Contract lineage", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement legacy direct run compatibility");
    await stripGoalContractFromDraft(db, draft.draftId, {
      missingInputs: ["Which API contract should be used?"],
    });
    const before = await db.one<{ runs: string; tasks: string }>(
      `select
        (select count(*)::text from southstar.workflow_runs) as runs,
        (select count(*)::text from southstar.workflow_tasks) as tasks`,
    );

    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /planner draft Goal Contract is missing/,
    );

    const after = await db.one<{ runs: string; tasks: string }>(
      `select
        (select count(*)::text from southstar.workflow_runs) as runs,
        (select count(*)::text from southstar.workflow_tasks) as tasks`,
    );
    assert.deepEqual(after, before);
  });
});

test("Postgres run API creates draft, run, tasks, and history without prebuilding task context", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement calc sum");
    assert.match(draft.draftId, /^draft-wf-composed-/);
    assert.equal(draft.status, "validated");
    assert.deepEqual(draft.validationIssues, []);
    assert.deepEqual(draft.taskSummaries.map((task) => task.taskId), FIXTURE_TASK_IDS);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.match(run.runId, /^run-wf-composed-/);

    const runRow = await db.one<{
      status: string;
      workflow_manifest_json: {
        compiledFrom?: { templateDefinitionId?: string; templateVersionId?: string; libraryVersionRefs?: string[] };
      };
      runtime_context_json: {
        draftId?: string;
        goalContractHash?: string;
        manifestHash?: string;
        librarySnapshotHash?: string;
        outcomeStatus?: string;
      };
    }>("select status, workflow_manifest_json, runtime_context_json from southstar.workflow_runs where id = $1", [run.runId]);
    assert.equal(runRow.status, "created");
    assert.equal(runRow.runtime_context_json.draftId, draft.draftId);
    assert.equal(runRow.runtime_context_json.goalContractHash, draft.goalContractHash);
    assert.match(runRow.runtime_context_json.manifestHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(runRow.runtime_context_json.librarySnapshotHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(runRow.runtime_context_json.outcomeStatus, "in_progress");
    assert.equal(runRow.workflow_manifest_json.compiledFrom?.templateDefinitionId, "template.software-feature");
    assert.equal(runRow.workflow_manifest_json.compiledFrom?.templateVersionId, "template.software-feature@test");
    assert.equal(
      runRow.workflow_manifest_json.compiledFrom?.libraryVersionRefs?.includes("template.software-feature@test"),
      true,
    );
    const taskRows = await db.query<{ id: string }>("select id from southstar.workflow_tasks where run_id = $1 order by sort_order", [run.runId]);
    assert.deepEqual(taskRows.rows.map((row) => row.id), FIXTURE_TASK_IDS);

    const history = await db.query<{ event_type: string }>("select event_type from southstar.workflow_history where run_id = $1 order by sequence", [run.runId]);
    assert.deepEqual(history.rows.map((row) => row.event_type), ["run.created", ...FIXTURE_TASK_IDS.map(() => "task.created")]);

    const prebuiltContextCount = await db.one<{ count: string }>(
      "select count(*)::text as count from southstar.runtime_resources where resource_type in ('context_packet', 'task_envelope', 'knowledge_card_injection_trace') and run_id = $1",
      [run.runId],
    );
    assert.equal(prebuiltContextCount.count, "0");
    const runResources = await db.query<{ resource_type: string; payload_json: Record<string, any> }>(
      `select resource_type, payload_json
         from southstar.runtime_resources
        where run_id = $1
        order by resource_type`,
      [run.runId],
    );
    assert.deepEqual(runResources.rows.map((row) => row.resource_type), [
      "goal_requirement_coverage",
      "run_library_snapshot",
    ]);
    const librarySnapshot = runResources.rows.find((row) => row.resource_type === "run_library_snapshot")!.payload_json;
    assert.equal(librarySnapshot.schemaVersion, "southstar.run_library_snapshot.v1");
    assert.equal(librarySnapshot.runId, run.runId);
    assert.equal(librarySnapshot.goalContractHash, draft.goalContractHash);
    assert.equal(librarySnapshot.snapshotHash, runRow.runtime_context_json.librarySnapshotHash);
    assert.equal(
      librarySnapshot.objects.some((object: { objectKey?: string }) => object.objectKey === "template.software-feature"),
      true,
    );
  });
});

test("Postgres run API persists the originating session in the run journey context", async () => {
  await withDb(async (db) => {
    const sessionId = "pi-goal-lineage-1";
    const contract = softwareGoalContract("implement calc sum");
    await seedDeterministicWorkflowGraph(db);
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: "implement calc sum",
      sessionId,
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      goalInterpreter: fixedGoalInterpreter(contract),
      composer: new DeterministicFixtureComposer(),
    });
    const storedDraft = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal(storedDraft?.sessionId, sessionId);
    assert.equal(draft.status, "validated", JSON.stringify(draft));

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const runRow = await db.one<{ runtime_context_json: Record<string, string> }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    assert.equal(runRow.runtime_context_json.sessionId, sessionId);
    assert.equal(runRow.runtime_context_json.journeyId, `goal-journey:${sessionId}`);
  });
});

test("missing selected Library version rolls back run creation atomically", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "reject missing selected Library version");
    await upsertLibraryObject(db, {
      objectKey: "template.software-feature",
      objectKind: "workflow_template",
      status: "approved",
      state: { scope: "software", title: "Software Feature Test Template" },
    });

    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /missing.*version|version.*mismatch/i,
    );

    const counts = await db.one<{ runs: string; tasks: string; history: string; resources: string }>(
      `select
         (select count(*)::text from southstar.workflow_runs) as runs,
         (select count(*)::text from southstar.workflow_tasks) as tasks,
         (select count(*)::text from southstar.workflow_history) as history,
         (select count(*)::text from southstar.runtime_resources where run_id is not null) as resources`,
    );
    assert.deepEqual(counts, { runs: "0", tasks: "0", history: "0", resources: "0" });
  });
});

test("credential-looking Library state rolls back run creation atomically", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "reject raw Library credentials");
    await upsertLibraryObject(db, {
      objectKey: "template.software-feature",
      objectKind: "workflow_template",
      status: "approved",
      headVersionId: "template.software-feature@test",
      state: {
        scope: "software",
        title: "Software Feature Test Template",
        apiKey: "sk-live-secret-value",
      },
    });

    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /credential|secret/i,
    );
    const counts = await db.one<{ runs: string; tasks: string; resources: string }>(
      `select
         (select count(*)::text from southstar.workflow_runs) as runs,
         (select count(*)::text from southstar.workflow_tasks) as tasks,
         (select count(*)::text from southstar.runtime_resources where run_id is not null) as resources`,
    );
    assert.deepEqual(counts, { runs: "0", tasks: "0", resources: "0" });
  });
});

test("Postgres run creation rejects any stale canonical Goal Contract hash before writing run state", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "reject stale run contract lineage");
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.ok(stored);
    const originalPayload = structuredClone(stored.payload) as Record<string, any>;
    const originalSummary = structuredClone(stored.summary) as Record<string, any>;
    const staleHash = "0".repeat(64);
    const cases = [
      {
        label: "payload.goalContractHash",
        mutate(payload: Record<string, any>, _summary: Record<string, any>) {
          payload.goalContractHash = staleHash;
        },
      },
      {
        label: "summary.goalContractHash",
        mutate(_payload: Record<string, any>, summary: Record<string, any>) {
          summary.goalContractHash = staleHash;
        },
      },
      {
        label: "goalRequirementCoverage.goalContractHash",
        mutate(payload: Record<string, any>, _summary: Record<string, any>) {
          payload.goalRequirementCoverage.goalContractHash = staleHash;
        },
      },
      {
        label: "orchestrationSnapshot.goalContractHash",
        mutate(payload: Record<string, any>, _summary: Record<string, any>) {
          payload.orchestrationSnapshot.goalContractHash = staleHash;
        },
      },
    ];

    for (const testCase of cases) {
      const payload = structuredClone(originalPayload);
      const summary = structuredClone(originalSummary);
      testCase.mutate(payload, summary);
      await upsertRuntimeResourcePg(db, {
        id: stored.id,
        resourceType: "planner_draft",
        resourceKey: draft.draftId,
        scope: stored.scope,
        status: "validated",
        ...(stored.title ? { title: stored.title } : {}),
        payload,
        summary,
        metrics: stored.metrics,
      });

      await assert.rejects(
        () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
        new RegExp(`Goal Contract hash mismatch.*${testCase.label}`),
      );
      const counts = await db.one<{ runs: string; tasks: string }>(
        `select
           (select count(*)::text from southstar.workflow_runs) as runs,
           (select count(*)::text from southstar.workflow_tasks) as tasks`,
      );
      assert.deepEqual(counts, { runs: "0", tasks: "0" });
    }
  });
});

test("Postgres run creation rejects tampered manifest, coverage, and Goal Design Package hashes", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "reject planner payload tampering");
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.ok(stored);
    const originalPayload = structuredClone(stored.payload) as Record<string, any>;
    const contract = originalPayload.goalContract as GoalContractV1;
    const requirement = contract.requirements[0]!;
    const artifactRef = contract.expectedArtifactRefs[0]!;
    const bindingId = "binding-run-hash-test";
    const criterionIds = requirement.acceptanceCriteria.map((criterion) => criterion.id);
    const packageValue = finalizeGoalDesignPackageV3({
      schemaVersion: "southstar.goal_design_package.v3",
      revision: 1,
      goalContract: contract,
      requirementDraftHash: "1".repeat(64),
      validationBindings: [{
        schemaVersion: "southstar.requirement_validation_binding.v3",
        id: bindingId,
        requirementId: requirement.id,
        criterionBindings: requirement.acceptanceCriteria.map((criterion) => ({
          criterionContract: { ...criterion },
          artifactContractRef: artifactRef,
          artifactContractVersionRef: `${artifactRef}@test`,
          evaluatorProfileRef: "evaluator.run-hash-test",
          evaluatorProfileVersionRef: "evaluator.run-hash-test@test",
          verificationMode: "deterministic" as const,
          procedureRef: "procedure.run-hash-test",
          expectedEvidenceKinds: ["test-result"],
          independence: "independent" as const,
          failureClassifications: ["implementation_gap"],
        })),
      }],
      slicePlan: {
        schemaVersion: "southstar.goal_slice_plan.v1",
        goalContractHash: "host-filled",
        revision: 1,
        slices: [{
          id: "slice-run-hash-test",
          requirementIds: [requirement.id],
          outcome: requirement.statement,
          stateOrArtifactOwner: artifactRef,
          mutationBoundary: "one requirement",
          expectedArtifactRefs: [artifactRef],
          evaluatorContractRefs: [bindingId],
          dependsOnSliceIds: [],
          dependencyArtifactRefs: [],
        }],
      },
      compositionStrategy: {
        mode: "single-run",
        sliceIds: ["slice-run-hash-test"],
        rationale: "one frozen validation boundary",
      },
      templatePolicy: { mode: "auto" },
      goalDesignSkillRef: "skill.southstar-goal-design",
      goalDesignSkillVersionRef: "skill.southstar-goal-design@test",
      workspaceDiscoveryHash: "discovery-hash",
      mode: "review_before_compose",
    });
    const cases = [
      {
        expected: /workflow manifest hash mismatch/,
        mutate(payload: Record<string, any>) {
          payload.workflow.title = "tampered workflow";
        },
      },
      {
        expected: /Goal Requirement Coverage hash mismatch/,
        mutate(payload: Record<string, any>) {
          payload.goalRequirementCoverage.entries[0].producerTaskIds.push("tampered-task");
        },
      },
      {
        expected: /canonical_goal_design_package_invalid/,
        mutate(payload: Record<string, any>) {
          payload.goalDesignPackage = packageValue;
          payload.goalDesignPackageHash = "0".repeat(64);
        },
      },
    ];

    for (const testCase of cases) {
      const payload = structuredClone(originalPayload);
      testCase.mutate(payload);
      await upsertRuntimeResourcePg(db, {
        id: stored.id,
        resourceType: "planner_draft",
        resourceKey: draft.draftId,
        scope: stored.scope,
        status: "validated",
        ...(stored.title ? { title: stored.title } : {}),
        payload,
        summary: stored.summary,
        metrics: stored.metrics,
      });
      await assert.rejects(
        () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
        testCase.expected,
      );
    }
  });
});

test("Postgres planner draft task profile override updates one task without changing other tasks", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement calc sum");

    const result = await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: {
        harnessRef: "codex",
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Use the smallest patch and include test evidence.",
        skillRefs: ["software.calc-cli", "software.test-evidence"],
        mcpGrantRefs: ["filesystem-workspace"],
        toolGrantRefs: ["tool.workspace-write", "tool.shell-read"],
        vaultLeasePolicyRefs: ["vault.github-write-token"],
        nodePromptSpec: {
          nodeType: "implement",
          goal: "Implement calc sum with tests",
          requirements: ["Update the implementation"],
          boundaries: ["No unrelated refactors"],
          nonGoals: [],
          deliverableDocuments: [],
          expectedOutputs: ["Passing test evidence"],
          testCases: [],
          acceptanceCriteria: ["The calc sum behavior works"],
        },
      },
    });

    assert.equal(result.draftId, draft.draftId);
    assert.equal(result.taskId, "implement-feature");
    assert.equal(result.status, "needs_validation");
    assert.deepEqual(result.profileOverride.skillRefs, ["software.calc-cli", "software.test-evidence"]);

    const row = await db.one<{
      status: string;
      summary_json: { status?: string };
      payload_json: { workflow: { tasks: Array<Record<string, any>> } };
    }>(
      "select status, summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(row.status, "needs_validation");
    assert.equal(row.summary_json.status, "needs_validation");
    const implement = row.payload_json.workflow.tasks.find((task) => task.id === "implement-feature");
    const verify = row.payload_json.workflow.tasks.find((task) => task.id === "verify-feature");
    assert.equal(implement?.profileOverride.model, "gpt-5-codex");
    assert.deepEqual(implement?.skillRefs, ["software.calc-cli", "software.test-evidence"]);
    assert.deepEqual(implement?.mcpGrantRefs, ["filesystem-workspace"]);
    assert.deepEqual(implement?.toolGrantRefs, ["tool.workspace-write", "tool.shell-read"]);
    assert.deepEqual(implement?.vaultLeasePolicyRefs, ["vault.github-write-token"]);
    assert.equal(implement?.promptInputs?.nodePromptSpec?.goal, "Implement calc sum with tests");
    assert.equal(verify?.profileOverride, undefined);
  });
});

test("Postgres planner draft validation gates run creation after profile override", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement calc sum");

    await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: {
        provider: "codex",
        model: "gpt-5-codex",
        instruction: "Use a tight patch and include validation evidence.",
        skillRefs: ["software.calc-cli"],
        mcpGrantRefs: ["filesystem-workspace"],
      },
    });

    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /planner draft is not validated/,
    );

    const validated = await validatePostgresPlannerDraft(db, { draftId: draft.draftId });
    assert.equal(validated.status, "validated");
    assert.deepEqual(validated.validationIssues, []);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.match(run.runId, /^run-wf-composed-/);
  });
});

test("Postgres run from draft materializes task profile override into run manifest and task snapshot", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement calc sum");

    await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: {
        harnessRef: "codex",
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Prefer the smallest verified patch and cite command evidence.",
        skillRefs: ["software.calc-cli", "skill.software-verification"],
        mcpGrantRefs: ["filesystem-workspace"],
        toolGrantRefs: ["tool.workspace-write"],
        vaultLeasePolicyRefs: ["vault.github-write-token"],
        nodePromptSpec: {
          nodeType: "implement",
          goal: "Implement calc sum with command evidence",
          requirements: ["Keep the patch small"],
          boundaries: ["No unrelated files"],
          nonGoals: [],
          deliverableDocuments: [],
          expectedOutputs: ["Test command output"],
          testCases: [],
          acceptanceCriteria: ["Evidence is cited"],
        },
      },
    });

    const validated = await validatePostgresPlannerDraft(db, { draftId: draft.draftId });
    assert.equal(validated.status, "validated");

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const runRow = await db.one<{
      workflow_manifest_json: {
        tasks: Array<Record<string, any>>;
        agentProfiles: Array<Record<string, any>>;
      };
    }>("select workflow_manifest_json from southstar.workflow_runs where id = $1", [run.runId]);
    const implementTask = runRow.workflow_manifest_json.tasks.find((task) => task.id === "implement-feature");
    assert.equal(implementTask?.agentProfileRef, "profile.generated.software-implement-feature__implement-feature__override");
    assert.deepEqual(implementTask?.skillRefs, ["software.calc-cli", "skill.software-verification"]);
    assert.deepEqual(implementTask?.mcpGrantRefs, ["filesystem-workspace"]);
    assert.deepEqual(implementTask?.toolGrantRefs, ["tool.workspace-write"]);
    assert.deepEqual(implementTask?.vaultLeasePolicyRefs, ["vault.github-write-token"]);
    assert.equal(implementTask?.promptInputs?.nodePromptSpec?.goal, "Implement calc sum with command evidence");
    assert.equal(implementTask?.profileOverride?.model, "gpt-5-codex");

    const overriddenProfile = runRow.workflow_manifest_json.agentProfiles.find((profile) =>
      profile.id === "profile.generated.software-implement-feature__implement-feature__override"
    );
    assert.equal(overriddenProfile?.harnessRef, "codex");
    assert.equal(overriddenProfile?.provider, "codex");
    assert.equal(overriddenProfile?.model, "gpt-5-codex");
    assert.equal(overriddenProfile?.thinkingLevel, "high");
    assert.deepEqual(overriddenProfile?.skillRefs, ["software.calc-cli", "skill.software-verification"]);
    assert.deepEqual(overriddenProfile?.mcpGrantRefs, ["filesystem-workspace"]);
    assert.deepEqual(overriddenProfile?.toolPolicy.allowedTools, ["tool.workspace-write"]);
    assert.deepEqual(overriddenProfile?.vaultLeasePolicyRefs, ["vault.github-write-token"]);

    const taskRow = await db.one<{ snapshot_json: Record<string, any> }>(
      "select snapshot_json from southstar.workflow_tasks where run_id = $1 and id = 'implement-feature'",
      [run.runId],
    );
    assert.equal(taskRow.snapshot_json.agentProfileRef, "profile.generated.software-implement-feature__implement-feature__override");
    assert.equal(taskRow.snapshot_json.profileOverride.model, "gpt-5-codex");

    const prebuiltContextCount = await db.one<{ count: string }>(
      "select count(*)::text as count from southstar.runtime_resources where resource_type in ('context_packet', 'task_envelope') and run_id = $1 and task_id = 'implement-feature'",
      [run.runId],
    );
    assert.equal(prebuiltContextCount.count, "0");
  });
});

test("Postgres run API supports llm-constrained planner drafts and preserves task creation order", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract("implement calc sum")),
      composer: new DeterministicFixtureComposer(),
    });
    assert.match(draft.draftId, /^draft-wf-composed-/);
    assert.equal(draft.status, "validated");
    assert.deepEqual(draft.validationIssues, []);
    assert.deepEqual(draft.taskSummaries.map((task) => task.taskId), [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);

    const draftResource = await db.one<{
      summary_json: { planner?: string };
      payload_json: { orchestrationSnapshot?: { validation?: { ok?: boolean } } };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.summary_json.planner, "library-constrained-llm");
    assert.equal(draftResource.payload_json.orchestrationSnapshot?.validation?.ok, true);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.deepEqual(run.taskIds, [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);
  });
});

test("llm-constrained planner drafts fail closed when llm composer is not configured", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    await assert.rejects(
      () => createCanonicalPlannerDraftFixture(db, {
        goalPrompt: "implement calc sum",
        orchestrationMode: "llm-constrained",
        goalInterpreter: fixedGoalInterpreter(softwareGoalContract("implement calc sum")),
      }),
      /LLM workflow composer is not configured/,
    );
  });
});

test("planner draft creates from an existing composition without calling an LLM composer", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const goalContract = softwareGoalContract("reuse visible DAG");
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: "reuse visible DAG",
      orchestrationMode: "llm-constrained",
      goalInterpreter: fixedGoalInterpreter(goalContract),
      compositionPlan: deterministicFixtureComposition(goalContract),
    });

    assert.equal(draft.status, "validated");
    assert.equal(draft.taskSummaries[0]?.taskId, "understand-repo");

    const draftResource = await db.one<{
      summary_json: { planner?: string };
      payload_json: {
        plannerTrace?: {
          composerMode?: string;
        };
        orchestrationSnapshot?: {
          selectedCompositionPlan?: { title?: string };
        };
        goalRequirementCoverage?: { goalContractHash?: string };
      };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.summary_json.planner, "existing-composition-compiler");
    assert.equal(draftResource.payload_json.plannerTrace?.composerMode, "existing-composition");
    assert.equal(draftResource.payload_json.orchestrationSnapshot?.selectedCompositionPlan?.title, "Software Dynamic Feature Workflow");
    assert.equal(draftResource.payload_json.goalRequirementCoverage?.goalContractHash, goalContractHash(goalContract));
  });
});

test("planner draft validation marks a persisted summary task missing requirementIds for regeneration", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "validate strict persisted composition");
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.ok(stored);
    const payload = structuredClone(stored.payload) as Record<string, any>;
    const goalContract = payload.goalContract as GoalContractV1;
    payload.candidatePacket = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpecFromGoalContract(goalContract),
      scope: goalContract.domain,
    });
    const selectedPlan = payload.orchestrationSnapshot.selectedCompositionPlan as WorkflowCompositionPlan;
    const summaryTask = selectedPlan.tasks.find((task) => task.id === "summarize-completion") as unknown as Record<string, unknown>;
    delete summaryTask.requirementIds;
    await upsertRuntimeResourcePg(db, {
      id: stored.id,
      resourceType: "planner_draft",
      resourceKey: draft.draftId,
      scope: stored.scope,
      status: "needs_validation",
      ...(stored.title ? { title: stored.title } : {}),
      payload,
      summary: stored.summary,
      metrics: stored.metrics,
    });

    const validated = await validatePostgresPlannerDraft(db, { draftId: draft.draftId });

    assert.equal(validated.status, "invalid");
    const issue = validated.validationIssues.find((item) => item.code === "composition_needs_regeneration");
    assert.ok(issue);
    assert.match(issue.message, /persisted workflow composition needs regeneration/i);
    assert.match(issue.message, /requirementIds/);
    assert.doesNotMatch(issue.message, /Cannot read properties|\.includes/);
  });
});

test("llm-constrained planner trace records analyzer/composer and validation audit metadata", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract("implement calc sum")),
      composer: new DeterministicFixtureComposer(),
    });
    const draftResource = await db.one<{
      payload_json: {
        plannerTrace: {
          analyzerType?: string;
          composerMode?: string;
          validatorAttempts?: number;
          repairAttempts?: number;
          finalValidationOk?: boolean;
          candidatePacketHash?: string;
          compositionHash?: string;
        };
        orchestrationSnapshot: {
          candidatePacketHash: string;
          selectedCompositionPlan: unknown;
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    const trace = draftResource.payload_json.plannerTrace;
    assert.equal(trace.analyzerType, "goal-contract-v1");
    assert.equal(trace.composerMode, "llm");
    assert.equal(trace.validatorAttempts, 1);
    assert.equal(trace.repairAttempts, 0);
    assert.equal(trace.finalValidationOk, true);
    assert.match(trace.candidatePacketHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(trace.compositionHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(trace.candidatePacketHash, draftResource.payload_json.orchestrationSnapshot.candidatePacketHash);
    assert.notEqual(trace.compositionHash, "");
  });
});

test("llm-constrained planner does not fallback when primary composer fails", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const failingComposer = {
      async compose() {
        throw new Error("forced llm composer failure");
      },
    };
    await assert.rejects(
      () => createCanonicalPlannerDraftFixture(db, {
        goalPrompt: "implement calc sum",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
        goalInterpreter: fixedGoalInterpreter(softwareGoalContract("implement calc sum")),
        composer: failingComposer,
      }),
      /forced llm composer failure/,
    );
  });
});

test("llm-constrained planner passes requested cwd to workflow composer", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    let composerCwd: string | undefined;
    const composer = {
      async compose(input: { cwd?: string; goalContract: GoalContractV1 }): Promise<WorkflowCompositionPlan> {
        composerCwd = input.cwd;
        return deterministicFixtureComposition(input.goalContract);
      },
    };

    await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: "implement vocab challenge",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      cwd: "/home/timmypai/apps/southstar-vocab",
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract("implement vocab challenge")),
      composer,
    });

    assert.equal(composerCwd, "/home/timmypai/apps/southstar-vocab");
  });
});

test("Postgres planner draft can use injected scripted LLM composer for non-fixture DAG shape", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const goalContract = softwareGoalContract("implement calc sum with a single exploration task");
    const composer = new ScriptedWorkflowComposer([
      deterministicFixtureComposition(goalContract),
    ]);
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: "implement calc sum with a single exploration task",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer,
    });
    const draftResource = await db.one<{ payload_json: { repairAttempts: Array<{ validation: { ok: boolean } }> } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.payload_json.repairAttempts.length, 1);
    assert.equal(draftResource.payload_json.repairAttempts[0]?.validation.ok, true);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.deepEqual(run.taskIds, [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);
  });
});

test("llm-constrained planner uses graph metadata even when legacy capability candidates are unavailable", async () => {
  await withDb(async (db) => {
    await seedGraphMetadataOnlyWorkflowPrimitives(db);
    const goalContract = softwareGoalContract("build a vocabulary learning feature");
    const composer = new ScriptedWorkflowComposer([graphMetadataOnlyPlan(goalContract)]);

    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: "build a vocabulary learning feature",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer,
    });

    assert.equal(draft.status, "validated", JSON.stringify(draft.validationIssues));
    assert.deepEqual(draft.validationIssues, []);
    assert.deepEqual(draft.taskSummaries.map((task) => task.taskId), ["implement-vocab", "verify-vocab"]);

    const draftResource = await db.one<{
      payload_json: {
        orchestrationSnapshot?: {
          candidateSummary?: { agentDefinitionRefs?: string[] };
          compiler?: { libraryVersionRefs?: string[] };
          selectedCompositionPlan?: { tasks?: Array<{ agentProfileRef?: string }> };
        };
        workflow?: {
          roles?: Array<{ id?: string; defaultAgentProfileRef?: string }>;
          agentProfiles?: Array<{
            id?: string;
            provider?: string;
            model?: string;
            thinkingLevel?: string;
            instruction?: string;
            harnessRef?: string;
            toolPolicy?: { allowedTools?: string[] };
          }>;
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.deepEqual(draftResource.payload_json.orchestrationSnapshot?.candidateSummary?.agentDefinitionRefs, ["agent.frontend-developer"]);
    assert.equal(
      draftResource.payload_json.workflow?.roles?.[0]?.defaultAgentProfileRef,
      "profile.generated.vocab.implement",
    );
    const generatedProfile = draftResource.payload_json.workflow?.agentProfiles?.find((profile) =>
      profile.id === "profile.generated.vocab.implement"
    );
    assert.equal(generatedProfile?.provider, "pi");
    assert.equal(generatedProfile?.model, "pi-agent-default");
    assert.equal(generatedProfile?.thinkingLevel, "high");
    assert.equal(generatedProfile?.harnessRef, "pi");
    assert.match(generatedProfile?.instruction ?? "", /vocabulary learning feature/);
    assert.deepEqual(generatedProfile?.toolPolicy?.allowedTools, ["tool.workspace-write"]);
    assert.equal(
      draftResource.payload_json.orchestrationSnapshot?.compiler?.libraryVersionRefs?.includes("agent.frontend-developer@1"),
      true,
    );
    assert.equal(
      draftResource.payload_json.orchestrationSnapshot?.selectedCompositionPlan?.tasks?.[0]?.agentProfileRef,
      "profile.generated.vocab.implement",
    );
  });
});

test("Postgres planner draft is invalid when repair loop remains invalid after max attempts", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const goalContract = softwareGoalContract("implement calc sum with invalid explorer profile");
    const composer = new ScriptedWorkflowComposer([
      invalidInspectOnlyPlan(goalContract),
      deterministicFixtureComposition(goalContract),
    ]);
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: "implement calc sum with invalid explorer profile",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer,
    });
    assert.ok(draft.draftId.length > 0);
    assert.equal(draft.status, "invalid");
    assert.ok(draft.validationIssues.length > 0);
    assert.equal(draft.taskSummaries.length, 0);
    const draftResource = await db.one<{
      status: string;
      payload_json: { repairAttempts: Array<{ validation: { ok: boolean } }> };
    }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.status, "invalid");
    assert.equal(draftResource.payload_json.repairAttempts.length, 1);
    assert.equal(draftResource.payload_json.repairAttempts[0]?.validation.ok, false);
    assert.match(
      draftResource.payload_json.repairAttempts[0]?.repairBlockedReason ?? "",
      /non_repairable_library_or_runtime_gap/,
    );
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /planner draft is not validated/,
    );
  });
});

test("Postgres planner draft orchestration inspection helper returns public summary and orchestration snapshot", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createCanonicalPlannerDraftFixture(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract("implement calc sum")),
      composer: new DeterministicFixtureComposer(),
    });
    const inspection = await getPostgresPlannerDraftOrchestration(db, { draftId: draft.draftId });
    assert.equal(inspection.draftId, draft.draftId);
    assert.equal(inspection.status, "validated");
    assert.deepEqual(inspection.validationIssues, []);
    assert.equal(inspection.taskSummaries.length, 6);
    assert.equal(inspection.taskSummaries[0]?.taskId, "understand-repo");
    assert.equal(inspection.taskSummaries[0]?.harnessRef, "pi");
    assert.equal(inspection.taskSummaries[0]?.provider, "pi");
    assert.equal(inspection.taskSummaries[0]?.model, "pi-agent-default");
    assert.equal(inspection.orchestrationSnapshot?.validation.ok, true);
  });
});

test("Postgres run creation rejects invalid planner drafts", async () => {
  await withDb(async (db) => {
    const goalContract = softwareGoalContract("reject invalid planner draft");
    const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract);
    await upsertRuntimeResourcePg(db, {
      id: "draft-invalid-test",
      resourceType: "planner_draft",
      resourceKey: "draft-invalid-test",
      scope: "planner",
      status: "invalid",
      title: "Invalid Draft",
      payload: {
        goalContract,
        goalContractHash: goalContractHash(goalContract),
        goalDesignPackage,
        goalDesignPackageHash: goalDesignPackage.packageHash,
        workflow: { workflowId: "wf-invalid" },
      },
      summary: { planner: "library-constrained-llm" },
    });
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: "draft-invalid-test" }),
      /planner draft is not validated/,
    );
  });
});

test("Postgres run creation rejects validated drafts without an explicit Goal Contract", async () => {
  await withDb(async (db) => {
    const goalContract = softwareGoalContract("invent a requirement");
    const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract);
    await upsertRuntimeResourcePg(db, {
      id: "draft-without-goal-contract",
      resourceType: "planner_draft",
      resourceKey: "draft-without-goal-contract",
      scope: "planner",
      status: "validated",
      title: "Missing Goal Contract",
      payload: {
        goalDesignPackage,
        goalDesignPackageHash: goalDesignPackage.packageHash,
        workflow: {
          workflowId: "wf-missing-contract",
          goalPrompt: "invent a requirement",
          domain: "general",
          tasks: [],
        },
        requirementSpec: { summary: "invent a requirement", acceptanceCriteria: [] },
      },
      summary: { goalPrompt: "invent a requirement" },
    });
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: "draft-without-goal-contract" }),
      /planner draft Goal Contract is missing/,
    );
  });
});

test("run-goal returns a Requirement review without materializing a run", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-run-goal-needs-input-"));
    await mkdir(join(libraryRoot, "skills"), { recursive: true });
    await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.southstar-goal-design", "goal_design"));
    await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.southstar-composer-guidance", "composer_guidance"));
    await reconcileLibraryFilesPg(db, { root: libraryRoot, trigger: "startup" });
    const goalContract = {
      ...articleGoalContract("Publish my article"),
      blockingInputs: ["Which source file should be used?"],
    };
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner client not used by blocking run-goal"); } },
      goalInterpreter: fixedGoalInterpreter(goalContract),
      goalRequirementInterpreter: requirementDraftInterpreter(goalContract.originalPrompt, process.cwd()),
      workflowComposer: new DeterministicFixtureComposer(),
      libraryRoot,
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by blocking run-goal"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const result = await api<{
        draftStatus: string;
        blockers: string[];
        confirmable?: boolean;
        runId?: string;
      }>(server.url, "/api/v2/run-goal", {
        method: "POST",
        body: JSON.stringify({
          goalPrompt: goalContract.originalPrompt,
          cwd: process.cwd(),
          idempotencyKey: "goal-needs-input-route-1",
        }),
      });
      assert.equal(result.draftStatus, "requirements_review");
      assert.equal(result.confirmable, true);
      assert.deepEqual(result.blockers, []);
      assert.equal(result.runId, undefined);
    } finally {
      await server.close();
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("Postgres planner draft snapshots structured request before async orchestration work", async () => {
  await withDb(async (db) => {
    const request = {
      goalPrompt: "implement calc sum with snapshot boundary",
      orchestrationMode: "llm-constrained" as const,
      composerMode: "llm" as const,
      cwd: "/workspace/original",
      libraryHints: {
        roleRefs: ["agent.software-maker"],
        agentProfileRefs: ["profile.software-maker-pi"],
        skillRefs: ["skill.software-implementation"],
        mcpGrantRefs: ["mcp.filesystem-workspace"],
        toolRefs: ["tool.workspace-read"],
        modelHints: { maker: "gpt-5" },
        vaultLeasePolicyRefs: ["vault.github-write-token"],
        toolPolicyHints: {
          allowedTools: ["read", "search"],
          deniedTools: ["write"],
          requiresApprovalFor: ["network"],
        },
      },
    };
    const goalContract = softwareGoalContract(request.goalPrompt);
    const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract);
    await seedCanonicalValidationEdges(db, goalDesignPackage);
    const expectedPlannerRequest = JSON.parse(JSON.stringify({
      ...request,
      goalRequirementDraftHash: goalDesignPackage.requirementDraftHash,
    }));
    const draftPromise = createCanonicalPlannerDraftFixture(db, {
      ...request,
      goalInterpreter: fixedGoalInterpreter(goalContract),
      goalDesignPackage,
      composer: new DeterministicFixtureComposer(),
    });

    request.cwd = "/workspace/mutated";
    request.libraryHints.roleRefs.push("agent.mutated");
    request.libraryHints.agentProfileRefs.push("profile.mutated");
    request.libraryHints.modelHints.maker = "mutated-model";
    request.libraryHints.toolPolicyHints.allowedTools.push("write");

    const draft = await draftPromise;
    const row = await db.one<{
      summary_json: { plannerRequest?: unknown };
      payload_json: { plannerRequest?: unknown };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.deepEqual(row.summary_json.plannerRequest, expectedPlannerRequest);
    assert.deepEqual(row.payload_json.plannerRequest, expectedPlannerRequest);
  });
});

async function api<T>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await fixture.drop();
  }
}

async function createFixturePlannerDraft(db: SouthstarDb, goalPrompt: string) {
  await seedDeterministicWorkflowGraph(db);
  return await createCanonicalPlannerDraftFixture(db, {
    goalPrompt,
    orchestrationMode: "llm-constrained",
    composerMode: "llm",
    goalInterpreter: fixedGoalInterpreter(softwareGoalContract(goalPrompt)),
    composer: new DeterministicFixtureComposer(),
  });
}

async function stripGoalContractFromDraft(
  db: SouthstarDb,
  draftId: string,
  options: { missingInputs?: string[]; staleGoalContractHash?: string } = {},
): Promise<void> {
  const draft = await getResourceByKeyPg(db, "planner_draft", draftId);
  assert.ok(draft);
  const payload = structuredClone(draft.payload) as Record<string, unknown>;
  const summary = structuredClone(draft.summary) as Record<string, unknown>;
  delete payload.goalContract;
  delete payload.goalContractHash;
  delete summary.goalContractHash;
  delete summary.domain;
  delete summary.intent;
  delete summary.blockers;
  delete summary.requirementCount;
  if (options.missingInputs) {
    const orchestrationSnapshot = payload.orchestrationSnapshot as Record<string, any>;
    orchestrationSnapshot.requirementSpec = {
      ...orchestrationSnapshot.requirementSpec,
      missingInputs: [...options.missingInputs],
    };
  }
  if (options.staleGoalContractHash) {
    payload.goalContractHash = options.staleGoalContractHash;
    summary.goalContractHash = options.staleGoalContractHash;
  }
  await upsertRuntimeResourcePg(db, {
    id: draft.id,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: draft.scope,
    status: draft.status,
    ...(draft.title ? { title: draft.title } : {}),
    payload,
    summary,
    metrics: draft.metrics,
  });
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = resolveTestPostgresAdminUrl();
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function articleGoalContract(goalPrompt: string): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt,
    cwd: "/workspace/article",
    interpretation: {
      domain: "design/article",
      intent: "publish_article",
      workType: "general",
      summary: "Create an offline HTML article from the supplied notes",
      requirements: [{
        statement: "Create a readable offline HTML article from notes.md",
        acceptanceCriteria: [{
          observableClaim: "The article opens offline as a single HTML file",
          blocking: true,
          verificationIntent: ["Open the article without network access and inspect its content."],
          requiredAssurance: ["browser_interaction"],
        }],
        blocking: true,
        source: "explicit",
        expectedArtifacts: [],
      }],
      expectedArtifactRefs: ["artifact.completion_report"],
      requiredCapabilities: ["capability.repo-read"],
      nonGoals: [],
      assumptions: ["notes.md exists in the workspace"],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}

async function seedGoalDesignSkill(db: SouthstarDb): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey: "skill.southstar-goal-design",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.southstar-goal-design@test",
    state: {
      purpose: "goal_design",
      body: "Design the smallest cohesive outcome slices and return the host schema.",
    },
  });
}

async function seedGoalRequirementVocabulary(db: SouthstarDb): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey: "domain.design-article",
    objectKind: "domain_taxonomy",
    status: "approved",
    headVersionId: "domain.design-article@goal-requirement-test",
    state: { scope: "design/article" },
  });
}

function requirementDraftInterpreter(goalPrompt: string, cwd: string, projectRef?: string) {
  return {
    async interpret() {
      return finalizeGoalRequirementDraft(validGoalRequirementDraftInput(goalPrompt, cwd, projectRef));
    },
    async revise() {
      throw new Error("revision not used in creation test");
    },
  };
}

function atomicCriterion(observableClaim: string) {
  return {
    observableClaim,
    blocking: true,
    verificationIntent: ["Verify the observable claim against the accepted artifact."],
    requiredAssurance: ["browser_interaction" as const],
    evidenceIntent: ["screenshot" as const],
  };
}

function validGoalRequirementDraftInput(goalPrompt: string, cwd: string, projectRef?: string): GoalRequirementDraftInputV1 {
  return {
    goalPrompt,
    cwd,
    ...(projectRef !== undefined ? { projectRef } : {}),
    summary: "Create and verify the requested offline article.",
    requirements: [{
      title: "Offline article",
      statement: "Create a readable article that opens without a network connection.",
      source: "explicit",
      blocking: true,
      userVisibleBehaviors: ["The article opens from a local file."],
      businessRules: [],
      acceptanceCriteria: [atomicCriterion("The article opens offline as a single HTML file.")],
      expectedOutcomeArtifacts: [{ description: "Offline article", mediaType: "text/html" }],
      verificationIntent: ["Open the generated file in a browser without network access."],
      assumptions: [],
      openQuestions: [],
      riskTags: [],
      interactionContractRefs: [],
    }],
    nonGoals: [],
    blockingInputs: [],
  };
}

function visualRequirementDraft(goalPrompt: string, cwd: string) {
  return finalizeGoalRequirementDraft({
    goalPrompt,
    cwd,
    summary: "Review a card and reveal its answer.",
    requirements: [{
      title: "Review card",
      statement: "A learner can reveal the answer for a card.",
      source: "explicit",
      blocking: true,
      userVisibleBehaviors: ["The answer is hidden until requested."],
      businessRules: [],
      acceptanceCriteria: [atomicCriterion("Reveal changes question to answer state.")],
      expectedOutcomeArtifacts: [{ description: "Review interaction" }],
      verificationIntent: ["Exercise reveal."],
      assumptions: [],
      openQuestions: [],
      riskTags: [],
      interactionContractRefs: ["ui-review"],
    }],
    nonGoals: [],
    blockingInputs: [],
  });
}

function multiVisualRequirementDraft(goalPrompt: string, cwd: string) {
  return finalizeGoalRequirementDraft({
    goalPrompt,
    cwd,
    summary: "Review two cards and reveal their answers.",
    requirements: [
      {
        title: "First review card",
        statement: "A learner can reveal the answer for the first card.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["The first answer is hidden until requested."],
        businessRules: [],
        acceptanceCriteria: [atomicCriterion("Reveal changes the first question to its answer state.")],
        expectedOutcomeArtifacts: [{ description: "First review interaction" }],
        verificationIntent: ["Exercise the first reveal."],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: ["ui-review-first"],
      },
      {
        title: "Second review card",
        statement: "A learner can reveal the answer for the second card.",
        source: "explicit",
        blocking: true,
        userVisibleBehaviors: ["The second answer is hidden until requested."],
        businessRules: [],
        acceptanceCriteria: [atomicCriterion("Reveal changes the second question to its answer state.")],
        expectedOutcomeArtifacts: [{ description: "Second review interaction" }],
        verificationIntent: ["Exercise the second reveal."],
        assumptions: [],
        openQuestions: [],
        riskTags: [],
        interactionContractRefs: ["ui-review-second"],
      },
    ],
    nonGoals: [],
    blockingInputs: [],
  });
}

function visualContractInput(requirementId: string, criterionId: string) {
  return {
    requirementIds: [requirementId],
    screens: [{
      id: "screen-review",
      title: "Review",
      purpose: "Review one card",
      layout: { regions: [{ id: "region-main", role: "main" as const, position: "center" as const, childRefs: ["element-reveal"] }] },
      elements: [{ id: "element-reveal", type: "button" as const, label: "Reveal", visibleInStates: ["question"], enabledInStates: ["question"] }],
      states: ["question", "answer"],
      actions: [{ id: "action-reveal", triggerElementId: "element-reveal", fromState: "question", toState: "answer", expectedEffect: "Show answer" }],
      responsiveRules: ["Action remains visible on narrow screens."],
      accessibilityRules: ["Action has a button role."],
    }],
    flows: [{ id: "flow-review", steps: ["action-reveal"], successOutcome: "Answer is visible" }],
    criterionBindings: [{ criterionId, screenIds: ["screen-review"], elementIds: ["element-reveal"], actionIds: ["action-reveal"] }],
  };
}

function inlineArticleSliceDesigner(): GoalSliceDesigner {
  return {
    async design(input) {
      const binding = input.validationBindings[0]!;
      return finalizeGoalDesignPackageV3({
        schemaVersion: "southstar.goal_design_package.v3",
        revision: 1,
        goalContract: input.goalContract,
        requirementDraftHash: input.requirementDraft.draftHash,
        validationBindings: input.validationBindings,
        slicePlan: {
          schemaVersion: "southstar.goal_slice_plan.v1",
          goalContractHash: "host-filled",
          revision: 1,
          slices: [{
            id: "slice-offline-document",
            requirementIds: [binding.requirementId],
            outcome: "Produce and verify the requested offline document",
            stateOrArtifactOwner: binding.criterionBindings[0]!.artifactContractRef,
            mutationBoundary: "the requested offline document artifact",
            expectedArtifactRefs: binding.criterionBindings.map((criterionBinding) => criterionBinding.artifactContractRef),
            evaluatorContractRefs: [binding.id],
            dependsOnSliceIds: [],
            dependencyArtifactRefs: [],
          }],
        },
        compositionStrategy: { mode: "single-run", sliceIds: ["slice-offline-document"], rationale: "one cohesive artifact boundary" },
        templatePolicy: input.templatePolicy,
        goalDesignSkillRef: input.skill.objectKey,
        goalDesignSkillVersionRef: input.skill.versionRef,
        workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
        mode: input.mode,
      });
    },
    async revise(input) {
      return {
        kind: "revision",
        slicePlan: { slices: input.currentPackage.slicePlan.slices },
        compositionStrategy: input.currentPackage.compositionStrategy,
        summary: "unchanged",
        changedSliceIds: [],
      };
    },
  };
}

function inlineArticleComposition(
  goalContract: GoalContractV1,
  sliceId: string,
  artifactRef = "artifact.offline-document",
  evaluatorRef = "evaluator.offline-document",
): WorkflowCompositionPlan {
  const requirementIds = goalContract.requirements.map((requirement) => requirement.id);
  const task = (
    id: string,
    nodeType: "implement" | "verify",
    dependsOn: string[],
    inputArtifactRefs: string[],
    outputArtifactRefs: string[],
  ) => ({
    id,
    name: nodeType === "implement" ? "Produce Offline Document" : "Verify Offline Document",
    responsibility: nodeType === "implement" ? "Produce the confirmed offline document outcome." : "Independently verify every confirmed criterion.",
    requirementIds,
    sliceId,
    nodePromptSpec: {
      nodeType,
      goal: nodeType === "implement" ? "Produce the offline document." : "Verify the offline document against frozen criteria.",
      requirements: ["Satisfy the linked confirmed requirement."],
      boundaries: ["Stay within the declared artifact boundary."],
      nonGoals: ["Do not introduce unrelated product behavior."],
      deliverableDocuments: [],
      expectedOutputs: outputArtifactRefs,
      testCases: [],
      acceptanceCriteria: goalContract.requirements[0]!.acceptanceCriteria.map((criterion) => criterion.observableClaim),
      ...(nodeType === "implement" ? { implementationScope: ["Produce only the linked outcome artifact."] } : { verificationChecks: ["Evaluate every frozen criterion with accepted evidence."] }),
    },
    dependsOn,
    templateSlotRef: nodeType,
    agentDefinitionRef: "agent.document-worker",
    agentProfileRef: "profile.generated.document-worker",
    instructionRefs: [],
    skillRefs: [],
    toolGrantRefs: [],
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
    inputArtifactRefs,
    outputArtifactRefs,
    evaluatorProfileRef: evaluatorRef,
    recoveryStrategyRefs: [],
    rationale: `${nodeType} the frozen slice with approved validation contracts.`,
  });
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Offline Document Delivery",
    selectedWorkflowTemplateRef: "template.document-delivery",
    rationale: "One producer followed by an independent criterion evaluator.",
    tasks: [
      task("produce-document", "implement", [], [], [artifactRef]),
      task("verify-document", "verify", ["produce-document"], [artifactRef], []),
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [{
      id: "profile.generated.document-worker",
      kind: "agent_profile",
      risk: "medium",
      reason: "Compose a worker profile from the approved task primitives.",
      validationStatus: "validated",
      agentProfile: {
        workerKind: "execution_worker",
        provider: "pi",
        model: "pi-agent-default",
        thinkingLevel: "high",
        harnessRef: "pi",
        instruction: "Produce or independently verify the declared document artifact according to the node prompt contract.",
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

async function seedInlineArticleValidationAndCompositionGraph(db: SouthstarDb): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey: "template.document-delivery",
    objectKind: "workflow_template",
    status: "approved",
    headVersionId: "template.document-delivery@1",
    state: { scope: "design/article", title: "Document delivery" },
  });
  await upsertLibraryObject(db, {
    objectKey: "agent.document-worker",
    objectKind: "agent_definition",
    status: "approved",
    headVersionId: "agent.document-worker@1",
    state: {
      scope: "design/article",
      title: "Document worker",
      runtimeRole: {
        id: "document-worker",
        responsibility: "Produce and independently verify the declared document artifact.",
        defaultAgentProfileRef: "profile.generated.document-worker",
        allowedAgentProfileRefs: ["profile.generated.document-worker"],
        artifactInputs: ["artifact.offline-document"],
        artifactOutputs: ["artifact.offline-document"],
        stopAuthority: "can-suggest",
      },
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "artifact.offline-document",
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId: "artifact.offline-document@1",
    state: {
      scope: "design/article",
      title: "Offline document",
      artifactType: "offline_document",
      mediaTypes: ["text/html"],
      evidenceFields: ["content"],
      evidenceKinds: ["screenshot"],
      validationRules: ["The document opens without a network connection."],
      schemaRef: "schema.offline-document.v1",
      requiredFields: ["content"],
      provenanceRequirements: ["workspace-artifact"],
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "evaluator.offline-document",
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId: "evaluator.offline-document@1",
    state: {
      scope: "design/article",
      title: "Offline document evaluator",
      validatesArtifactRefs: ["artifact.offline-document"],
      requiredInputs: ["accepted-artifact"],
      evidenceKinds: ["screenshot"],
      evaluators: [{ id: "offline-document-schema", kind: "schema", config: {}, required: true }],
      onFailure: { defaultStrategy: "request-workflow-revision" },
      verificationModes: ["browser_interaction"],
      verificationProcedures: [{
        id: "procedure.open-offline",
        checkKind: "browser_interaction",
        instruction: "Open the accepted document without network access and capture the rendered result.",
        allowedEvidenceKinds: ["screenshot"],
      }],
      independencePolicy: "independent",
      resultSchemaRef: "southstar.requirement_evaluator_result.v2",
      failureClassifications: ["offline_open_failed"],
    },
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "evaluator.offline-document",
    fromVersionRef: "evaluator.offline-document@1",
    edgeType: "validates_artifact",
    toObjectKey: "artifact.offline-document",
    toVersionRef: "artifact.offline-document@1",
    scope: "design/article",
  });
}

async function seedOfflineHtmlValidationObjects(db: SouthstarDb): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey: "artifact.offline-html",
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId: "artifact.offline-html@1",
    state: {
      scope: "design/article",
      title: "Offline HTML",
      artifactType: "offline_html",
      requiredFields: ["content"],
      evidenceFields: ["content"],
      mediaTypes: ["text/html"],
      validationRules: ["The HTML opens without a network connection."],
      evidenceKinds: ["screenshot"],
      schemaRef: "schema.offline-html.v1",
      provenanceRequirements: ["workspace-artifact"],
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "evaluator.offline-html",
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId: "evaluator.offline-html@1",
    state: {
      scope: "design/article",
      title: "Offline HTML evaluator",
      requiredInputs: ["accepted-artifact"],
      evidenceKinds: ["screenshot"],
      evaluators: [{ id: "offline-html-schema", kind: "schema", config: {}, required: true }],
      onFailure: { defaultStrategy: "request-workflow-revision" },
      verificationModes: ["browser_interaction"],
      verificationProcedures: [{
        id: "procedure.offline-open",
        checkKind: "browser_interaction",
        instruction: "Open the HTML without network access and capture the rendered result.",
        allowedEvidenceKinds: ["screenshot"],
      }],
      independencePolicy: "independent",
      resultSchemaRef: "southstar.requirement_evaluator_result.v2",
      failureClassifications: ["offline_open_failed"],
    },
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "evaluator.offline-html",
    edgeType: "validates_artifact",
    toObjectKey: "artifact.offline-html",
    scope: "design/article",
  });
}

async function createConfirmedGoalRequirementDraft(
  db: SouthstarDb,
  goalPrompt: string,
  cwd = process.cwd(),
) {
  await seedGoalDesignSkill(db);
  await seedGoalRequirementVocabulary(db);
  const draft = await preparePostgresGoalRequirementDraft(db, {
    goalPrompt,
    cwd,
    requirementInterpreter: requirementDraftInterpreter(goalPrompt, cwd),
  });
  const confirmed = await confirmGoalRequirementsPg(db, {
    draftId: draft.draftId,
    expectedDraftHash: draft.goalRequirementDraftHash,
    goalContractMetadata: {
      domain: "design/article",
      intent: "publish_article",
      workType: "general",
      expectedArtifactRefs: [],
      requiredCapabilities: [],
      assumptions: [],
      requestedSideEffects: [],
    },
  });
  assert.ok(confirmed.goalContract);
  assert.ok(confirmed.goalContractHash);
  return {
    draftId: draft.draftId,
    goalRequirementDraft: draft.goalRequirementDraft,
    goalRequirementDraftHash: draft.goalRequirementDraftHash,
    goalContract: confirmed.goalContract,
    goalContractHash: confirmed.goalContractHash,
  };
}

function validationResolution(
  goal: Awaited<ReturnType<typeof createConfirmedGoalRequirementDraft>>,
  ready: boolean,
): GoalValidationResolutionV2 {
  const requirement = goal.goalContract.requirements[0]!;
  const criterionIds = goal.goalRequirementDraft.requirements[0]!.acceptanceCriteria.map((criterion) => criterion.id);
  const withoutHash: Omit<GoalValidationResolutionV2, "resolutionHash"> = ready
    ? {
      schemaVersion: "southstar.goal_validation_resolution.v2",
      goalContractHash: goal.goalContractHash,
      requirementDraftHash: goal.goalRequirementDraftHash,
      previews: [{
        schemaVersion: "southstar.requirement_coverage_preview.v1",
        requirementId: requirement.id,
        blocking: true,
        status: "ready",
        artifactCandidates: [{ ref: "artifact.offline-html", versionRef: "artifact.offline-html@1", reason: "installed candidate" }],
        evaluatorCandidates: [{ ref: "evaluator.offline-html", versionRef: "evaluator.offline-html@1", reason: "installed candidate" }],
        missingKinds: [],
        criterionIds,
        acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => criterion.observableClaim),
      }],
      bindings: [{
        schemaVersion: "southstar.requirement_validation_binding.v3",
        id: `binding-${requirement.id}`,
        requirementId: requirement.id,
        criterionBindings: requirement.acceptanceCriteria.map((criterion, index) => {
          const draftCriterion = goal.goalRequirementDraft.requirements[0]!.acceptanceCriteria[index]!;
          return {
            criterionContract: { ...criterion },
            artifactContractRef: "artifact.offline-html",
            artifactContractVersionRef: "artifact.offline-html@1",
            evaluatorProfileRef: "evaluator.offline-html",
            evaluatorProfileVersionRef: "evaluator.offline-html@1",
            verificationMode: draftCriterion.requiredAssurance[0]!,
            procedureRef: "procedure.offline-open",
            expectedEvidenceKinds: [...draftCriterion.evidenceIntent],
            independence: "independent" as const,
            failureClassifications: ["offline_open_failed"],
          };
        }),
      }],
      gaps: [],
      ready: true,
    }
    : {
      schemaVersion: "southstar.goal_validation_resolution.v2",
      goalContractHash: goal.goalContractHash,
      requirementDraftHash: goal.goalRequirementDraftHash,
      previews: [{
        schemaVersion: "southstar.requirement_coverage_preview.v1",
        requirementId: requirement.id,
        blocking: true,
        status: "missing",
        artifactCandidates: [],
        evaluatorCandidates: [],
        missingKinds: ["artifact", "evaluator"],
        criterionIds,
        acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => criterion.observableClaim),
      }],
      bindings: [],
      gaps: [{
        schemaVersion: "southstar.goal_validation_gap.v1",
        kind: "evaluator",
        requirementId: requirement.id,
        criterionIds,
        blocking: true,
        message: "No approved reusable evaluator covers the confirmed criteria",
        candidateRefs: [],
      }],
      ready: false,
    };
  return { ...withoutHash, resolutionHash: contentHashForPayload(withoutHash) };
}

function validationImportCandidates(prompt?: string) {
  const candidates = [{
      objectKey: "artifact.offline-html",
      kind: "artifact",
      title: "Offline HTML",
      scope: "design/article",
      artifactType: "offline_html",
      mediaTypes: ["text/html"],
      evidenceKinds: ["screenshot"],
      validationRules: ["rule.offline-html"],
      schemaRef: "schema.offline-html.v1",
      requiredFields: ["content"],
      provenanceRequirements: ["workspace-artifact"],
      selectedByDefault: true,
    }, {
      objectKey: "evaluator.offline-html",
      kind: "evaluator",
      title: "Offline HTML Evaluator",
      scope: "design/article",
      validatesArtifactRefs: ["artifact.offline-html"],
      requiredInputs: ["accepted-artifact"],
      evidenceKinds: ["screenshot"],
      verificationModes: ["browser_interaction"],
      verificationProcedures: [{
        id: "procedure.offline-open",
        checkKind: "browser_interaction",
        instruction: "Open the HTML artifact offline and capture the rendered result.",
        allowedEvidenceKinds: ["screenshot"],
      }],
      independencePolicy: "independent",
      resultSchemaRef: "southstar.requirement_evaluator_result.v2",
      failureClassifications: ["offline_open_failed"],
      selectedByDefault: true,
    }];
  const constraints = goalValidationCoverageConstraintsFromPrompt(prompt);
  return {
    candidates,
    ...(constraints.length > 0 ? {
      candidateCoverageTargets: constraints.flatMap((constraint) => candidates.map((candidate) => ({
        candidateObjectKey: candidate.objectKey,
        gapRef: constraint.gapRef,
        requirementId: constraint.requirementId,
        criterionIds: constraint.criterionIds,
      }))),
    } : {}),
  };
}

function goalValidationCoverageConstraintsFromPrompt(prompt: string | undefined): Array<{ gapRef: string; requirementId: string; criterionIds: string[] }> {
  if (!prompt) return [];
  const marker = "GoalValidationCoverageConstraints:\n";
  const start = prompt.indexOf(marker);
  if (start < 0) return [];
  const line = prompt.slice(start + marker.length).split("\n", 1)[0];
  if (!line) return [];
  const value = JSON.parse(line) as unknown;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { gapRef: string; requirementId: string; criterionIds: string[] } => Boolean(
    item && typeof item === "object" && !Array.isArray(item)
    && typeof (item as any).gapRef === "string"
    && typeof (item as any).requirementId === "string"
    && Array.isArray((item as any).criterionIds),
  ));
}

function realGoalValidationImportProvider(): LibraryImportLlmProvider {
  return async ({ prompt }) => {
    if (prompt.startsWith("Rank only the supplied approved artifact contracts")) {
      if (!prompt.includes('"ref":"artifact.offline-html"') || !prompt.includes('"ref":"evaluator.offline-html"')) {
        return { recommendations: [] };
      }
      return {
        recommendations: [{
          artifactRef: "artifact.offline-html",
          evaluatorRef: "evaluator.offline-html",
          verificationMode: "browser_interaction",
          procedureRef: "procedure.offline-open",
          expectedEvidenceKinds: ["screenshot"],
          reason: "The approved evaluator verifies the required offline HTML evidence.",
        }],
      };
    }
    if (prompt.startsWith("Generate ontology edges")) return { proposedEdges: [] };
    return validationImportCandidates(prompt);
  };
}

function approvedGoalValidationPurposeSkill(id: string, purpose: "goal_design" | "composer_guidance"): string {
  return `---\nschemaVersion: southstar.library.skill_spec_file.v1\nid: ${id}\ntitle: ${purpose}\nscope: software\nstatus: approved\npurpose: ${purpose}\n---\n\n# Instructions\n\n${purpose} guidance.\n`;
}

function packageRevision(revision: number, parentRevision?: number) {
  return {
    schemaVersion: "southstar.goal_design_package.v1",
    revision,
    ...(parentRevision !== undefined ? { parentRevision } : {}),
    packageHash: `removed-v1-package-${revision}`,
  };
}

function invalidInspectOnlyPlan(goalContract: GoalContractV1): WorkflowCompositionPlan {
  const base = deterministicFixtureComposition(goalContract);
  return {
    ...base,
    title: "Invalid Inspect Plan",
    rationale: "invalid profile for explorer task",
    tasks: base.tasks.map((task, index) => index === 0
      ? { ...task, agentProfileRef: "profile.invalid-explorer" }
      : task),
  };
}


function graphMetadataOnlyPlan(goalContract: GoalContractV1): WorkflowCompositionPlan {
  const requirementIds = goalContract.requirements.map((requirement) => requirement.id);
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Vocabulary Learning Feature",
    selectedWorkflowTemplateRef: "template.dynamic-single-task",
    rationale: "Use graph metadata primitives directly instead of legacy capability candidate maps.",
    tasks: [{
      id: "implement-vocab",
      name: "Implement Vocabulary Feature",
      responsibility: "Build a simple English vocabulary learning feature.",
      requirementIds,
      dependsOn: [],
      templateSlotRef: "implement",
      nodePromptSpec: {
        nodeType: "implement",
        goal: "Build the vocabulary learning feature.",
        requirements: ["Build the requested vocabulary learning feature."],
        boundaries: ["Stay within the vocabulary learning workspace."],
        nonGoals: ["Do not add unrelated product behavior."],
        deliverableDocuments: [],
        expectedOutputs: ["artifact.implementation_report"],
        testCases: [{ name: "Vocabulary feature artifact", expected: "The feature artifact is produced." }],
        acceptanceCriteria: ["The vocabulary feature satisfies the confirmed criteria."],
        implementationScope: ["Implement the vocabulary learning feature."],
      },
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.vocab.implement",
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.implementation_report"],
      evaluatorProfileRef: "evaluator.software-feature-quality",
      recoveryStrategyRefs: [],
      rationale: "A frontend developer with UI skill and workspace access can implement the requested feature.",
    }, {
      id: "verify-vocab",
      name: "Verify Vocabulary Feature",
      responsibility: "Independently verify the vocabulary learning feature and its evidence.",
      requirementIds,
      dependsOn: ["implement-vocab"],
      templateSlotRef: "verify",
      nodePromptSpec: {
        nodeType: "verify",
        goal: "Verify the vocabulary learning feature.",
        requirements: ["Verify the requested vocabulary learning feature."],
        boundaries: ["Evaluate only the declared feature artifact."],
        nonGoals: ["Do not change the implementation."],
        deliverableDocuments: [],
        expectedOutputs: ["verification evidence"],
        testCases: [{ name: "Vocabulary feature verification", expected: "The feature artifact satisfies the confirmed criteria." }],
        acceptanceCriteria: ["The vocabulary feature satisfies the confirmed criteria."],
        verificationChecks: ["Check the declared feature artifact against the confirmed criteria."],
      },
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.vocab.implement",
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_report"],
      outputArtifactRefs: [],
      evaluatorProfileRef: "evaluator.software-feature-quality",
      recoveryStrategyRefs: [],
      rationale: "Use a distinct downstream task to evaluate the produced feature artifact.",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [{
      id: "profile.generated.vocab.implement",
      kind: "agent_profile",
      risk: "medium",
      reason: "Generated from approved Postgres graph primitives.",
      validationStatus: "validated",
      agentProfile: {
        workerKind: "execution_worker",
        provider: "pi",
        model: "pi-agent-default",
        thinkingLevel: "high",
        harnessRef: "pi",
        instruction: "Implement the vocabulary learning feature with the selected React UI skill, workspace write tool, and React review instruction. Produce artifact.vocab_feature.",
        promptTemplateRef: "react-review",
        contextPolicyRef: "context.generated",
        sessionPolicyRef: "session.generated",
        memoryScopes: [],
        agentsMdRefs: [],
        vaultLeasePolicyRefs: [],
        toolPolicy: {
          allowedTools: ["tool.workspace-write"],
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
      },
    }],
  };
}

async function seedGraphMetadataOnlyWorkflowPrimitives(db: SouthstarDb): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey: "template.dynamic-single-task",
    objectKind: "workflow_template",
    status: "approved",
    headVersionId: "template.dynamic-single-task@1",
    state: { scope: "software", title: "Dynamic single task" },
  });
  await upsertLibraryObject(db, {
    objectKey: "capability.frontend-ui",
    objectKind: "capability_spec",
    status: "approved",
    headVersionId: "capability.frontend-ui@1",
    state: { scope: "software", title: "Frontend UI" },
  });
  await upsertLibraryObject(db, {
    objectKey: "agent.frontend-developer",
    objectKind: "agent_definition",
    status: "approved",
    headVersionId: "agent.frontend-developer@1",
    state: {
      scope: "software",
      title: "Frontend Developer",
      runtimeRole: {
        id: "frontend-developer",
        responsibility: "Build and independently verify frontend user interfaces.",
        defaultAgentProfileRef: "profile.generated.vocab.implement",
        allowedAgentProfileRefs: ["profile.generated.vocab.implement"],
        artifactInputs: ["artifact.implementation_report"],
        artifactOutputs: ["artifact.implementation_report"],
        stopAuthority: "can-suggest",
      },
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.react-ui",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.react-ui@1",
    state: { scope: "software", title: "React UI", body: "Build and verify React user interfaces." },
  });
  await upsertLibraryObject(db, {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    status: "approved",
    headVersionId: "tool.workspace-write@1",
    state: { scope: "global", title: "Workspace Write", runtimeToolNames: ["edit", "write"] },
  });
  await upsertLibraryObject(db, {
    objectKey: "mcp.filesystem-workspace",
    objectKind: "mcp_tool_grant",
    status: "approved",
    headVersionId: "mcp.filesystem-workspace@1",
    state: { scope: "global", title: "Filesystem Workspace", serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] },
  });
  await upsertLibraryObject(db, {
    objectKey: "instruction.react-review",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.react-review@1",
    state: { scope: "software", title: "React Review", content: "Review the React implementation.", variables: [] },
  });
  await upsertLibraryObject(db, {
    objectKey: "artifact.vocab_feature",
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId: "artifact.vocab_feature@1",
    state: { scope: "software", title: "Vocabulary feature artifact" },
  });
  await upsertLibraryObject(db, {
    objectKey: "evaluator.vocab-quality",
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId: "evaluator.vocab-quality@1",
    state: { scope: "software", title: "Vocabulary quality evaluator" },
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "uses",
    toObjectKey: "skill.react-ui",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "produces_artifact",
    toObjectKey: "artifact.vocab_feature",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "requires_tool",
    toObjectKey: "tool.workspace-write",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.react-review",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "evaluator.vocab-quality",
    edgeType: "validates_artifact",
    toObjectKey: "artifact.vocab_feature",
    scope: "software",
  });
}

function inspectPlanTasks(
  goalContract: GoalContractV1,
  explorerProfileRef: string,
): WorkflowCompositionPlan["tasks"] {
  const requirementIds = goalContract.requirements.map((requirement) => requirement.id);
  return [
    {
      id: "inspect-only",
      name: "Inspect Only",
      responsibility: "inspect repository and produce a plan",
      requirementIds,
      dependsOn: [],
      templateSlotRef: "understand",
      agentDefinitionRef: "agent.software-explorer",
      agentProfileRef: explorerProfileRef,
      instructionRefs: ["instruction.software-explorer"],
      skillRefs: ["skill.software-repo-discovery"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.implementation_plan"],
      evaluatorProfileRef: "evaluator.software-plan-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "explore repository",
    },
    {
      id: "review-spec",
      name: "Review Spec",
      responsibility: "review plan quality",
      requirementIds,
      dependsOn: ["inspect-only"],
      templateSlotRef: "review-spec",
      agentDefinitionRef: "agent.software-spec-reviewer",
      agentProfileRef: "profile.software-spec-reviewer-codex",
      instructionRefs: ["instruction.software-spec-reviewer"],
      skillRefs: ["skill.software-spec-review"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_plan"],
      outputArtifactRefs: ["artifact.implementation_plan"],
      evaluatorProfileRef: "evaluator.software-plan-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "review implementation plan before coding",
    },
    {
      id: "implement-feature",
      name: "Implement Feature",
      responsibility: "implement the feature",
      requirementIds,
      dependsOn: ["review-spec"],
      templateSlotRef: "implement",
      agentDefinitionRef: "agent.software-maker",
      agentProfileRef: "profile.software-maker-pi",
      instructionRefs: ["instruction.software-maker"],
      skillRefs: ["skill.software-implementation"],
      toolGrantRefs: ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_plan"],
      outputArtifactRefs: ["artifact.implementation_report"],
      evaluatorProfileRef: "evaluator.software-feature-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "implement after plan review",
    },
    {
      id: "verify-feature",
      name: "Verify Feature",
      responsibility: "run functional verification",
      requirementIds,
      dependsOn: ["implement-feature"],
      templateSlotRef: "verify",
      agentDefinitionRef: "agent.software-checker",
      agentProfileRef: "profile.software-checker-codex",
      instructionRefs: ["instruction.software-checker"],
      skillRefs: ["skill.software-verification"],
      toolGrantRefs: ["tool.workspace-read", "tool.shell-command"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_report"],
      outputArtifactRefs: ["artifact.verification_report"],
      evaluatorProfileRef: "evaluator.software-verification-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "validate behavior",
    },
    {
      id: "review-code-quality",
      name: "Review Code Quality",
      responsibility: "review maintainability and quality",
      requirementIds,
      dependsOn: ["implement-feature"],
      templateSlotRef: "review-code-quality",
      agentDefinitionRef: "agent.software-code-quality-reviewer",
      agentProfileRef: "profile.software-code-quality-reviewer-codex",
      instructionRefs: ["instruction.software-code-quality-reviewer"],
      skillRefs: ["skill.software-code-quality-review"],
      toolGrantRefs: ["tool.workspace-read", "tool.shell-command"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_report"],
      outputArtifactRefs: ["artifact.verification_report"],
      evaluatorProfileRef: "evaluator.software-verification-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "enforce code quality gate",
    },
    {
      id: "summarize-completion",
      name: "Summarize Completion",
      responsibility: "summarize final outcome",
      requirementIds: [],
      dependsOn: ["verify-feature", "review-code-quality"],
      templateSlotRef: "summarize",
      agentDefinitionRef: "agent.software-summarizer",
      agentProfileRef: "profile.software-summarizer-codex",
      instructionRefs: ["instruction.software-summarizer"],
      skillRefs: ["skill.software-summary"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.verification_report"],
      outputArtifactRefs: ["artifact.completion_report"],
      evaluatorProfileRef: "evaluator.software-completion-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "close run with evidence summary",
    },
  ];
}
