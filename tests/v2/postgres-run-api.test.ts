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
import type { GoalValidationResolutionV1, WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import {
  DeterministicFixtureComposer,
  deterministicFixtureComposition,
  seedDeterministicWorkflowGraph,
} from "./fixtures/deterministic-workflow-composer.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  finalizeGoalContract,
  GoalContractVocabularyGapError,
  goalContractHash,
  requirementSpecFromGoalContract,
  reviseGoalContract,
  type GoalContractInterpreter,
  type GoalContractV1,
} from "../../src/v2/orchestration/goal-contract.ts";
import {
  finalizeGoalDesignPackage,
  finalizeGoalDesignPackageV2,
  type GoalDesigner,
  type GoalDesignMode,
  type GoalDesignPackageV1,
  type GoalSliceDesigner,
  type WorkflowTemplatePolicyV1,
} from "../../src/v2/orchestration/goal-design.ts";
import {
  confirmGoalRequirementsPg,
  designAndPersistGoalSlicesPg,
  loadCurrentGoalDesignPackagePg,
  loadCurrentGoalRequirementDraftPg,
  resolveAndPersistGoalValidationPg,
  resumeGoalValidationAfterLibraryImportPg,
  persistGoalValidationResolutionPg,
  persistGoalDesignPackageRevisionPg,
  persistGoalRequirementDraftRevisionPg,
  preparePostgresGoalRequirementDraft,
  preparePostgresGoalDesignDraft,
  retryPostgresGoalDesignAfterVocabularyApprovalPg,
  reviseGoalDesignFromChatPg,
  reviseGoalSlicePg,
  reviseGoalRequirementPg,
  reviseGoalRequirementFromChatPg,
  loadCurrentUiInteractionContractPg,
  reviseUiInteractionContractPg,
} from "../../src/v2/orchestration/goal-design-draft-service.ts";
import { finalizeGoalRequirementDraft, type GoalRequirementDraftInputV1 } from "../../src/v2/orchestration/goal-requirement-draft.ts";
import { finalizeUiInteractionContract } from "../../src/v2/orchestration/ui-interaction-contract.ts";
import { resolveGoalValidationPg } from "../../src/v2/orchestration/goal-validation-resolver.ts";
import {
  createPostgresPlannerDraft,
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
  patchPostgresPlannerDraftTaskProfileOverride,
  revisePostgresPlannerDraft,
  validatePostgresPlannerDraft,
} from "../../src/v2/ui-api/postgres-run-api.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { resolveTestPostgresAdminUrl } from "./postgres-test-utils.ts";
import { fixedGoalInterpreter, softwareGoalContract } from "./fixtures/goal-contract.ts";

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
      /planner draft is not validated/,
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
    const orchestration = await getPostgresPlannerDraftOrchestration(db, { draftId: draft.draftId });
    assert.equal(orchestration.confirmable, false);
    assert.deepEqual(orchestration.validationIssues, []);
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
    assert.deepEqual(gapSource.requirements[0].acceptanceCriteria, goal.goalContract.requirements[0]!.acceptanceCriteria);
    const coverageConstraint = (importDraft!.payload as any).coverageConstraints[0];
    assert.equal(coverageConstraint.requirementStatement, goal.goalContract.requirements[0]!.statement);
    assert.deepEqual(
      coverageConstraint.criterionStatements.map((criterion: any) => criterion.statement),
      goal.goalRequirementDraft.requirements[0]!.acceptanceCriteria.map((criterion) => criterion.statement),
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

test("validation_ready continues on the same planner draft into a V2 Slice review", async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedGoalRequirementDraft(db, "Create an offline article with frozen validation");
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
        return finalizeGoalDesignPackageV2({
          schemaVersion: "southstar.goal_design_package.v2",
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
              stateOrArtifactOwner: binding.artifactContractRefs[0]!,
              mutationBoundary: "one offline article artifact",
              expectedArtifactRefs: binding.artifactContractRefs,
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
    };

    const designed = await designAndPersistGoalSlicesPg(db, {
      draftId: goal.draftId,
      expectedResolutionHash: resolution.resolutionHash,
      sliceDesigner,
    });

    assert.equal(designed.draftId, goal.draftId);
    assert.equal(designed.status, "ready_for_review");
    assert.equal(designed.phase, "slice_review");
    assert.equal(designed.goalDesignPackage.schemaVersion, "southstar.goal_design_package.v2");
    assert.equal(receivedBindingId, resolution.bindings[0]!.id);
    assert.equal((await loadCurrentGoalDesignPackagePg(db, goal.draftId)).packageHash, designed.goalDesignPackageHash);
    const stored = await getResourceByKeyPg(db, "planner_draft", goal.draftId);
    assert.equal(stored?.status, "ready_for_review");
    assert.equal((stored?.payload as any).goalDesignPhase, "slice_review");
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
    const composed = await createPostgresPlannerDraft(db, {
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
    assert.deepEqual(coverage.entries[0]!.acceptanceCriteria, goal.goalContract.requirements[0]!.acceptanceCriteria);
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
      const changed: GoalValidationResolutionV1 = {
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
      const changed: GoalValidationResolutionV1 = {
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

test("editing a confirmed requirement stales validation and slice resources", async () => {
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
    const revised = await reviseGoalRequirementPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
      requirementId: draft.goalRequirementDraft.requirements[0]!.id,
      patch: { statement: "Changed observable outcome" },
    });
    assert.equal(revised.status, "requirements_review");
    assert.equal(revised.invalidated?.validationBindings, true);
    assert.equal(revised.invalidated?.slicePlan, true);
    const validation = await getResourceByKeyPg(db, "goal_validation_resolution", draft.draftId);
    const slice = await getResourceByKeyPg(db, "goal_slice_plan", draft.draftId);
    assert.equal(validation?.status, "stale");
    assert.equal(slice?.status, "stale");
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
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt,
      cwd: "/workspace/article",
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer: new DeterministicFixtureComposer(),
    });

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
      () => createPostgresPlannerDraft(db, {
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
      () => createPostgresPlannerDraft(db, {
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
      () => createPostgresPlannerDraft(db, {
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
      () => createPostgresPlannerDraft(db, {
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
      () => createPostgresPlannerDraft(db, {
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
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt,
      cwd,
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer: new DeterministicFixtureComposer(),
      goalRequirementDraftId: sourceRequirement.draftId,
      goalRequirementDraftHash: sourceRequirement.goalRequirementDraftHash,
    });
    assert.equal(draft.status, "validated");
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
    await assert.rejects(
      () => reviseGoalRequirementPg(db, {
        draftId: sourceRequirement.draftId,
        expectedDraftHash: sourceRequirement.goalRequirementDraftHash,
        requirementId: sourceRequirement.goalRequirementDraft.requirements[0]!.id,
        patch: { statement: "Must not revise after a source run materializes" },
      }),
      /goal_requirements_already_materialized/,
    );
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
      const mutableInput = {
        goalPrompt,
        cwd,
        projectRef: "snapshot-project",
        compositionPlan: deterministicFixtureComposition(goalContract),
        goalInterpreter: fixedGoalInterpreter(goalContract),
        composer: new DeterministicFixtureComposer(),
        goalRequirementDraftId: sourceRequirement.draftId,
        goalRequirementDraftHash: sourceRequirement.goalRequirementDraftHash,
      };
      const expectedCompositionPlan = structuredClone(mutableInput.compositionPlan);
      const draftPromise = createPostgresPlannerDraft(db, mutableInput);
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

    await createPostgresPlannerDraft(db, {
      goalPrompt,
      cwd: "/workspace/article",
      goalInterpreter: {
        async interpret(input) {
          vocabulary = input.libraryVocabulary;
          return structuredClone(goalContract);
        },
      },
      composer: new DeterministicFixtureComposer(),
    });

    assert.ok(vocabulary?.scopes.includes("design/article"));
    assert.ok(vocabulary?.capabilityRefs.some((ref) => ref.startsWith("capability.")));
    assert.ok(vocabulary?.artifactRefs.some((ref) => ref.startsWith("artifact.")));
  });
});

test("Goal Design draft gives the Goal interpreter approved Library vocabulary", async () => {
  await withDb(async (db) => {
    const cwd = await mkdtemp(join(tmpdir(), "southstar-goal-design-vocab-"));
    const goalPrompt = "Turn notes.md into an offline HTML article";
    const goalContract = articleGoalContract(goalPrompt);
    try {
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
      await seedGoalDesignSkill(db);
      let vocabulary: Parameters<GoalContractInterpreter["interpret"]>[0]["libraryVocabulary"];

      await preparePostgresGoalDesignDraft(db, {
        goalPrompt,
        cwd,
        mode: "review_before_compose",
        templatePolicy: { mode: "auto" },
        goalInterpreter: {
          async interpret(input) {
            vocabulary = input.libraryVocabulary;
            return structuredClone(goalContract);
          },
        },
        goalDesigner: {
          async design(input) {
            return goalDesignPackageForContract({
              goalContract: input.goalContract,
              skillRef: input.skill.objectKey,
              skillVersionRef: input.skill.versionRef,
              workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
              mode: input.mode,
              templatePolicy: input.templatePolicy,
            });
          },
          async revise() {
            throw new Error("revise should not be called");
          },
        },
      });

      assert.ok(vocabulary?.scopes.includes("design/article"));
      assert.ok(vocabulary?.capabilityRefs.includes("capability.article-workspace-read"));
      assert.ok(vocabulary?.artifactRefs.includes("artifact.article_html"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("Goal Design package revisions are immutable resources", async () => {
  await withDb(async (db) => {
    const first = packageRevision(1);
    const second = packageRevision(2, 1);

    await persistGoalDesignPackageRevisionPg(db, { draftId: "draft-1", package: first });
    await persistGoalDesignPackageRevisionPg(db, { draftId: "draft-1", package: first });
    await persistGoalDesignPackageRevisionPg(db, { draftId: "draft-1", package: second });

    const rows = await db.query<{ resource_key: string }>(
      "select resource_key from southstar.runtime_resources where resource_type = 'goal_design_package_revision' order by resource_key",
    );
    assert.deepEqual(rows.rows.map((row) => row.resource_key), ["draft-1:revision:1", "draft-1:revision:2"]);

    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: "draft-1",
      scope: "planner",
      status: "ready_for_review",
      payload: { goalDesignPackage: second },
      summary: { goalDesignPackageHash: second.packageHash },
    });
    assert.equal((await loadCurrentGoalDesignPackagePg(db, "draft-1")).packageHash, second.packageHash);

    await assert.rejects(
      () => persistGoalDesignPackageRevisionPg(db, {
        draftId: "draft-1",
        package: {
          ...first,
          packageHash: second.packageHash,
        },
      }),
      /goal_design_revision_conflict/,
    );
  });
});

test("valid Slice edit creates one immutable package revision", async () => {
  await withDb(async (db) => {
    const { draftId, package: before } = await createReadyReviewGoalDesignDraft(db);
    const after = await reviseGoalSlicePg(db, {
      draftId,
      sliceId: before.slicePlan.slices[0]!.id,
      expectedPackageHash: before.packageHash,
      patch: { outcome: "deliver the accepted artifact" },
    });

    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.parentRevision, before.revision);
    assert.notEqual(after.packageHash, before.packageHash);
    assert.equal(after.slicePlan.slices[0]!.outcome, "deliver the accepted artifact");
    assert.equal(await countGoalDesignRevisions(db, draftId), 2);
    assert.equal(
      (await getPostgresPlannerDraftOrchestration(db, { draftId })).goalDesignPhase,
      "slice_review",
    );
  });
});

test("Slice revisions are frozen while Goal Design is composing", async () => {
  await withDb(async (db) => {
    const { draftId, package: before } = await createReadyReviewGoalDesignDraft(db);
    await db.query(
      `update southstar.runtime_resources
          set payload_json = payload_json || '{"goalDesignPhase":"composing"}'::jsonb
        where resource_type = 'planner_draft' and resource_key = $1`,
      [draftId],
    );

    await assert.rejects(
      () => reviseGoalSlicePg(db, {
        draftId,
        sliceId: before.slicePlan.slices[0]!.id,
        expectedPackageHash: before.packageHash,
        patch: { outcome: "Must not change during composition" },
      }),
      /goal_design_frozen/,
    );
    assert.equal(await countGoalDesignRevisions(db, draftId), 1);
  });
});

test("invalid and stale Slice edits create no revision", async () => {
  await withDb(async (db) => {
    const { draftId, package: before } = await createReadyReviewGoalDesignDraft(db);
    const sliceId = before.slicePlan.slices[0]!.id;
    const artifactRef = before.slicePlan.slices[0]!.expectedArtifactRefs[0]!;

    await assert.rejects(
      () => reviseGoalSlicePg(db, {
        draftId,
        sliceId,
        expectedPackageHash: before.packageHash,
        patch: { dependsOnSliceIds: [sliceId], dependencyArtifactRefs: [artifactRef] },
      }),
      /dependency_cycle/,
    );
    await assert.rejects(
      () => reviseGoalSlicePg(db, {
        draftId,
        sliceId,
        expectedPackageHash: "stale",
        patch: { outcome: "x" },
      }),
      /goal_design_package_stale/,
    );
    assert.equal(await countGoalDesignRevisions(db, draftId), 1);
  });
});

test("review chat revises the complete package without composing", async () => {
  await withDb(async (db) => {
    const { draftId, package: before } = await createReadyReviewGoalDesignDraft(db);
    let reviseCalls = 0;
    const result = await reviseGoalDesignFromChatPg({
      db,
      goalInterpreter: fixedGoalInterpreter(before.goalContract),
      goalDesigner: {
        async design() {
          throw new Error("design should not be called for review chat");
        },
        async revise({ currentPackage }) {
          reviseCalls += 1;
          const nextSlice = {
            ...currentPackage.slicePlan.slices[0]!,
            outcome: "deliver the split audit artifact",
          };
          return {
            kind: "revision",
            summary: "Separated audit artifact outcome.",
            changedSliceIds: [nextSlice.id],
            package: goalDesignPackageFromCurrent(currentPackage, [nextSlice]),
          };
        },
      },
    }, {
      draftId,
      expectedPackageHash: before.packageHash,
      message: "separate the audit artifact into its own outcome boundary",
      selectedSliceId: before.slicePlan.slices[0]!.id,
    });

    assert.equal(result.kind, "revision");
    if (result.kind !== "revision") assert.fail("expected a revision");
    assert.equal(result.package.revision, before.revision + 1);
    assert.equal(result.draftStatus, "ready_for_review");
    assert.equal(result.changedSliceIds[0], before.slicePlan.slices[0]!.id);
    assert.equal(reviseCalls, 1);
    assert.equal((await db.one<{ count: string }>("select count(*) from southstar.workflow_runs")).count, "0");
  });
});

test("review chat clarification leaves the package unchanged", async () => {
  await withDb(async (db) => {
    const { draftId, package: before } = await createReadyReviewGoalDesignDraft(db);
    const result = await reviseGoalDesignFromChatPg({
      db,
      goalInterpreter: fixedGoalInterpreter(before.goalContract),
      goalDesigner: {
        async design() {
          throw new Error("design should not be called for review chat");
        },
        async revise() {
          return { kind: "needs_input", question: "Which outcome boundary should change?" };
        },
      },
    }, {
      draftId,
      expectedPackageHash: before.packageHash,
      message: "change it",
    });

    assert.deepEqual(result, { kind: "needs_input", question: "Which outcome boundary should change?" });
    assert.equal((await loadCurrentGoalDesignPackagePg(db, draftId)).packageHash, before.packageHash);
    assert.equal(await countGoalDesignRevisions(db, draftId), 1);
  });
});

test("run materialization restores a missing manifest domain from the validated Goal Contract", async () => {
  await withDb(async (db) => {
    const goalPrompt = "Turn notes.md into an offline HTML article";
    const goalContract = articleGoalContract(goalPrompt);
    await seedDeterministicWorkflowGraph(db, goalContract.domain);
    const draft = await createPostgresPlannerDraft(db, {
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

test("blocking Goal Contract persists needs_input without compiling", async () => {
  await withDb(async (db) => {
    let composerCalled = false;
    const goalContract = {
      ...articleGoalContract("Publish my article"),
      blockingInputs: ["Which source file should be used?"],
    };
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: goalContract.originalPrompt,
      cwd: "/workspace/article",
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer: {
        async compose() {
          composerCalled = true;
          return deterministicFixtureComposition();
        },
      },
    });

    assert.equal(draft.status, "needs_input");
    assert.deepEqual(draft.blockers, ["Which source file should be used?"]);
    assert.equal(composerCalled, false);
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal((stored!.payload as any).workflow, undefined);
    assert.equal((stored!.payload as any).composition, undefined);
    await assert.rejects(() => createPostgresRunFromDraft(db, { draftId: draft.draftId }), /not validated/);
  });
});

test("unapproved Goal vocabulary persists needs_library_input without compiling", async () => {
  await withDb(async (db) => {
    let composerCalled = false;
    const goalContract = softwareGoalContract("Build membership subscriptions");
    const gapError = new GoalContractVocabularyGapError(
      { ...goalContract, domain: "membership", requiredCapabilities: ["capability.subscription-billing"] },
      [
        { kind: "domain", requestedRef: "membership", allowedRefs: ["software"] },
        { kind: "capability", requestedRef: "capability.subscription-billing", allowedRefs: ["capability.repo-read"] },
      ],
    );
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: goalContract.originalPrompt,
      cwd: "/workspace/membership",
      goalInterpreter: { async interpret() { throw gapError; } },
      composer: {
        async compose() {
          composerCalled = true;
          return deterministicFixtureComposition();
        },
      },
    });

    assert.equal(draft.status, "needs_library_input");
    assert.equal(composerCalled, false);
    assert.deepEqual(draft.vocabularyGaps, gapError.gaps);
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal(stored?.status, "needs_library_input");
    assert.deepEqual((stored?.payload as any).vocabularyGaps, gapError.gaps);
    assert.equal((stored?.payload as any).workflow, undefined);
  });
});

test("auto Goal Design creates a reviewable Library import draft for vocabulary gaps", async () => {
  await withDb(async (db) => {
    const cwd = await mkdtemp(join(tmpdir(), "southstar-goal-vocabulary-gap-"));
    const libraryRoot = join(cwd, "library");
    const goalContract = softwareGoalContract("Build membership subscriptions");
    const error = new GoalContractVocabularyGapError(
      { ...goalContract, domain: "membership", requiredCapabilities: ["capability.subscription-billing"] },
      [
        { kind: "domain", requestedRef: "membership", allowedRefs: ["software"] },
        { kind: "capability", requestedRef: "capability.subscription-billing", allowedRefs: ["capability.repo-read"] },
      ],
    );
    await mkdir(join(libraryRoot, "skills"), { recursive: true });
    await writeFile(join(libraryRoot, "skills/goal.skill.md"), approvedGoalValidationPurposeSkill("skill.southstar-goal-design", "goal_design"));
    await writeFile(join(libraryRoot, "skills/composer.skill.md"), approvedGoalValidationPurposeSkill("skill.southstar-composer-guidance", "composer_guidance"));
    await reconcileLibraryFilesPg(db, { root: libraryRoot, trigger: "startup" });

    try {
      const draft = await preparePostgresGoalDesignDraft(db, {
        goalPrompt: goalContract.originalPrompt,
        cwd,
        mode: "auto_until_blocked",
        templatePolicy: { mode: "auto" },
        goalInterpreter: { async interpret() { throw error; } },
        goalDesigner: { async design() { throw new Error("goal designer must not run before vocabulary approval"); } },
        libraryImportLlmProvider: async () => ({ candidates: [
          {
            objectKey: "domain.membership",
            kind: "domain",
            title: "Membership",
            scope: "membership",
            aliases: ["subscription"],
            selectedByDefault: true,
          },
          {
            objectKey: "capability.subscription-billing",
            kind: "capability",
            title: "Subscription Billing",
            scope: "membership",
            description: "Manage subscription billing state.",
            requiredOperations: ["workspace-read", "workspace-write"],
            selectedByDefault: true,
          },
        ] }),
      });

      assert.equal(draft.status, "needs_library_input");
      assert.match(draft.libraryImportDraftId ?? "", /^library-import-draft-/);
      const importDraft = await getResourceByKeyPg(db, "library_import_draft", draft.libraryImportDraftId!);
      assert.deepEqual((importDraft?.payload as any).candidates.map((candidate: any) => candidate.objectKey), [
        "domain.membership",
        "capability.subscription-billing",
      ]);
      const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
      assert.equal((stored?.payload as any).libraryImportDraftId, draft.libraryImportDraftId);

      await installLibraryImportCandidates(db, {
        root: libraryRoot,
        draftId: draft.libraryImportDraftId!,
        selectedCandidateIds: ["domain.membership", "capability.subscription-billing"],
        actor: "operator",
        reason: "approved Goal vocabulary gaps",
        llmProvider: async () => ({ proposedEdges: [] }),
      });
      const retried = await retryPostgresGoalDesignAfterVocabularyApprovalPg(db, {
        draftId: draft.draftId,
        goalInterpreter: {
          async interpret(input) {
            assert.ok(input.libraryVocabulary?.scopes.includes("membership"));
            assert.ok(input.libraryVocabulary?.capabilityRefs.includes("capability.subscription-billing"));
            return error.goalContract;
          },
        },
        goalDesigner: {
          async design(input) {
            return goalDesignPackageForContract({
              goalContract: input.goalContract,
              skillRef: input.skill.objectKey,
              skillVersionRef: input.skill.versionRef,
              workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
              mode: input.mode,
              templatePolicy: input.templatePolicy,
            });
          },
          async revise() { throw new Error("revise should not be called"); },
        },
      });
      assert.equal(retried.status, "ready_for_review");
      assert.equal(retried.goalContractHash, goalContractHash(error.goalContract));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("validating a durable needs_input draft preserves needs_input without requiring a workflow", async () => {
  await withDb(async (db) => {
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
    const goalContract = {
      ...articleGoalContract("Publish my article"),
      blockingInputs: ["Which source file should be used?"],
    };
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: goalContract.originalPrompt,
      cwd: "/workspace/article",
      goalInterpreter: fixedGoalInterpreter(goalContract),
      composer: new DeterministicFixtureComposer(),
    });

    const validated = await validatePostgresPlannerDraft(db, { draftId: draft.draftId });
    assert.equal(validated.status, "needs_input");
    assert.deepEqual(validated.blockers, goalContract.blockingInputs);
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal(stored?.status, "needs_input");
    assert.equal((stored?.payload as any).workflow, undefined);
  });
});

test("legacy planner draft inspection and validation adapt and persist a canonical Goal Contract", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement legacy inspection compatibility");
    await stripGoalContractFromDraft(db, draft.draftId);

    const inspection = await getPostgresPlannerDraftOrchestration(db, { draftId: draft.draftId });
    assert.match(inspection.goalContractHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(inspection.blockers, []);

    const validated = await validatePostgresPlannerDraft(db, { draftId: draft.draftId });
    assert.equal(validated.status, "validated");
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    assert.equal((stored?.payload as any).goalContract.schemaVersion, "southstar.goal_contract.v1");
    assert.equal((stored?.payload as any).goalContract.requiredCapabilities.length, 0);
    assert.equal((stored?.payload as any).goalContract.requestedSideEffects.length, 0);
    assert.equal((stored?.summary as any).goalContractHash, validated.goalContractHash);
  });
});

test("legacy planner draft missingInputs canonicalize validation to needs_input with a fresh hash", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement legacy missing input compatibility");
    await stripGoalContractFromDraft(db, draft.draftId, {
      missingInputs: ["Which API contract should be used?"],
      staleGoalContractHash: "stale-goal-contract-hash",
    });

    const validated = await validatePostgresPlannerDraft(db, { draftId: draft.draftId });
    assert.equal(validated.status, "needs_input");
    assert.deepEqual(validated.blockers, ["Which API contract should be used?"]);
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    const contract = (stored?.payload as any).goalContract as GoalContractV1;
    const canonicalHash = goalContractHash(contract);
    assert.equal(stored?.status, "needs_input");
    assert.equal((stored?.payload as any).goalContractHash, canonicalHash);
    assert.equal((stored?.summary as any).goalContractHash, canonicalHash);
    assert.notEqual(canonicalHash, "stale-goal-contract-hash");
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /planner draft is not validated/,
    );
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

test("legacy planner draft revision adapts the previous Goal Contract without changing originalPrompt", async () => {
  await withDb(async (db) => {
    const goalPrompt = "implement legacy revision compatibility";
    const draft = await createFixturePlannerDraft(db, goalPrompt);
    await stripGoalContractFromDraft(db, draft.draftId);

    const revised = await revisePostgresPlannerDraft(db, {
      draftId: draft.draftId,
      prompt: "also handle empty input",
      goalInterpreter: softwareRevisionInterpreter(goalPrompt),
      composer: new DeterministicFixtureComposer(),
    });
    const stored = await getResourceByKeyPg(db, "planner_draft", revised.draftId);
    assert.equal((stored?.payload as any).goalContract.originalPrompt, goalPrompt);
    assert.equal((stored?.payload as any).goalContract.revision, 2);
  });
});

test("legacy planner draft profile override persists the adapted canonical Goal Contract", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement legacy profile override compatibility");
    await stripGoalContractFromDraft(db, draft.draftId, {
      staleGoalContractHash: "stale-profile-goal-contract-hash",
    });

    await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: { model: "gpt-5-codex" },
    });
    const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
    const contract = (stored?.payload as any).goalContract as GoalContractV1;
    const canonicalHash = goalContractHash(contract);
    assert.equal(contract.schemaVersion, "southstar.goal_contract.v1");
    assert.equal((stored?.payload as any).goalContractHash, canonicalHash);
    assert.equal((stored?.summary as any).goalContractHash, canonicalHash);
    assert.notEqual(canonicalHash, "stale-profile-goal-contract-hash");
  });
});

test("planner draft revision preserves the original prompt and revises the Goal Contract", async () => {
  await withDb(async (db) => {
    const goalPrompt = "Turn notes.md into an offline HTML article";
    const baseContract = articleGoalContract(goalPrompt);
    await seedDeterministicWorkflowGraph(db, baseContract.domain);
    let calls = 0;
    const goalInterpreter: GoalContractInterpreter = {
      async interpret(input) {
        calls += 1;
        if (calls === 1) return structuredClone(baseContract);
        assert.equal(input.goalPrompt, goalPrompt);
        assert.equal(input.previousContract?.revision, 1);
        assert.equal(input.revisionPrompt, "Include source citations");
        return reviseArticleGoalContract(input.previousContract!, input.revisionPrompt!);
      },
    };
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt,
      cwd: "/workspace/article",
      goalInterpreter,
      composer: new DeterministicFixtureComposer(),
    });
    const revised = await revisePostgresPlannerDraft(db, {
      draftId: draft.draftId,
      prompt: "Include source citations",
      goalInterpreter,
      composer: new DeterministicFixtureComposer(),
    });

    const stored = await getResourceByKeyPg(db, "planner_draft", revised.draftId);
    const revisedContract = (stored!.payload as any).goalContract as GoalContractV1;
    assert.equal(calls, 2);
    assert.equal(revised.goalPrompt, goalPrompt);
    assert.equal(revisedContract.originalPrompt, goalPrompt);
    assert.equal(revisedContract.revision, 2);
    assert.match(revisedContract.requirements.at(-1)?.statement ?? "", /source citations/i);
    assert.notEqual(revised.goalContractHash, draft.goalContractHash);
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
    const draft = await createPostgresPlannerDraft(db, {
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
    const packageValue = finalizeGoalDesignPackage({
      schemaVersion: "southstar.goal_design_package.v1",
      revision: 1,
      goalContract: contract,
      evaluatorContracts: [{
        schemaVersion: "southstar.requirement_evaluator_contract.v1",
        id: "evaluator.run-hash-test",
        requirementId: requirement.id,
        acceptanceCriteria: [...requirement.acceptanceCriteria],
        requiredEvidenceKinds: ["test-result"],
        independence: "independent",
        failureClassifications: ["implementation_gap"],
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
          evaluatorContractRefs: ["evaluator.run-hash-test"],
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
        expected: /Goal Design Package hash mismatch/,
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

test("Postgres planner draft revision preserves matching task profile overrides and requires validation", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const goalInterpreter = softwareRevisionInterpreter("implement calc sum with override preservation");
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with override preservation",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      goalInterpreter,
      composer: new DeterministicFixtureComposer(),
    });

    await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: {
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Keep this manually selected implementation agent.",
        skillRefs: ["software.calc-cli"],
        mcpGrantRefs: ["filesystem-workspace"],
      },
    });

    const revised = await revisePostgresPlannerDraft(db, {
      draftId: draft.draftId,
      prompt: "also verify empty input behavior",
      composerMode: "llm",
      goalInterpreter,
      composer: new DeterministicFixtureComposer(),
    });

    assert.notEqual(revised.draftId, draft.draftId);
    assert.equal(revised.status, "needs_validation");

    const revisedRow = await db.one<{
      status: string;
      summary_json: { status?: string };
      payload_json: { workflow: { tasks: Array<Record<string, any>> } };
    }>(
      "select status, summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [revised.draftId],
    );
    const implement = revisedRow.payload_json.workflow.tasks.find((task) => task.id === "implement-feature");
    assert.equal(revisedRow.status, "needs_validation");
    assert.equal(revisedRow.summary_json.status, "needs_validation");
    assert.equal(implement?.profileOverride?.model, "gpt-5-codex");
    assert.equal(implement?.profileOverride?.instruction, "Keep this manually selected implementation agent.");
    assert.deepEqual(implement?.skillRefs, ["software.calc-cli"]);
    assert.deepEqual(implement?.mcpGrantRefs, ["filesystem-workspace"]);
  });
});

test("Postgres run API supports llm-constrained planner drafts and preserves task creation order", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
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
      () => createPostgresPlannerDraft(db, {
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
    const draft = await createPostgresPlannerDraft(db, {
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
    const draft = await createPostgresPlannerDraft(db, {
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
      () => createPostgresPlannerDraft(db, {
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

    await createPostgresPlannerDraft(db, {
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
      invalidInspectOnlyPlan(goalContract),
      deterministicFixtureComposition(goalContract),
    ]);
    const draft = await createPostgresPlannerDraft(db, {
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
    assert.equal(draftResource.payload_json.repairAttempts.length, 2);
    assert.equal(draftResource.payload_json.repairAttempts[0]?.validation.ok, false);
    assert.equal(draftResource.payload_json.repairAttempts[1]?.validation.ok, true);

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

    const draft = await createPostgresPlannerDraft(db, {
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
      invalidInspectOnlyPlan(goalContract),
      invalidInspectOnlyPlan(goalContract),
    ]);
    const draft = await createPostgresPlannerDraft(db, {
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
    assert.equal(draftResource.payload_json.repairAttempts.length, 3);
    assert.equal(draftResource.payload_json.repairAttempts[2]?.validation.ok, false);
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /planner draft is not validated/,
    );
  });
});

test("Postgres planner draft orchestration inspection helper returns public summary and orchestration snapshot", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
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
    await upsertRuntimeResourcePg(db, {
      id: "draft-invalid-test",
      resourceType: "planner_draft",
      resourceKey: "draft-invalid-test",
      scope: "planner",
      status: "invalid",
      title: "Invalid Draft",
      payload: { workflow: { workflowId: "wf-invalid" } },
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
    await upsertRuntimeResourcePg(db, {
      id: "draft-without-goal-contract",
      resourceType: "planner_draft",
      resourceKey: "draft-without-goal-contract",
      scope: "planner",
      status: "validated",
      title: "Missing Goal Contract",
      payload: {
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

test("Postgres server routes create planner drafts through the Goal API", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner client not used by Postgres constrained planner"); } },
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract("implement calc sum")),
      goalDesigner: routeGoalDesigner(),
      workflowComposer: new DeterministicFixtureComposer(),
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by created-state route"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const draft = await api<{
        draftId: string;
        workflowId: string;
        status: string;
        goalDesignPackageHash?: string;
        validationIssues: Array<{ path: string; message: string }>;
        taskSummaries: Array<{ taskId: string }>;
      }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "implement calc sum", cwd: process.cwd(), idempotencyKey: "legacy-route-create-1" }),
      });
      assert.match(draft.draftId, /^draft-goal-design-/);
      assert.equal(draft.status, "ready_for_review");
      assert.match(draft.goalDesignPackageHash ?? "", /^[a-f0-9]{64}$/);
      assert.deepEqual(draft.validationIssues, []);
      assert.deepEqual(draft.taskSummaries, []);

      const llmDraft = await api<{
        draftId: string;
        workflowId: string;
        status: string;
        goalDesignPackageHash?: string;
        validationIssues: Array<{ path: string; message: string }>;
        taskSummaries: Array<{ taskId: string }>;
      }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({
          goalPrompt: "implement calc sum",
          orchestrationMode: "llm-constrained",
          cwd: process.cwd(),
          idempotencyKey: "legacy-route-create-2",
        }),
      });
      assert.match(llmDraft.draftId, /^draft-goal-design-/);
      assert.equal(llmDraft.status, "ready_for_review");
      assert.match(llmDraft.goalDesignPackageHash ?? "", /^[a-f0-9]{64}$/);
      assert.deepEqual(llmDraft.validationIssues, []);
      assert.deepEqual(llmDraft.taskSummaries, []);
    } finally {
      await server.close();
    }
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

test("Postgres server planner draft route accepts and persists structured request hints", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner client not used by structured request contract test"); } },
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract("implement calc sum")),
      goalDesigner: routeGoalDesigner(),
      workflowComposer: new DeterministicFixtureComposer(),
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by planner route"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const request = {
        goalPrompt: "implement calc sum",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
        cwd: process.cwd(),
        idempotencyKey: "legacy-structured-request-1",
        libraryHints: {
          roleRefs: ["agent.software-maker"],
          agentProfileRefs: ["profile.software-maker-pi"],
          skillRefs: ["skill.software-implementation"],
          mcpGrantRefs: ["mcp.filesystem-workspace"],
          toolRefs: ["tool.workspace-read", "tool.shell-command"],
          modelHints: { maker: "gpt-5" },
          vaultLeasePolicyRefs: ["vault.github-write-token"],
          toolPolicyHints: {
            allowedTools: ["read", "search", "shell"],
            deniedTools: ["write"],
            requiresApprovalFor: ["network"],
          },
        },
      };
      const expectedPlannerRequest = {
        goalPrompt: request.goalPrompt,
        cwd: request.cwd,
        goalDesignMode: "review_before_compose",
        templatePolicy: { mode: "auto" },
      };
      const draft = await api<{
        draftId: string;
        goalPrompt: string;
        workflowId: string;
        status: string;
      }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify(request),
      });
      assert.equal(draft.status, "ready_for_review");
      assert.equal(draft.goalPrompt, request.goalPrompt);

      const row = await db.one<{
        summary_json: { plannerRequest?: unknown };
        payload_json: { plannerRequest?: unknown };
      }>(
        "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
        [draft.draftId],
      );
      assert.deepEqual(row.summary_json.plannerRequest, expectedPlannerRequest);
      assert.deepEqual(row.payload_json.plannerRequest, expectedPlannerRequest);
    } finally {
      await server.close();
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
    const expectedPlannerRequest = JSON.parse(JSON.stringify(request));
    const draftPromise = createPostgresPlannerDraft(db, {
      ...request,
      goalInterpreter: fixedGoalInterpreter(softwareGoalContract(request.goalPrompt)),
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

test("Postgres planner draft revision preserves structured request hints with explicit mode overrides", async () => {
  await withDb(async (db) => {
    const baseRequest = {
      goalPrompt: "implement calc sum with structured revision context",
      orchestrationMode: "llm-constrained" as const,
      composerMode: "llm" as const,
      cwd: "/workspace/southstar",
      libraryHints: {
        roleRefs: ["agent.software-maker"],
        agentProfileRefs: ["profile.software-maker-pi"],
        skillRefs: ["skill.software-implementation"],
        mcpGrantRefs: ["mcp.filesystem-workspace"],
        toolRefs: ["tool.workspace-read", "tool.shell-command"],
        modelHints: { maker: "gpt-5" },
        vaultLeasePolicyRefs: ["vault.github-write-token"],
        toolPolicyHints: {
          allowedTools: ["read", "search", "shell"],
          deniedTools: ["write"],
          requiresApprovalFor: ["network"],
        },
      },
    };
    const goalInterpreter = softwareRevisionInterpreter(baseRequest.goalPrompt);
    const draft = await createPostgresPlannerDraft(db, {
      ...baseRequest,
      goalInterpreter,
      composer: new DeterministicFixtureComposer(),
    });
    const revised = await revisePostgresPlannerDraft(db, {
      draftId: draft.draftId,
      prompt: "add explicit edge-case validation for empty inputs",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      goalInterpreter,
      composer: new DeterministicFixtureComposer(),
    });

    const expectedPlannerRequest = baseRequest;
    const revisedRow = await db.one<{
      summary_json: { plannerRequest?: unknown };
      payload_json: { plannerRequest?: unknown; goalContract?: GoalContractV1 };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [revised.draftId],
    );
    assert.equal(revised.goalPrompt, baseRequest.goalPrompt);
    assert.equal(revisedRow.payload_json.goalContract?.originalPrompt, baseRequest.goalPrompt);
    assert.equal(revisedRow.payload_json.goalContract?.revision, 2);
    assert.deepEqual(revisedRow.summary_json.plannerRequest, expectedPlannerRequest);
    assert.deepEqual(revisedRow.payload_json.plannerRequest, expectedPlannerRequest);
  });
});

test("Postgres server routes revise planner drafts via planner pipeline", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    await seedGoalDesignSkill(db);
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner client not used by planner route test"); } },
      goalInterpreter: softwareRevisionInterpreter("implement calc sum"),
      goalDesigner: routeGoalDesigner(),
      workflowComposer: new DeterministicFixtureComposer(),
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by planner routes"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const draft = await api<{
        draftId: string;
        goalPrompt: string;
        workflowId: string;
        status: string;
        goalDesignPackageHash?: string;
        taskSummaries: Array<{ taskId: string }>;
      }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "implement calc sum", cwd: process.cwd(), idempotencyKey: "legacy-revise-route-1" }),
      });
      const revised = await api<{
        kind: string;
        draftStatus: string;
        changedSliceIds: string[];
        package: { packageHash: string };
      }>(server.url, `/api/v2/planner/drafts/${encodeURIComponent(draft.draftId)}/revise`, {
        method: "POST",
        body: JSON.stringify({
          prompt: "add explicit edge-case validation for empty inputs",
          orchestrationMode: "llm-constrained",
          expectedPackageHash: draft.goalDesignPackageHash,
        }),
      });

      assert.equal(revised.kind, "revision");
      assert.equal(revised.draftStatus, "ready_for_review");
      assert.deepEqual(revised.changedSliceIds, ["slice-1"]);
      assert.notEqual(revised.package.packageHash, draft.goalDesignPackageHash);

      const revisedDraftRow = await db.one<{ summary_json: { goalPrompt?: string; goalDesignPackageHash?: string } }>(
        "select summary_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
        [draft.draftId],
      );
      assert.equal(revisedDraftRow.summary_json.goalPrompt, "implement calc sum");
      assert.equal(revisedDraftRow.summary_json.goalDesignPackageHash, revised.package.packageHash);
    } finally {
      await server.close();
    }
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
  return await createPostgresPlannerDraft(db, {
    goalPrompt,
    orchestrationMode: "llm-constrained",
    composerMode: "llm",
    goalInterpreter: fixedGoalInterpreter(softwareGoalContract(goalPrompt)),
    composer: new DeterministicFixtureComposer(),
  });
}

async function createReadyReviewGoalDesignDraft(
  db: SouthstarDb,
): Promise<{ draftId: string; package: GoalDesignPackageV1 }> {
  const pkg = packageRevision(1);
  const draftId = `draft-goal-design-${pkg.packageHash.slice(0, 12)}`;
  await persistGoalDesignPackageRevisionPg(db, { draftId, package: pkg });
  await upsertRuntimeResourcePg(db, {
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "ready_for_review",
    title: "Goal Design Ready For Review",
    payload: {
      goalContract: pkg.goalContract,
      goalContractHash: pkg.goalContractHash,
      goalDesignPackage: pkg,
      goalDesignPackageHash: pkg.packageHash,
      plannerRequest: {
        goalPrompt: pkg.goalContract.originalPrompt,
        cwd: pkg.goalContract.workspace.cwd,
        goalDesignMode: pkg.mode,
        templatePolicy: pkg.templatePolicy,
      },
    },
    summary: {
      goalPrompt: pkg.goalContract.originalPrompt,
      workflowId: "",
      planner: "goal-design",
      status: "ready_for_review",
      validationIssues: [],
      taskSummaries: [],
      goalContractHash: pkg.goalContractHash,
      goalDesignPackageHash: pkg.packageHash,
      sliceCount: pkg.slicePlan.slices.length,
    },
  });
  return { draftId, package: pkg };
}

async function countGoalDesignRevisions(db: SouthstarDb, draftId: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    "select count(*) from southstar.runtime_resources where resource_type = 'goal_design_package_revision' and resource_key like $1",
    [`${draftId}:revision:%`],
  );
  return Number(row.count);
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
        acceptanceCriteria: ["The article opens offline as a single HTML file"],
        blocking: true,
        source: "explicit",
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
      acceptanceCriteria: [{
        statement: "The article opens offline as a single HTML file.",
        evidenceIntent: ["screenshot"],
      }],
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
      acceptanceCriteria: [{ statement: "Reveal changes question to answer state.", evidenceIntent: ["screenshot"] }],
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
      return finalizeGoalDesignPackageV2({
        schemaVersion: "southstar.goal_design_package.v2",
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
            stateOrArtifactOwner: binding.artifactContractRefs[0]!,
            mutationBoundary: "the requested offline document artifact",
            expectedArtifactRefs: binding.artifactContractRefs,
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
  };
}

function inlineArticleComposition(goalContract: GoalContractV1, sliceId: string): WorkflowCompositionPlan {
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
      acceptanceCriteria: [...goalContract.requirements[0]!.acceptanceCriteria],
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
    evaluatorProfileRef: "evaluator.offline-document",
    recoveryStrategyRefs: [],
    rationale: `${nodeType} the frozen slice with approved validation contracts.`,
  });
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Offline Document Delivery",
    selectedWorkflowTemplateRef: "template.document-delivery",
    rationale: "One producer followed by an independent criterion evaluator.",
    tasks: [
      task("produce-document", "implement", [], [], ["artifact.offline-document"]),
      task("verify-document", "verify", ["produce-document"], ["artifact.offline-document"], []),
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
    state: { scope: "design/article", title: "Document worker" },
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

async function createConfirmedGoalRequirementDraft(db: SouthstarDb, goalPrompt: string) {
  await seedGoalDesignSkill(db);
  await seedGoalRequirementVocabulary(db);
  const cwd = process.cwd();
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
): GoalValidationResolutionV1 {
  const requirement = goal.goalContract.requirements[0]!;
  const criterionIds = goal.goalRequirementDraft.requirements[0]!.acceptanceCriteria.map((criterion) => criterion.id);
  const withoutHash: Omit<GoalValidationResolutionV1, "resolutionHash"> = ready
    ? {
      schemaVersion: "southstar.goal_validation_resolution.v1",
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
        acceptanceCriteria: [...requirement.acceptanceCriteria],
      }],
      bindings: [{
        schemaVersion: "southstar.requirement_validation_binding.v1",
        id: `binding-${requirement.id}`,
        requirementId: requirement.id,
        criterionIds,
        acceptanceCriteria: [...requirement.acceptanceCriteria],
        artifactContractRefs: ["artifact.offline-html"],
        artifactContractVersionRefs: ["artifact.offline-html@1"],
        evaluatorProfileRef: "evaluator.offline-html",
        evaluatorProfileVersionRef: "evaluator.offline-html@1",
        verificationMode: "browser_interaction",
        criterionChecks: criterionIds.map((criterionId) => ({
          criterionId,
          procedureRef: "procedure.offline-open",
          expectedEvidenceKinds: ["screenshot"],
        })),
        requiredEvidenceKinds: ["screenshot"],
        independence: "independent",
        failureClassifications: ["offline_open_failed"],
      }],
      gaps: [],
      ready: true,
    }
    : {
      schemaVersion: "southstar.goal_validation_resolution.v1",
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
        acceptanceCriteria: [...requirement.acceptanceCriteria],
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

function routeGoalDesigner(): GoalDesigner {
  return {
    async design(input) {
      return goalDesignPackageForContract({
        goalContract: input.goalContract,
        skillRef: input.skill.objectKey,
        skillVersionRef: input.skill.versionRef,
        workspaceDiscoveryHash: input.workspaceDiscovery.discoveryHash,
        mode: input.mode,
        templatePolicy: input.templatePolicy,
      });
    },
    async revise({ currentPackage }) {
      const firstSlice = currentPackage.slicePlan.slices[0]!;
      const nextSlice = {
        ...firstSlice,
        outcome: `${firstSlice.outcome} with revised route coverage`,
      };
      return {
        kind: "revision",
        summary: "Updated the first slice outcome.",
        changedSliceIds: [firstSlice.id],
        package: goalDesignPackageFromCurrent(currentPackage, [nextSlice]),
      };
    },
  };
}

function goalDesignPackageForContract(input: {
  goalContract: GoalContractV1;
  skillRef: string;
  skillVersionRef: string;
  workspaceDiscoveryHash: string;
  mode: GoalDesignMode;
  templatePolicy: WorkflowTemplatePolicyV1;
}): GoalDesignPackageV1 {
  const requirement = input.goalContract.requirements[0]!;
  const artifactRef = input.goalContract.expectedArtifactRefs[0] ?? "artifact.completion_report";
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: 1,
    goalContract: input.goalContract,
    evaluatorContracts: [{
      schemaVersion: "southstar.requirement_evaluator_contract.v1",
      id: "eval-1",
      requirementId: requirement.id,
      acceptanceCriteria: [...requirement.acceptanceCriteria],
      requiredEvidenceKinds: ["test_result"],
      independence: "independent",
      failureClassifications: ["implementation_gap"],
    }],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: 1,
      slices: [{
        id: "slice-1",
        requirementIds: [requirement.id],
        outcome: requirement.statement,
        stateOrArtifactOwner: artifactRef,
        mutationBoundary: "one cohesive implementation boundary",
        expectedArtifactRefs: [artifactRef],
        evaluatorContractRefs: ["eval-1"],
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: ["slice-1"],
      rationale: "one atomic requirement boundary",
    },
    templatePolicy: input.templatePolicy,
    goalDesignSkillRef: input.skillRef,
    goalDesignSkillVersionRef: input.skillVersionRef,
    workspaceDiscoveryHash: input.workspaceDiscoveryHash,
    mode: input.mode,
  });
}

function packageRevision(revision: number, parentRevision?: number) {
  const contract = softwareGoalContract(`goal design revision ${revision}`);
  const requirement = contract.requirements[0]!;
  const artifactRef = contract.expectedArtifactRefs[0]!;
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision,
    ...(parentRevision !== undefined ? { parentRevision } : {}),
    goalContract: contract,
    evaluatorContracts: [{
      schemaVersion: "southstar.requirement_evaluator_contract.v1",
      id: `eval-${revision}`,
      requirementId: requirement.id,
      acceptanceCriteria: [...requirement.acceptanceCriteria],
      requiredEvidenceKinds: ["test_result"],
      independence: "independent",
      failureClassifications: ["implementation_gap"],
    }],
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision,
      slices: [{
        id: `slice-${revision}`,
        requirementIds: [requirement.id],
        outcome: requirement.statement,
        stateOrArtifactOwner: artifactRef,
        mutationBoundary: "one cohesive implementation boundary",
        expectedArtifactRefs: [artifactRef],
        evaluatorContractRefs: [`eval-${revision}`],
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: {
      mode: "single-run",
      sliceIds: [`slice-${revision}`],
      rationale: "one atomic requirement boundary",
    },
    templatePolicy: { mode: "auto" },
    goalDesignSkillRef: "skill.southstar-goal-design",
    goalDesignSkillVersionRef: "skill.southstar-goal-design@test",
    workspaceDiscoveryHash: `workspace-${revision}`,
    mode: "review_before_compose",
  });
}

function goalDesignPackageFromCurrent(
  current: GoalDesignPackageV1,
  slices: GoalDesignPackageV1["slicePlan"]["slices"],
): GoalDesignPackageV1 {
  const nextRevision = current.revision + 1;
  return finalizeGoalDesignPackage({
    schemaVersion: "southstar.goal_design_package.v1",
    revision: nextRevision,
    parentRevision: current.revision,
    goalContract: current.goalContract,
    evaluatorContracts: current.evaluatorContracts,
    slicePlan: {
      schemaVersion: "southstar.goal_slice_plan.v1",
      goalContractHash: "host-filled",
      revision: nextRevision,
      slices,
    },
    compositionStrategy: {
      ...current.compositionStrategy,
      sliceIds: slices.map((slice) => slice.id),
    },
    templatePolicy: current.templatePolicy,
    goalDesignSkillRef: current.goalDesignSkillRef,
    goalDesignSkillVersionRef: current.goalDesignSkillVersionRef,
    workspaceDiscoveryHash: current.workspaceDiscoveryHash,
    mode: current.mode,
  });
}

function softwareRevisionInterpreter(goalPrompt: string): GoalContractInterpreter {
  const initialContract = softwareGoalContract(goalPrompt);
  return {
    async interpret(input) {
      if (!input.previousContract) return structuredClone(initialContract);
      return {
        ...structuredClone(input.previousContract),
        revision: input.previousContract.revision + 1,
        summary: `${input.previousContract.summary}; ${input.revisionPrompt ?? "revised"}`,
      };
    },
  };
}

function reviseArticleGoalContract(previousContract: GoalContractV1, revisionPrompt: string): GoalContractV1 {
  return reviseGoalContract({
    goalPrompt: previousContract.originalPrompt,
    cwd: previousContract.workspace.cwd,
    previousContract,
    interpretation: {
      domain: previousContract.domain,
      intent: previousContract.intent,
      summary: `${previousContract.summary}; ${revisionPrompt}`,
      requirements: [
        ...previousContract.requirements.map(({ id: _id, ...requirement }) => requirement),
        {
          statement: revisionPrompt,
          acceptanceCriteria: ["The rendered article includes source citations"],
          blocking: true,
          source: "explicit",
        },
      ],
      expectedArtifactRefs: previousContract.expectedArtifactRefs,
      requiredCapabilities: previousContract.requiredCapabilities,
      nonGoals: previousContract.nonGoals,
      assumptions: previousContract.assumptions,
      blockingInputs: [],
      riskTags: previousContract.riskTags,
      requestedSideEffects: previousContract.requestedSideEffects,
    },
  });
}

function invalidInspectOnlyPlan(goalContract: GoalContractV1): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Invalid Inspect Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "invalid profile for explorer task",
    tasks: inspectPlanTasks(goalContract, "profile.software-maker-pi"),
    rejectedCandidates: [],
    generatedComponentProposals: [],
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
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.vocab.implement",
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.vocab_feature"],
      evaluatorProfileRef: "evaluator.vocab-quality",
      recoveryStrategyRefs: [],
      rationale: "A frontend developer with UI skill and workspace access can implement the requested feature.",
    }, {
      id: "verify-vocab",
      name: "Verify Vocabulary Feature",
      responsibility: "Independently verify the vocabulary learning feature and its evidence.",
      requirementIds,
      dependsOn: ["implement-vocab"],
      templateSlotRef: "verify",
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.vocab.implement",
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.vocab_feature"],
      outputArtifactRefs: [],
      evaluatorProfileRef: "evaluator.vocab-quality",
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
