import type { SouthstarDb } from "../db/postgres.ts";
import {
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import {
  finalizeGoalDesignPackage,
  loadGoalDesignSkillPg,
  validateGoalDesignPackage,
  type GoalDesignMode,
  type GoalDesignPackageV1,
  type GoalDesigner,
  type GoalSliceV1,
  type WorkflowTemplatePolicyV1,
} from "./goal-design.ts";
import {
  GoalContractVocabularyGapError,
  goalContractHash,
  storedGoalContract,
  type GoalContractInterpreter,
  type GoalContractV1,
} from "./goal-contract.ts";
import {
  confirmGoalRequirementDraft,
  reviseGoalRequirementDraft,
  validateGoalRequirementDraft,
  type GoalRequirementDraftInterpreter,
  type GoalRequirementDraftRevisionOperation,
  type GoalRequirementDraftRevisionPatchV1,
  type GoalRequirementDraftV1,
} from "./goal-requirement-draft.ts";
import { createLibraryImportDraft } from "../design-library/importers/library-import-draft-store.ts";
import type { LibraryImportLlmProvider } from "../design-library/importers/library-llm-import-analyzer.ts";
import type { LibraryImportSourceFetcher } from "../design-library/importers/library-source-fetcher.ts";
import type { SubmitGoalContext } from "./run-goal-service.ts";
import { discoverGoalWorkspace } from "./goal-workspace-discovery.ts";
import type {
  PlannerDraftPersistence,
  PlannerDraftProgressListener,
  PostgresPlannerDraftResult,
} from "../ui-api/postgres-run-api.ts";
import {
  loadGoalContractLibraryVocabularyPg,
  persistGoalContractVocabularyGapDraftPg,
} from "../ui-api/postgres-run-api.ts";

type RuntimeResourceUpsertInput = Parameters<typeof upsertRuntimeResourcePg>[1];

type PlannerDraftResourceRow = {
  id: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  scope: string;
  status: string;
  title: string | null;
  payload_json: Record<string, unknown>;
  summary_json: Record<string, unknown>;
  metrics_json: Record<string, unknown>;
  expires_at: string | null;
};

export type GoalSlicePatchV1 = Partial<Pick<GoalSliceV1,
  | "outcome"
  | "requirementIds"
  | "stateOrArtifactOwner"
  | "mutationBoundary"
  | "expectedArtifactRefs"
  | "evaluatorContractRefs"
  | "dependsOnSliceIds"
  | "dependencyArtifactRefs"
  | "mergeReason"
>>;

/**
 * Durable phases for a Goal Design draft. These are projections over the
 * existing planner_draft runtime resource; they are deliberately not a
 * second workflow engine or table.
 */
export type GoalDesignPhase =
  | "requirements_review"
  | "requirements_confirmed"
  | "validation_resolving"
  | "library_review"
  | "validation_ready"
  | "slice_review"
  | "ready_to_compose"
  | "composing"
  | "dag_validated";

export type GoalRequirementReviewResult = {
  draftId: string;
  status: "requirements_review" | "validation_resolving" | "library_review" | "validation_ready";
  phase: GoalDesignPhase;
  goalPrompt: string;
  goalRequirementDraft: GoalRequirementDraftV1;
  goalRequirementDraftHash: string;
  goalContract?: GoalContractV1;
  goalContractHash?: string;
  blockers: string[];
  invalidated?: {
    validationBindings: boolean;
    slicePlan: boolean;
    dagDraft: boolean;
  };
  validationGaps?: unknown[];
};

export type GoalRequirementContractMetadata = Pick<
  GoalContractV1,
  "domain" | "intent" | "workType" | "expectedArtifactRefs" | "requiredCapabilities" | "assumptions" | "requestedSideEffects"
>;

export type GoalRequirementRevisionInput = {
  draftId: string;
  expectedDraftHash: string;
  requirementId?: string;
  patch: GoalRequirementDraftRevisionPatchV1 | GoalRequirementDraftRevisionOperation;
  actor?: string;
};

export type GoalDesignChatRevisionResult =
  | {
      kind: "revision";
      draftStatus: "ready_for_review";
      package: GoalDesignPackageV1;
      summary: string;
      changedSliceIds: string[];
    }
  | { kind: "needs_input"; question: string };

/** Persist one immutable Requirement Draft revision. */
export async function persistGoalRequirementDraftRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; draft: GoalRequirementDraftV1; actor?: string },
): Promise<void> {
  const issues = validateGoalRequirementDraft(input.draft);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Requirement draft: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
  }
  const resourceKey = `${input.draftId}:revision:${input.draft.revision}`;
  const existing = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'goal_requirement_draft_revision' and resource_key = $1",
    [resourceKey],
  );
  if (existing) {
    const existingDraft = existing.payload_json as unknown as GoalRequirementDraftV1;
    if (existingDraft.draftHash !== input.draft.draftHash) {
      throw new Error(`goal_requirement_revision_conflict: ${resourceKey}`);
    }
    return;
  }
  await upsertRuntimeResourcePg(db, {
    resourceType: "goal_requirement_draft_revision",
    resourceKey,
    scope: "planner",
    status: "persisted",
    title: `Goal Requirement Draft revision ${input.draft.revision}`,
    payload: input.draft,
    summary: {
      draftId: input.draftId,
      revision: input.draft.revision,
      parentRevision: input.draft.parentRevision,
      draftHash: input.draft.draftHash,
      ...(input.actor ? { actor: input.actor } : {}),
      requirementCount: input.draft.requirements.filter((requirement) => requirement.status !== "superseded").length,
    },
  });
}

export async function loadCurrentGoalRequirementDraftPg(
  db: SouthstarDb,
  draftId: string,
): Promise<GoalRequirementDraftV1> {
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
    [draftId],
  );
  const draft = row ? goalRequirementDraftFromStored(row.payload_json.goalRequirementDraft) : undefined;
  if (!draft) throw new Error(`Goal Requirement draft not found: ${draftId}`);
  return draft;
}

/**
 * Create the first durable Requirement Review draft. No Goal Contract,
 * evaluator binding, slice, or Composer work is performed here.
 */
export async function preparePostgresGoalRequirementDraft(
  db: SouthstarDb,
  input: {
    goalPrompt: string;
    cwd: string;
    projectRef?: string;
    mode?: GoalDesignMode;
    templatePolicy?: WorkflowTemplatePolicyV1;
    requirementInterpreter: GoalRequirementDraftInterpreter;
    persistDraft?: PlannerDraftPersistence;
    onProgress?: PlannerDraftProgressListener;
  },
): Promise<GoalRequirementReviewResult> {
  input.onProgress?.({ stage: "request.normalized", message: "Goal Requirement request normalized." });
  const skill = await loadGoalDesignSkillPg(db);
  const workspaceDiscovery = await discoverGoalWorkspace(input.cwd);
  const draft = await input.requirementInterpreter.interpret({
    goalPrompt: input.goalPrompt,
    cwd: input.cwd,
    ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
    workspaceDiscovery,
    goalDesignSkill: skill,
  });
  assertGoalRequirementDraftMatchesRequest(draft, input);
  const draftId = `draft-goal-requirements-${draft.draftHash.slice(0, 12)}`;
  await persistGoalRequirementDraftRevisionPg(db, { draftId, draft });
  await persistPlannerDraftResource(db, {
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "requirements_review",
    title: "Goal Requirements Ready For Review",
    payload: {
      goalRequirementDraft: draft,
      goalRequirementDraftHash: draft.draftHash,
      goalDesignPhase: "requirements_review" satisfies GoalDesignPhase,
      plannerRequest: {
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
        ...(input.mode !== undefined ? { goalDesignMode: input.mode } : {}),
        ...(input.templatePolicy !== undefined ? { templatePolicy: input.templatePolicy } : {}),
      },
      goalDesignSkillRef: skill.objectKey,
      goalDesignSkillVersionRef: skill.versionRef,
      workspaceDiscoveryHash: workspaceDiscovery.discoveryHash,
    },
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: "",
      planner: "goal-design",
      status: "requirements_review",
      goalDesignPhase: "requirements_review" satisfies GoalDesignPhase,
      validationIssues: [],
      taskSummaries: [],
      goalRequirementDraftHash: draft.draftHash,
      requirementCount: draft.requirements.filter((requirement) => requirement.status !== "superseded").length,
      blockers: draft.blockingInputs,
      plannerRequest: {
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
        ...(input.mode !== undefined ? { goalDesignMode: input.mode } : {}),
        ...(input.templatePolicy !== undefined ? { templatePolicy: input.templatePolicy } : {}),
      },
    },
  }, input.persistDraft);
  const result: GoalRequirementReviewResult = {
    draftId,
    status: "requirements_review",
    phase: "requirements_review",
    goalPrompt: input.goalPrompt,
    goalRequirementDraft: draft,
    goalRequirementDraftHash: draft.draftHash,
    blockers: draft.blockingInputs,
  };
  input.onProgress?.({
    stage: "requirements.persisted",
    ok: true,
    issueCount: draft.blockingInputs.length,
    message: "Goal Requirement Draft persisted for review.",
    draftId,
    draftStatus: "requirements_review",
    package: result,
  });
  return result;
}

export async function reviseGoalRequirementPg(
  db: SouthstarDb,
  input: GoalRequirementRevisionInput,
): Promise<GoalRequirementReviewResult> {
  return await db.tx(async (tx) => {
    const row = await tx.maybeOne<PlannerDraftResourceRow>(
      `select id, resource_key, run_id, task_id, session_id, scope, status, title,
              payload_json, summary_json, metrics_json, expires_at
         from southstar.runtime_resources
        where resource_type = 'planner_draft' and resource_key = $1
        for update`,
      [input.draftId],
    );
    if (!row) throw new Error(`planner draft not found: ${input.draftId}`);
    const payload = asRecord(row.payload_json);
    const current = goalRequirementDraftFromStored(payload.goalRequirementDraft);
    if (!current) throw new Error(`Goal Requirement draft not found: ${input.draftId}`);
    if (current.draftHash !== input.expectedDraftHash) {
      throw new Error(`goal_requirement_draft_stale: ${input.draftId}`);
    }
    const phase = goalDesignPhaseFromPayload(payload) ?? "requirements_review";
    if (phase === "dag_validated") throw new Error(`goal_requirements_frozen: ${input.draftId}`);
    await assertNoMaterializedGoalRequirementRunTx(tx, input.draftId);
    const operation = toRequirementRevisionOperation(input);
    const next = reviseGoalRequirementDraft(current, operation);
    await persistGoalRequirementDraftRevisionPg(tx, { draftId: input.draftId, draft: next, actor: input.actor });
    const invalidated = await markRequirementDerivedResourcesStaleTx(tx, {
      draftId: input.draftId,
      oldDraftHash: current.draftHash,
      nextDraftHash: next.draftHash,
    });
    invalidated.validationBindings ||= Boolean(payload.validationBindings || payload.requirementValidationBindings || payload.goalValidationResolution);
    invalidated.slicePlan ||= Boolean(payload.slicePlan || payload.goalDesignPackage || payload.goalDesignPackageHash);
    invalidated.dagDraft ||= Boolean(payload.workflow || payload.workflowManifest || payload.composition);
    const nextPayload = withoutGoalRequirementDerived(payload);
    const updatedPayload = {
      ...nextPayload,
      goalRequirementDraft: next,
      goalRequirementDraftHash: next.draftHash,
      goalDesignPhase: "requirements_review" satisfies GoalDesignPhase,
    };
    const updatedSummary = {
      ...row.summary_json,
      status: "requirements_review",
      goalDesignPhase: "requirements_review" satisfies GoalDesignPhase,
      goalRequirementDraftHash: next.draftHash,
      requirementCount: next.requirements.filter((requirement) => requirement.status !== "superseded").length,
      staleReason: "goal_requirements_revised",
    };
    await upsertRuntimeResourcePg(tx, {
      id: row.id,
      resourceType: "planner_draft",
      resourceKey: input.draftId,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      scope: row.scope,
      status: "requirements_review",
      ...(row.title ? { title: row.title } : {}),
      payload: updatedPayload,
      summary: updatedSummary,
      metrics: row.metrics_json,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    });
    return {
      draftId: input.draftId,
      status: "requirements_review",
      phase: "requirements_review",
      goalPrompt: next.originalPrompt,
      goalRequirementDraft: next,
      goalRequirementDraftHash: next.draftHash,
      blockers: next.blockingInputs,
      invalidated,
    };
  });
}

export async function confirmGoalRequirementsPg(
  db: SouthstarDb,
  input: {
    draftId: string;
    expectedDraftHash: string;
    actor?: string;
    goalInterpreter?: GoalContractInterpreter;
    goalContractMetadata?: GoalRequirementContractMetadata;
  },
): Promise<GoalRequirementReviewResult> {
  return await db.tx(async (tx) => {
    const row = await tx.maybeOne<PlannerDraftResourceRow>(
      `select id, resource_key, run_id, task_id, session_id, scope, status, title,
              payload_json, summary_json, metrics_json, expires_at
         from southstar.runtime_resources
        where resource_type = 'planner_draft' and resource_key = $1
        for update`,
      [input.draftId],
    );
    if (!row) throw new Error(`planner draft not found: ${input.draftId}`);
    const payload = asRecord(row.payload_json);
    const current = goalRequirementDraftFromStored(payload.goalRequirementDraft);
    if (!current) throw new Error(`Goal Requirement draft not found: ${input.draftId}`);
    if (current.draftHash !== input.expectedDraftHash) {
      throw new Error(`goal_requirement_draft_stale: ${input.draftId}`);
    }
    const phase = goalDesignPhaseFromPayload(payload) ?? "requirements_review";
    const existingContract = storedGoalContract(payload.goalContract);
    if (existingContract && ["validation_resolving", "library_review", "validation_ready"].includes(phase)) {
      return {
        draftId: input.draftId,
        status: phase as GoalRequirementReviewResult["status"],
        phase,
        goalPrompt: current.originalPrompt,
        goalRequirementDraft: current,
        goalRequirementDraftHash: current.draftHash,
        goalContract: existingContract,
        goalContractHash: goalContractHash(existingContract),
        blockers: current.blockingInputs,
        ...(Array.isArray(payload.validationGaps) ? { validationGaps: payload.validationGaps } : {}),
      };
    }
    if (phase !== "requirements_review" && phase !== "requirements_confirmed") {
      throw new Error(`goal requirements cannot be confirmed in phase ${phase}: ${input.draftId}`);
    }
    const metadata = await resolveGoalRequirementContractMetadata(tx, current, payload, input);
    const contract = confirmGoalRequirementDraft(current, metadata);
    const contractHash = goalContractHash(contract);
    await upsertRuntimeResourcePg(tx, {
      resourceType: "goal_contract_confirmation",
      resourceKey: input.draftId,
      scope: "planner",
      status: "persisted",
      title: "Goal Contract Confirmed",
      payload: {
        draftId: input.draftId,
        actor: input.actor ?? "user",
        goalRequirementDraftHash: current.draftHash,
        goalContract: contract,
        goalContractHash: contractHash,
        goalDesignPhase: "validation_resolving" satisfies GoalDesignPhase,
      },
      summary: {
        draftId: input.draftId,
        goalContractHash: contractHash,
        goalRequirementDraftHash: current.draftHash,
        goalDesignPhase: "validation_resolving" satisfies GoalDesignPhase,
      },
    });
    const updatedPayload = {
      ...payload,
      goalContract: contract,
      goalContractHash: contractHash,
      goalRequirementDraftHash: current.draftHash,
      goalDesignPhase: "validation_resolving" satisfies GoalDesignPhase,
      requirementConfirmation: {
        actor: input.actor ?? "user",
        confirmedAt: new Date().toISOString(),
        draftHash: current.draftHash,
      },
    };
    const updatedSummary = {
      ...row.summary_json,
      status: "validation_resolving",
      goalDesignPhase: "validation_resolving" satisfies GoalDesignPhase,
      goalContractHash: contractHash,
      goalRequirementDraftHash: current.draftHash,
    };
    await upsertRuntimeResourcePg(tx, {
      id: row.id,
      resourceType: "planner_draft",
      resourceKey: input.draftId,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      scope: row.scope,
      status: "validation_resolving",
      ...(row.title ? { title: row.title } : {}),
      payload: updatedPayload,
      summary: updatedSummary,
      metrics: row.metrics_json,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    });
    return {
      draftId: input.draftId,
      status: "validation_resolving",
      phase: "validation_resolving",
      goalPrompt: current.originalPrompt,
      goalRequirementDraft: current,
      goalRequirementDraftHash: current.draftHash,
      goalContract: contract,
      goalContractHash: contractHash,
      blockers: current.blockingInputs,
    };
  });
}

export async function persistGoalDesignPackageRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; package: GoalDesignPackageV1 },
): Promise<void> {
  const resourceKey = `${input.draftId}:revision:${input.package.revision}`;
  const existing = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'goal_design_package_revision' and resource_key = $1",
    [resourceKey],
  );
  const existingPackageHash = packageHashFromPayload(existing?.payload_json);
  if (existingPackageHash) {
    if (existingPackageHash !== input.package.packageHash) {
      throw new Error(`goal_design_revision_conflict: ${resourceKey}`);
    }
    return;
  }
  const issues = validateGoalDesignPackage(input.package);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Design package: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
  }
  await upsertRuntimeResourcePg(db, {
    resourceType: "goal_design_package_revision",
    resourceKey,
    scope: "planner",
    status: "persisted",
    title: `Goal Design Revision ${input.package.revision}`,
    payload: {
      draftId: input.draftId,
      goalDesignPackage: input.package,
      packageHash: input.package.packageHash,
    },
    summary: {
      draftId: input.draftId,
      revision: input.package.revision,
      parentRevision: input.package.parentRevision,
      goalContractHash: input.package.goalContractHash,
      packageHash: input.package.packageHash,
      mode: input.package.mode,
      templatePolicy: input.package.templatePolicy,
      sliceCount: input.package.slicePlan.slices.length,
    },
  });
}

export async function loadCurrentGoalDesignPackagePg(
  db: SouthstarDb,
  draftId: string,
): Promise<GoalDesignPackageV1> {
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
    [draftId],
  );
  const pkg = goalDesignPackageFromStored(row?.payload_json.goalDesignPackage);
  if (!pkg) throw new Error(`Goal Design package not found: ${draftId}`);
  return pkg;
}

export async function isReviewableGoalDesignDraftPg(
  db: SouthstarDb,
  draftId: string,
): Promise<boolean> {
  const row = await db.maybeOne<{ status: string; payload_json: Record<string, unknown> }>(
    "select status, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
    [draftId],
  );
  return row?.status === "ready_for_review" && Boolean(goalDesignPackageFromStored(row.payload_json.goalDesignPackage));
}

export async function isGoalDesignVocabularyGapDraftPg(db: SouthstarDb, draftId: string): Promise<boolean> {
  const row = await db.maybeOne<{ status: string }>(
    "select status from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
    [draftId],
  );
  return row?.status === "needs_library_input";
}

export async function retryPostgresGoalDesignAfterVocabularyApprovalPg(
  db: SouthstarDb,
  input: {
    draftId: string;
    goalInterpreter: GoalContractInterpreter;
    goalDesigner: GoalDesigner;
    libraryImportLlmProvider?: LibraryImportLlmProvider;
    libraryImportSourceFetcher?: LibraryImportSourceFetcher;
    onProgress?: PlannerDraftProgressListener;
  },
): Promise<PostgresPlannerDraftResult> {
  const row = await db.maybeOne<{ status: string; payload_json: Record<string, unknown> }>(
    "select status, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
    [input.draftId],
  );
  if (!row) throw new Error(`planner draft not found: ${input.draftId}`);
  if (row.status !== "needs_library_input") throw new Error(`planner draft does not need Library input: ${input.draftId}`);
  const plannerRequest = row.payload_json.plannerRequest;
  if (!plannerRequest || typeof plannerRequest !== "object" || Array.isArray(plannerRequest)) {
    throw new Error(`planner draft request is missing: ${input.draftId}`);
  }
  const request = plannerRequest as Record<string, unknown>;
  const goalPrompt = typeof request.goalPrompt === "string" ? request.goalPrompt : undefined;
  const cwd = typeof request.cwd === "string" ? request.cwd : undefined;
  const mode = request.goalDesignMode === "auto_until_blocked" ? "auto_until_blocked" : "review_before_compose";
  const templatePolicy = request.templatePolicy as WorkflowTemplatePolicyV1 | undefined;
  if (!goalPrompt || !cwd || !templatePolicy) throw new Error(`planner draft request is incomplete: ${input.draftId}`);
  return await preparePostgresGoalDesignDraft(db, {
    goalPrompt,
    cwd,
    mode,
    templatePolicy,
    goalInterpreter: input.goalInterpreter,
    goalDesigner: input.goalDesigner,
    libraryImportLlmProvider: input.libraryImportLlmProvider,
    libraryImportSourceFetcher: input.libraryImportSourceFetcher,
    onProgress: input.onProgress,
  });
}

export async function reviseGoalSlicePg(
  db: SouthstarDb,
  input: { draftId: string; sliceId: string; expectedPackageHash: string; patch: GoalSlicePatchV1 },
): Promise<GoalDesignPackageV1> {
  return await persistValidatedGoalDesignRevisionPg(db, {
    draftId: input.draftId,
    expectedPackageHash: input.expectedPackageHash,
    buildNext(current) {
      const sliceIndex = current.slicePlan.slices.findIndex((slice) => slice.id === input.sliceId);
      if (sliceIndex < 0) throw new Error(`goal_design_slice_not_found: ${input.sliceId}`);
      const nextRevision = current.revision + 1;
      const slices = current.slicePlan.slices.map((slice, index) => (
        index === sliceIndex ? { ...slice, ...input.patch } : slice
      ));
      return finalizeGoalDesignPackage({
        schemaVersion: "southstar.goal_design_package.v1",
        revision: nextRevision,
        parentRevision: current.revision,
        goalContract: current.goalContract,
        evaluatorContracts: current.evaluatorContracts,
        slicePlan: {
          ...current.slicePlan,
          revision: nextRevision,
          slices,
        },
        compositionStrategy: current.compositionStrategy,
        templatePolicy: current.templatePolicy,
        goalDesignSkillRef: current.goalDesignSkillRef,
        goalDesignSkillVersionRef: current.goalDesignSkillVersionRef,
        workspaceDiscoveryHash: current.workspaceDiscoveryHash,
        mode: current.mode,
      });
    },
  });
}

export async function reviseGoalTemplatePolicyPg(
  db: SouthstarDb,
  input: { draftId: string; expectedPackageHash: string; templatePolicy: WorkflowTemplatePolicyV1 },
): Promise<GoalDesignPackageV1> {
  return await persistValidatedGoalDesignRevisionPg(db, {
    draftId: input.draftId,
    expectedPackageHash: input.expectedPackageHash,
    buildNext(current) {
      const nextRevision = current.revision + 1;
      return finalizeGoalDesignPackage({
        schemaVersion: "southstar.goal_design_package.v1",
        revision: nextRevision,
        parentRevision: current.revision,
        goalContract: current.goalContract,
        evaluatorContracts: current.evaluatorContracts,
        slicePlan: current.slicePlan,
        compositionStrategy: current.compositionStrategy,
        templatePolicy: input.templatePolicy,
        goalDesignSkillRef: current.goalDesignSkillRef,
        goalDesignSkillVersionRef: current.goalDesignSkillVersionRef,
        workspaceDiscoveryHash: current.workspaceDiscoveryHash,
        mode: current.mode,
      });
    },
  });
}

export async function reviseGoalDesignFromChatPg(
  context: SubmitGoalContext,
  input: {
    draftId: string;
    expectedPackageHash: string;
    message: string;
    selectedSliceId?: string;
  },
): Promise<GoalDesignChatRevisionResult> {
  const designer = context.goalDesigner;
  if (!designer) throw new Error("Goal Design revision requires a goal designer");
  const current = await loadCurrentGoalDesignPackagePg(context.db, input.draftId);
  if (current.packageHash !== input.expectedPackageHash) {
    throw new Error(`goal_design_package_stale: ${input.draftId}`);
  }
  const proposal = await designer.revise({
    currentPackage: current,
    message: input.message,
    ...(input.selectedSliceId ? { selectedSliceId: input.selectedSliceId } : {}),
  });
  if (proposal.kind === "needs_input") return proposal;
  const next = await persistValidatedGoalDesignRevisionPg(context.db, {
    draftId: input.draftId,
    expectedPackageHash: input.expectedPackageHash,
    buildNext(lockedCurrent) {
      const nextRevision = lockedCurrent.revision + 1;
      return finalizeGoalDesignPackage({
        schemaVersion: "southstar.goal_design_package.v1",
        revision: nextRevision,
        parentRevision: lockedCurrent.revision,
        goalContract: lockedCurrent.goalContract,
        evaluatorContracts: proposal.package.evaluatorContracts,
        slicePlan: {
          schemaVersion: "southstar.goal_slice_plan.v1",
          goalContractHash: "host-filled",
          revision: nextRevision,
          slices: proposal.package.slicePlan.slices,
        },
        compositionStrategy: proposal.package.compositionStrategy,
        templatePolicy: lockedCurrent.templatePolicy,
        goalDesignSkillRef: lockedCurrent.goalDesignSkillRef,
        goalDesignSkillVersionRef: lockedCurrent.goalDesignSkillVersionRef,
        workspaceDiscoveryHash: lockedCurrent.workspaceDiscoveryHash,
        mode: lockedCurrent.mode,
      });
    },
  });
  return {
    kind: "revision",
    draftStatus: "ready_for_review",
    package: next,
    summary: proposal.summary,
    changedSliceIds: changedSliceIds(current, next, proposal.changedSliceIds),
  };
}

async function persistValidatedGoalDesignRevisionPg(
  db: SouthstarDb,
  input: {
    draftId: string;
    expectedPackageHash: string;
    buildNext: (current: GoalDesignPackageV1) => GoalDesignPackageV1;
  },
): Promise<GoalDesignPackageV1> {
  return await db.tx(async (tx) => {
    const draft = await tx.one<PlannerDraftResourceRow>(
      `select id, resource_key, run_id, task_id, session_id, scope, status, title,
              payload_json, summary_json, metrics_json, expires_at
         from southstar.runtime_resources
        where resource_type = 'planner_draft'
          and resource_key = $1
        for update`,
      [input.draftId],
    );
    if (draft.status !== "ready_for_review") {
      throw new Error(`goal design draft is not ready for review: ${input.draftId}`);
    }
    const current = goalDesignPackageFromStored(draft.payload_json.goalDesignPackage);
    if (!current) throw new Error(`Goal Design package not found: ${input.draftId}`);
    if (current.packageHash !== input.expectedPackageHash) {
      throw new Error(`goal_design_package_stale: ${input.draftId}`);
    }
    await assertNoMaterializedGoalDesignRunTx(tx, input.draftId, current.packageHash);
    const next = input.buildNext(current);
    const issues = validateGoalDesignPackage(next);
    if (issues.length > 0) {
      throw new Error(`invalid Goal Design package: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
    }
    await persistGoalDesignPackageRevisionPg(tx, { draftId: input.draftId, package: next });
    await markPriorGoalDesignResourcesStaleTx(tx, {
      draftId: input.draftId,
      oldPackageHash: current.packageHash,
      nextPackageHash: next.packageHash,
    });
    await upsertRuntimeResourcePg(tx, {
      id: draft.id,
      resourceType: "planner_draft",
      resourceKey: input.draftId,
      ...(draft.run_id ? { runId: draft.run_id } : {}),
      ...(draft.task_id ? { taskId: draft.task_id } : {}),
      ...(draft.session_id ? { sessionId: draft.session_id } : {}),
      scope: draft.scope,
      status: "ready_for_review",
      ...(draft.title ? { title: draft.title } : {}),
      payload: {
        ...draft.payload_json,
        goalContract: next.goalContract,
        goalContractHash: next.goalContractHash,
        goalDesignPackage: next,
        goalDesignPackageHash: next.packageHash,
      },
      summary: {
        ...draft.summary_json,
        status: "ready_for_review",
        validationIssues: [],
        taskSummaries: [],
        goalContractHash: next.goalContractHash,
        goalDesignPackageHash: next.packageHash,
        sliceCount: next.slicePlan.slices.length,
        templatePolicy: next.templatePolicy,
      },
      metrics: draft.metrics_json,
      ...(draft.expires_at ? { expiresAt: draft.expires_at } : {}),
    });
    return next;
  });
}

async function assertNoMaterializedGoalDesignRunTx(
  db: SouthstarDb,
  draftId: string,
  packageHash: string,
): Promise<void> {
  const confirmation = await db.maybeOne<{ run_id: string | null }>(
    `select nullif(payload_json #>> '{result,runId}', '') as run_id
       from southstar.runtime_resources
      where resource_type = 'goal_design_confirmation'
        and resource_key = $1
        and status = 'completed'
        and payload_json->>'packageHash' = $2
        and nullif(payload_json #>> '{result,runId}', '') is not null
      limit 1`,
    [draftId, packageHash],
  );
  if (confirmation?.run_id) throw new Error(`goal_design_already_materialized: ${draftId}`);
  const materialized = await db.maybeOne<{ run_id: string }>(
    `select wr.id as run_id
       from southstar.runtime_resources pd
       join southstar.workflow_runs wr
         on wr.runtime_context_json->>'draftId' = pd.resource_key
      where pd.resource_type = 'planner_draft'
        and pd.payload_json->>'goalDesignPackageHash' = $1
      limit 1`,
    [packageHash],
  );
  if (materialized) throw new Error(`goal_design_already_materialized: ${draftId}`);
}

async function markPriorGoalDesignResourcesStaleTx(
  db: SouthstarDb,
  input: { draftId: string; oldPackageHash: string; nextPackageHash: string },
): Promise<void> {
  const stalePayload = {
    staleReason: "goal_design_revised",
    supersededByPackageHash: input.nextPackageHash,
    staleAt: new Date().toISOString(),
  };
  await db.query(
    `update southstar.runtime_resources
        set status = 'stale',
            payload_json = payload_json || $3::jsonb,
            summary_json = summary_json || $3::jsonb,
            updated_at = now()
      where resource_type = 'goal_design_confirmation'
        and resource_key = $1
        and payload_json->>'packageHash' = $2
        and status <> 'stale'`,
    [input.draftId, input.oldPackageHash, JSON.stringify(stalePayload)],
  );
  await db.query(
    `update southstar.runtime_resources pd
        set status = 'stale',
            payload_json = pd.payload_json || $3::jsonb,
            summary_json = pd.summary_json || $3::jsonb,
            updated_at = now()
      where pd.resource_type = 'planner_draft'
        and pd.resource_key <> $1
        and pd.payload_json->>'goalDesignPackageHash' = $2
        and pd.status <> 'stale'
        and not exists (
          select 1
            from southstar.workflow_runs wr
           where wr.runtime_context_json->>'draftId' = pd.resource_key
        )`,
    [input.draftId, input.oldPackageHash, JSON.stringify(stalePayload)],
  );
}

function changedSliceIds(
  before: GoalDesignPackageV1,
  after: GoalDesignPackageV1,
  proposed: string[],
): string[] {
  const beforeById = new Map(before.slicePlan.slices.map((slice) => [slice.id, JSON.stringify(slice)]));
  const afterById = new Map(after.slicePlan.slices.map((slice) => [slice.id, JSON.stringify(slice)]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys(), ...proposed]);
  return [...ids].filter((id) => beforeById.get(id) !== afterById.get(id)).sort();
}

export async function preparePostgresGoalDesignDraft(
  db: SouthstarDb,
  input: {
    goalPrompt: string;
    cwd: string;
    mode: GoalDesignMode;
    templatePolicy: WorkflowTemplatePolicyV1;
    goalInterpreter: GoalContractInterpreter;
    goalDesigner: GoalDesigner;
    libraryImportLlmProvider?: LibraryImportLlmProvider;
    libraryImportSourceFetcher?: LibraryImportSourceFetcher;
    persistDraft?: PlannerDraftPersistence;
    onProgress?: PlannerDraftProgressListener;
  },
): Promise<PostgresPlannerDraftResult> {
  input.onProgress?.({ stage: "request.normalized", message: "Goal Design request normalized." });
  const skill = await loadGoalDesignSkillPg(db);
  const workspaceDiscovery = await discoverGoalWorkspace(input.cwd);
  const libraryVocabulary = await loadGoalContractLibraryVocabularyPg(db);
  let goalContract: GoalContractV1;
  try {
    goalContract = await input.goalInterpreter.interpret({
      goalPrompt: input.goalPrompt,
      cwd: input.cwd,
      libraryVocabulary,
      goalDesignSkill: skill,
      workspaceDiscovery,
    });
  } catch (error) {
    if (!(error instanceof GoalContractVocabularyGapError)) throw error;
    const plannerRequest = {
      goalPrompt: input.goalPrompt,
      cwd: input.cwd,
      goalDesignMode: input.mode,
      templatePolicy: input.templatePolicy,
    };
    let libraryImportDraftId: string | undefined;
    if (input.mode === "auto_until_blocked" && input.libraryImportLlmProvider) {
      const importDraft = await createLibraryImportDraft(db, {
        source: {
          kind: "paste",
          label: "Goal vocabulary gaps",
          content: input.goalPrompt,
        },
        scope: error.goalContract.domain,
        requestPrompt: [
          "Create Library candidates only for these unresolved Goal vocabulary gaps.",
          JSON.stringify(error.gaps),
          `Goal: ${input.goalPrompt}`,
        ].join("\n"),
        llmProvider: input.libraryImportLlmProvider,
        sourceFetcher: input.libraryImportSourceFetcher,
      });
      libraryImportDraftId = importDraft.draftId;
    }
    return await persistGoalContractVocabularyGapDraftPg(db, {
      plannerRequest,
      error,
      ...(libraryImportDraftId ? { libraryImportDraftId } : {}),
      onProgress: input.onProgress,
      persistDraft: input.persistDraft,
    });
  }
  const contractHash = goalContractHash(goalContract);
  input.onProgress?.({ stage: "goal_contract.interpreted", message: "Goal Contract interpreted." });
  if (goalContract.blockingInputs.length > 0) {
    return await persistGoalContractOnlyDraft(db, {
      goalPrompt: input.goalPrompt,
      cwd: input.cwd,
      goalContract,
      goalContractHash: contractHash,
      skill,
      workspaceDiscoveryHash: workspaceDiscovery.discoveryHash,
      persistDraft: input.persistDraft,
      onProgress: input.onProgress,
    });
  }

  const pkg = await input.goalDesigner.design({
    goalContract,
    workspaceDiscovery,
    mode: input.mode,
    templatePolicy: input.templatePolicy,
    skill,
  });
  const issues = validateGoalDesignPackage(pkg);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Design package: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
  }
  const draftId = `draft-goal-design-${pkg.packageHash.slice(0, 12)}`;
  await persistGoalDesignPackageRevisionPg(db, { draftId, package: pkg });
  await persistPlannerDraftResource(db, {
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "ready_for_review",
    title: "Goal Design Ready For Review",
    payload: {
      goalContract,
      goalContractHash: contractHash,
      goalDesignPackage: pkg,
      goalDesignPackageHash: pkg.packageHash,
      plannerRequest: {
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        goalDesignMode: input.mode,
        templatePolicy: input.templatePolicy,
      },
      goalDesignSkillRef: skill.objectKey,
      goalDesignSkillVersionRef: skill.versionRef,
      workspaceDiscoveryHash: workspaceDiscovery.discoveryHash,
    },
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: "",
      planner: "goal-design",
      status: "ready_for_review",
      validationIssues: [],
      taskSummaries: [],
      goalContractHash: contractHash,
      goalDesignPackageHash: pkg.packageHash,
      domain: goalContract.domain,
      intent: goalContract.intent,
      blockers: [],
      requirementCount: goalContract.requirements.length,
      sliceCount: pkg.slicePlan.slices.length,
      plannerRequest: {
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        goalDesignMode: input.mode,
        templatePolicy: input.templatePolicy,
      },
    },
  }, input.persistDraft);
  input.onProgress?.({
    stage: "goal_design.persisted",
    ok: true,
    issueCount: 0,
    message: "Goal Design package persisted.",
    draftId,
    draftStatus: "ready_for_review",
    goalDesignPackageHash: pkg.packageHash,
    package: pkg,
  });
  return {
    draftId,
    goalPrompt: input.goalPrompt,
    workflowId: "",
    status: "ready_for_review",
    goalContractHash: contractHash,
    goalDesignPackageHash: pkg.packageHash,
    goalDesignPackage: pkg,
    blockers: [],
    validationIssues: [],
    taskSummaries: [],
  } as PostgresPlannerDraftResult;
}

async function persistGoalContractOnlyDraft(
  db: SouthstarDb,
  input: {
    goalPrompt: string;
    cwd: string;
    goalContract: GoalContractV1;
    goalContractHash: string;
    skill: { objectKey: string; versionRef: string };
    workspaceDiscoveryHash: string;
    persistDraft?: PlannerDraftPersistence;
    onProgress?: PlannerDraftProgressListener;
  },
): Promise<PostgresPlannerDraftResult> {
  const draftId = `draft-goal-${input.goalContractHash.slice(0, 12)}`;
  const blockers = [...input.goalContract.blockingInputs];
  await persistPlannerDraftResource(db, {
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "needs_input",
    title: "Planner Draft Needs Input",
    payload: {
      goalContract: input.goalContract,
      goalContractHash: input.goalContractHash,
      plannerRequest: { goalPrompt: input.goalPrompt, cwd: input.cwd },
      goalDesignSkillRef: input.skill.objectKey,
      goalDesignSkillVersionRef: input.skill.versionRef,
      workspaceDiscoveryHash: input.workspaceDiscoveryHash,
    },
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: "",
      planner: "goal-design",
      status: "needs_input",
      validationIssues: [],
      taskSummaries: [],
      goalContractHash: input.goalContractHash,
      domain: input.goalContract.domain,
      intent: input.goalContract.intent,
      blockers,
      requirementCount: input.goalContract.requirements.length,
    },
  }, input.persistDraft);
  input.onProgress?.({ stage: "draft.persisted", ok: false, issueCount: blockers.length, message: "Planner draft needs input." });
  return {
    draftId,
    goalPrompt: input.goalPrompt,
    workflowId: "",
    status: "needs_input",
    goalContractHash: input.goalContractHash,
    blockers,
    validationIssues: [],
    taskSummaries: [],
  };
}

async function persistPlannerDraftResource(
  db: SouthstarDb,
  resource: RuntimeResourceUpsertInput,
  persistDraft?: PlannerDraftPersistence,
): Promise<void> {
  if (persistDraft) return await persistDraft(resource);
  await upsertRuntimeResourcePg(db, resource);
}

function goalRequirementDraftFromStored(value: unknown): GoalRequirementDraftV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const draft = value as GoalRequirementDraftV1;
  return validateGoalRequirementDraft(draft).length === 0 ? draft : undefined;
}

function goalDesignPhaseFromPayload(payload: Record<string, unknown>): GoalDesignPhase | undefined {
  const value = payload.goalDesignPhase;
  return typeof value === "string" && GOAL_DESIGN_PHASES.has(value as GoalDesignPhase)
    ? value as GoalDesignPhase
    : undefined;
}

function assertGoalRequirementDraftMatchesRequest(
  draft: GoalRequirementDraftV1,
  input: { goalPrompt: string; cwd: string; projectRef?: string },
): void {
  const issues = validateGoalRequirementDraft(draft);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Requirement draft: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
  }
  if (draft.originalPrompt !== input.goalPrompt || draft.workspace.cwd !== input.cwd || draft.workspace.projectRef !== input.projectRef) {
    throw new Error("Goal Requirement interpreter returned a draft with host-owned workspace or prompt fields that do not match the request");
  }
  if (draft.revision !== 1 || draft.parentRevision !== undefined) {
    throw new Error("initial Goal Requirement draft must start at revision 1 without parentRevision");
  }
}

function toRequirementRevisionOperation(input: GoalRequirementRevisionInput): GoalRequirementDraftRevisionOperation {
  if (isRequirementRevisionOperation(input.patch)) return input.patch;
  if (!input.requirementId) throw new Error("requirementId is required for a requirement patch");
  return { kind: "update", requirementId: input.requirementId, patch: input.patch };
}

function isRequirementRevisionOperation(
  value: GoalRequirementRevisionInput["patch"],
): value is GoalRequirementDraftRevisionOperation {
  return typeof value === "object" && value !== null && "kind" in value;
}

function withoutGoalRequirementDerived(payload: Record<string, unknown>): Record<string, unknown> {
  const {
    goalContract: _goalContract,
    goalContractHash: _goalContractHash,
    goalDesignPackage: _goalDesignPackage,
    goalDesignPackageHash: _goalDesignPackageHash,
    validationBindings: _validationBindings,
    goalRequirementCoverage: _goalRequirementCoverage,
    requirementValidationBindings: _requirementValidationBindings,
    ...rest
  } = payload;
  return rest;
}

async function assertNoMaterializedGoalRequirementRunTx(db: SouthstarDb, draftId: string): Promise<void> {
  const materialized = await db.maybeOne<{ id: string }>(
    `select wr.id
       from southstar.workflow_runs wr
      where wr.runtime_context_json->>'draftId' = $1
      limit 1`,
    [draftId],
  );
  if (materialized) throw new Error(`goal_requirements_already_materialized: ${draftId}`);
}

async function markRequirementDerivedResourcesStaleTx(
  db: SouthstarDb,
  input: { draftId: string; oldDraftHash: string; nextDraftHash: string },
): Promise<{ validationBindings: boolean; slicePlan: boolean; dagDraft: boolean }> {
  const stalePayload = JSON.stringify({
    staleReason: "goal_requirements_revised",
    supersededByDraftHash: input.nextDraftHash,
    staleAt: new Date().toISOString(),
  });
  const bindings = await db.query(
    `update southstar.runtime_resources
        set status = 'stale', payload_json = payload_json || $2::jsonb,
            summary_json = summary_json || $2::jsonb, updated_at = now()
      where resource_type in ('goal_contract_confirmation', 'goal_validation_resolution', 'goal_requirement_validation_binding')
        and (resource_key = $1 or payload_json->>'draftId' = $1)
        and status <> 'stale'`,
    [input.draftId, stalePayload],
  );
  const slices = await db.query(
    `update southstar.runtime_resources
        set status = 'stale', payload_json = payload_json || $2::jsonb,
            summary_json = summary_json || $2::jsonb, updated_at = now()
      where resource_type in ('goal_design_package_revision', 'goal_design_confirmation', 'goal_slice_plan')
        and (resource_key = $1 or payload_json->>'draftId' = $1)
        and status <> 'stale'`,
    [input.draftId, stalePayload],
  );
  const dagDrafts = await db.query(
    `update southstar.runtime_resources pd
        set status = 'stale', payload_json = pd.payload_json || $2::jsonb,
            summary_json = pd.summary_json || $2::jsonb, updated_at = now()
      where pd.resource_type = 'planner_draft'
        and pd.resource_key <> $1
        and (
          pd.payload_json->>'draftId' = $1
          or pd.payload_json->>'goalRequirementDraftHash' = $3
          or pd.payload_json->>'goalDesignPackageHash' is not null
             and pd.payload_json->'plannerRequest'->>'draftId' = $1
        )
        and pd.status <> 'stale'
        and not exists (
          select 1 from southstar.workflow_runs wr
           where wr.runtime_context_json->>'draftId' = pd.resource_key
        )`,
    [input.draftId, stalePayload, input.oldDraftHash],
  );
  return {
    validationBindings: (bindings.rowCount ?? 0) > 0,
    slicePlan: (slices.rowCount ?? 0) > 0,
    dagDraft: (dagDrafts.rowCount ?? 0) > 0,
  };
}

async function resolveGoalRequirementContractMetadata(
  db: SouthstarDb,
  draft: GoalRequirementDraftV1,
  payload: Record<string, unknown>,
  input: {
    goalInterpreter?: GoalContractInterpreter;
    goalContractMetadata?: GoalRequirementContractMetadata;
  },
): Promise<GoalRequirementContractMetadata> {
  if (input.goalContractMetadata) return input.goalContractMetadata;
  const stored = storedGoalContract(payload.goalContract);
  if (stored) return contractMetadata(stored);
  if (input.goalInterpreter) {
    const skill = await loadGoalDesignSkillPg(db);
    const workspaceDiscovery = await discoverGoalWorkspace(draft.workspace.cwd);
    try {
      const interpreted = await input.goalInterpreter.interpret({
        goalPrompt: draft.originalPrompt,
        cwd: draft.workspace.cwd,
        ...(draft.workspace.projectRef !== undefined ? { projectRef: draft.workspace.projectRef } : {}),
        libraryVocabulary: await loadGoalContractLibraryVocabularyPg(db),
        goalDesignSkill: skill,
        workspaceDiscovery,
      });
      return contractMetadata(interpreted);
    } catch (error) {
      if (error instanceof GoalContractVocabularyGapError) return contractMetadata(error.goalContract);
      throw error;
    }
  }
  return {
    domain: "general",
    intent: "goal_execution",
    workType: "general",
    expectedArtifactRefs: [],
    requiredCapabilities: [],
    assumptions: [...new Set(draft.requirements.flatMap((requirement) => requirement.assumptions))],
    requestedSideEffects: [],
  };
}

function contractMetadata(contract: GoalContractV1): GoalRequirementContractMetadata {
  return {
    domain: contract.domain,
    intent: contract.intent,
    workType: contract.workType,
    expectedArtifactRefs: [...contract.expectedArtifactRefs],
    requiredCapabilities: [...contract.requiredCapabilities],
    assumptions: [...contract.assumptions],
    requestedSideEffects: [...contract.requestedSideEffects],
  };
}

const GOAL_DESIGN_PHASES = new Set<GoalDesignPhase>([
  "requirements_review",
  "requirements_confirmed",
  "validation_resolving",
  "library_review",
  "validation_ready",
  "slice_review",
  "ready_to_compose",
  "composing",
  "dag_validated",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function goalDesignPackageFromStored(value: unknown): GoalDesignPackageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pkg = value as GoalDesignPackageV1;
  return validateGoalDesignPackage(pkg).length === 0 ? pkg : undefined;
}

function packageHashFromPayload(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.packageHash === "string") return record.packageHash;
  const nested = record.goalDesignPackage;
  return nested && typeof nested === "object" && !Array.isArray(nested) && typeof (nested as { packageHash?: unknown }).packageHash === "string"
    ? (nested as { packageHash: string }).packageHash
    : undefined;
}
