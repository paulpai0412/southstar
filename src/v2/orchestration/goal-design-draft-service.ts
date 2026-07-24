import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import {
  upsertRuntimeResourcePg,
  insertRuntimeResourceIfAbsentPg,
} from "../stores/postgres-runtime-store.ts";
import {
  finalizeGoalDesignPackageV3,
  goalDesignPackageV3FromUnknown,
  loadGoalDesignSkillPg,
  validateGoalDesignPackageV3,
  type GoalDesignPackage,
  type GoalDesignMode,
  type GoalDesignPackageV3,
  type GoalSliceDesigner,
  type GoalSliceV1,
  type WorkflowTemplatePolicyV1,
} from "./goal-design.ts";
import {
  loadCanonicalGoalDesignPackagePg,
  persistIncompatibleGoalDesignDraftPg,
  throwCanonicalGoalDesignDraftRejection,
  type CanonicalGoalDesignDraftRejection,
} from "./canonical-goal-design-draft.ts";
import {
  GoalContractVocabularyGapError,
  goalContractHash,
  storedGoalContract,
  type GoalContractInterpreter,
  type GoalContractV1,
} from "./goal-contract.ts";
import {
  confirmGoalRequirementDraft,
  goalRequirementDraftReadiness,
  reviseGoalRequirementDraft,
  validateGoalRequirementDraft,
  validateGoalRequirementDraftForRevision,
  type GoalRequirementDraftInterpreter,
  type GoalRequirementDraftIssue,
  type GoalRequirementDraftRevisionOperation,
  type GoalRequirementDraftRevisionPatchV1,
  type GoalRequirementDraftV1,
} from "./goal-requirement-draft.ts";
import {
  finalizeUiInteractionContract,
  persistUiInteractionContractRevisionPg,
  reviseUiInteractionContract,
  validateUiInteractionContract,
  type UiInteractionContractInputV1,
  type UiInteractionContractIssue,
  type UiInteractionContractRevisionOperation,
  type UiInteractionContractV1,
} from "./ui-interaction-contract.ts";
import type { SubmitGoalContext } from "./run-goal-service.ts";
import { discoverGoalWorkspace } from "./goal-workspace-discovery.ts";
import type {
  AssuranceRiskAcceptanceV1,
  GoalValidationResolutionV2,
  RequirementValidationMode,
} from "../design-library/types.ts";
import type {
  PlannerDraftPersistence,
  PlannerDraftProgressListener,
} from "../ui-api/postgres-run-api.ts";
import {
  loadGoalContractLibraryVocabularyPg,
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

type CanonicalDraftTransactionResult<T> =
  | { kind: "accepted"; value: T }
  | { kind: "incompatible"; rejection: CanonicalGoalDesignDraftRejection };

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
  goalRequirementDraftId?: string;
  goalRequirementDraft: GoalRequirementDraftV1;
  goalRequirementDraftHash: string;
  confirmable: boolean;
  validationIssues: GoalRequirementReviewIssue[];
  uiInteractionContracts?: UiInteractionContractV1[];
  goalContract?: GoalContractV1;
  goalContractHash?: string;
  blockers: string[];
  invalidated?: {
    validationBindings: boolean;
    slicePlan: boolean;
    dagDraft: boolean;
    evidence: boolean;
    evaluation: boolean;
  };
  validationGaps?: unknown[];
};

export type GoalRequirementReviewIssue = GoalRequirementDraftIssue | UiInteractionContractIssue | {
  code: "missing_ui_interaction_contract" | "unconfirmed_ui_interaction_contract";
  path: string;
  message: string;
};

export type UiInteractionContractRevisionInput = {
  draftId: string;
  contractId: string;
  expectedContractHash?: string;
  contract?: UiInteractionContractInputV1;
  patch?: UiInteractionContractRevisionOperation;
  actor?: string;
};

export type GoalSliceReviewResult = {
  draftId: string;
  status: "ready_for_review";
  phase: "slice_review";
  goalPrompt: string;
  goalRequirementDraftId: string;
  goalRequirementDraft: GoalRequirementDraftV1;
  goalRequirementDraftHash: string;
  goalContract: GoalContractV1;
  goalContractHash: string;
  goalDesignPackage: GoalDesignPackage;
  goalDesignPackageHash: string;
  blockers: string[];
};

export type StagedGoalSliceRevisionResult = GoalSliceReviewResult & {
  parentDraftId: string;
  parentPackageHash: string;
  sourcePhase: "dag_validated";
};

/**
 * Fork a frozen, already-composed Goal Design into a new staged Slice review.
 * The parent draft and its DAG remain immutable; only the existing Goal
 * Contract, Requirements, validation resolution, and current Slice package
 * are carried into the new planner draft.
 */
export async function createStagedGoalSliceRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; expectedPackageHash: string },
): Promise<StagedGoalSliceRevisionResult> {
  const transactionResult: CanonicalDraftTransactionResult<StagedGoalSliceRevisionResult> = await db.tx(async (tx) => {
    const source = await tx.one<PlannerDraftResourceRow>(
      `select id, resource_key, run_id, task_id, session_id, scope, status, title,
              payload_json, summary_json, metrics_json, expires_at
         from southstar.runtime_resources
        where resource_type = 'planner_draft' and resource_key = $1
        for update`,
      [input.draftId],
    );
    const sourcePayload = asRecord(source.payload_json);
    const sourcePhase = goalDesignPhaseFromPayload(sourcePayload);
    if (source.status !== "ready_for_review" || sourcePhase !== "dag_validated") {
      throw new Error(`goal_design_revision_source_not_frozen: ${input.draftId}`);
    }
    const packageValue = goalDesignPackageFromStored(sourcePayload.goalDesignPackage);
    if (!packageValue || sourcePayload.goalDesignPackageHash !== packageValue.packageHash) {
      return {
        kind: "incompatible",
        rejection: await persistIncompatibleGoalDesignDraftPg(tx, { draftId: input.draftId }),
      };
    }
    if (packageValue.packageHash !== input.expectedPackageHash) {
      throw new Error(`goal_design_package_stale: ${input.draftId}`);
    }
    const requirementDraft = goalRequirementDraftFromStored(sourcePayload.goalRequirementDraft);
    if (!requirementDraft || sourcePayload.goalRequirementDraftHash !== requirementDraft.draftHash) {
      throw new Error(`Goal Requirement draft lineage is invalid: ${input.draftId}`);
    }
    const goalContract = storedGoalContract(sourcePayload.goalContract);
    if (!goalContract) throw new Error(`Goal Contract not found: ${input.draftId}`);
    const contractHash = goalContractHash(goalContract);
    if (sourcePayload.goalContractHash !== contractHash || packageValue.goalContractHash !== contractHash) {
      throw new Error(`Goal Contract lineage is invalid: ${input.draftId}`);
    }
    const resolution = storedGoalValidationResolution(sourcePayload.goalValidationResolution);
    if (!resolution
      || resolution.ready !== true
      || resolution.gaps.length > 0
      || resolution.goalContractHash !== contractHash
      || resolution.requirementDraftHash !== requirementDraft.draftHash
      || contentHashForPayload(resolution.bindings) !== packageValue.validationBindingsHash) {
      throw new Error(`Goal validation resolution lineage is invalid: ${input.draftId}`);
    }

    const revisionKeyHash = contentHashForPayload({
      parentDraftId: input.draftId,
      parentPackageHash: packageValue.packageHash,
      purpose: "staged-slice-review",
    });
    const revisionDraftId = `${input.draftId}:slice-revision:${revisionKeyHash.slice(0, 16)}`;
    const existing = await tx.maybeOne<PlannerDraftResourceRow>(
      `select id, resource_key, run_id, task_id, session_id, scope, status, title,
              payload_json, summary_json, metrics_json, expires_at
         from southstar.runtime_resources
        where resource_type = 'planner_draft' and resource_key = $1
        for update`,
      [revisionDraftId],
    );
    if (existing) {
      const existingPayload = asRecord(existing.payload_json);
      const existingPackage = goalDesignPackageFromStored(existingPayload.goalDesignPackage);
      const existingLineage = asRecord(existingPayload.goalDesignPhaseRevision);
      if (!existingPackage || existingPayload.goalDesignPackageHash !== existingPackage.packageHash) {
        return {
          kind: "incompatible",
          rejection: await persistIncompatibleGoalDesignDraftPg(tx, { draftId: revisionDraftId }),
        };
      }
      if (existing.status !== "ready_for_review"
        || goalDesignPhaseFromPayload(existingPayload) !== "slice_review"
        || existingLineage.parentDraftId !== input.draftId
        || existingLineage.parentPackageHash !== packageValue.packageHash
      ) {
        throw new Error(`goal_design_revision_conflict: ${revisionDraftId}`);
      }
      return {
        kind: "accepted",
        value: stagedGoalSliceRevisionResult({
          draftId: revisionDraftId,
          parentDraftId: input.draftId,
          packageValue: existingPackage,
          requirementDraft,
          goalContract,
          goalContractHash: contractHash,
        }),
      };
    }

    const clonedPayload: Record<string, unknown> = {
      plannerRequest: sourcePayload.plannerRequest,
      goalRequirementDraftId: sourcePayload.goalRequirementDraftId ?? input.draftId,
      goalRequirementDraft: requirementDraft,
      goalRequirementDraftHash: requirementDraft.draftHash,
      goalContract,
      goalContractHash: contractHash,
      goalValidationResolution: resolution,
      validationBindings: resolution.bindings,
      requirementValidationBindings: resolution.bindings,
      validationGaps: [],
      validationIssues: [],
      confirmable: false,
      goalDesignPackage: packageValue,
      goalDesignPackageHash: packageValue.packageHash,
      slicePlan: packageValue.slicePlan,
      goalDesignPhase: "slice_review" satisfies GoalDesignPhase,
      goalDesignPhaseRevision: {
        parentDraftId: input.draftId,
        parentPackageHash: packageValue.packageHash,
        sourcePhase,
      },
      ...(sourcePayload.uiInteractionContracts !== undefined ? { uiInteractionContracts: sourcePayload.uiInteractionContracts } : {}),
      ...(sourcePayload.uiInteractionContractHashes !== undefined ? { uiInteractionContractHashes: sourcePayload.uiInteractionContractHashes } : {}),
      ...(sourcePayload.goalDesignSkillRef !== undefined ? { goalDesignSkillRef: sourcePayload.goalDesignSkillRef } : {}),
      ...(sourcePayload.goalDesignSkillVersionRef !== undefined ? { goalDesignSkillVersionRef: sourcePayload.goalDesignSkillVersionRef } : {}),
      ...(sourcePayload.workspaceDiscoveryHash !== undefined ? { workspaceDiscoveryHash: sourcePayload.workspaceDiscoveryHash } : {}),
    };
    await persistGoalDesignPackageRevisionPg(tx, { draftId: revisionDraftId, package: packageValue });
    await upsertRuntimeResourcePg(tx, {
      resourceType: "planner_draft",
      resourceKey: revisionDraftId,
      ...(source.session_id ? { sessionId: source.session_id } : {}),
      scope: source.scope,
      status: "ready_for_review",
      title: "Goal Slice Revision Ready For Review",
      payload: clonedPayload,
      summary: {
        goalPrompt: requirementDraft.originalPrompt,
        workflowId: "",
        planner: "goal-design-slice-revision",
        status: "ready_for_review",
        validationIssues: [],
        taskSummaries: [],
        goalContractHash: contractHash,
        goalDesignPackageHash: packageValue.packageHash,
        goalDesignPhase: "slice_review" satisfies GoalDesignPhase,
        sliceCount: packageValue.slicePlan.slices.length,
        templatePolicy: packageValue.templatePolicy,
        parentDraftId: input.draftId,
        parentPackageHash: packageValue.packageHash,
      },
    });
    return {
      kind: "accepted",
      value: stagedGoalSliceRevisionResult({
        draftId: revisionDraftId,
        parentDraftId: input.draftId,
        packageValue,
        requirementDraft,
        goalContract,
        goalContractHash: contractHash,
      }),
    };
  });
  if (transactionResult.kind === "incompatible") {
    throwCanonicalGoalDesignDraftRejection(transactionResult.rejection);
  }
  return transactionResult.value;
}

function stagedGoalSliceRevisionResult(input: {
  draftId: string;
  parentDraftId: string;
  packageValue: GoalDesignPackageV3;
  requirementDraft: GoalRequirementDraftV1;
  goalContract: GoalContractV1;
  goalContractHash: string;
}): StagedGoalSliceRevisionResult {
  return {
    draftId: input.draftId,
    status: "ready_for_review",
    phase: "slice_review",
    sourcePhase: "dag_validated",
    parentDraftId: input.parentDraftId,
    parentPackageHash: input.packageValue.packageHash,
    goalPrompt: input.requirementDraft.originalPrompt,
    goalRequirementDraftId: input.parentDraftId,
    goalRequirementDraft: input.requirementDraft,
    goalRequirementDraftHash: input.requirementDraft.draftHash,
    goalContract: input.goalContract,
    goalContractHash: input.goalContractHash,
    goalDesignPackage: input.packageValue,
    goalDesignPackageHash: input.packageValue.packageHash,
    blockers: [],
  };
}

export {
  assertGoalValidationImportCurrentPg,
  GoalValidationImportStaleError,
  GoalValidationProviderNotConfiguredError,
  persistGoalValidationResolutionPg,
  resolveAndPersistGoalValidationPg,
  resumeGoalValidationAfterLibraryImportPg,
} from "./goal-validation-lifecycle.ts";
export type { GoalValidationLifecycleResult, GoalValidationResolver } from "./goal-validation-lifecycle.ts";

export type GoalRequirementContractMetadata = Pick<
  GoalContractV1,
  "domain" | "intent" | "workType" | "expectedArtifactRefs" | "requiredCapabilities" | "assumptions" | "requestedSideEffects"
>;

export type GoalRequirementRevisionInput = {
  draftId: string;
  expectedDraftHash: string;
  requirementId?: string;
  patch: GoalRequirementDraftRevisionPatchV1 | GoalRequirementDraftRevisionOperation;
  uiInteractionContracts?: UiInteractionContractV1[];
  actor?: string;
};

export type GoalDesignChatRevisionResult =
  | {
      kind: "revision";
      draftStatus: "ready_for_review";
      package: GoalDesignPackageV3;
      summary: string;
      changedSliceIds: string[];
    }
  | { kind: "needs_input"; question: string };

export class GoalRequirementContractMetadataMissingError extends Error {
  readonly code = "goal_requirement_contract_metadata_missing";
  readonly status = 422;

  constructor(readonly draftId: string) {
    super(`goal_requirement_contract_metadata_missing: Goal Contract metadata is unavailable for requirement draft: ${draftId}`);
    this.name = "GoalRequirementContractMetadataMissingError";
  }
}

export class GoalRequirementContractMetadataInvalidError extends Error {
  readonly code = "goal_requirement_contract_metadata_invalid";
  readonly status = 422;

  constructor(message: string) {
    super(`goal_requirement_contract_metadata_invalid: ${message}`);
    this.name = "GoalRequirementContractMetadataInvalidError";
  }
}

/** Persist one immutable Requirement Draft revision. */
export async function persistGoalRequirementDraftRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; draft: GoalRequirementDraftV1; actor?: string },
): Promise<void> {
  const issues = validateGoalRequirementDraftForRevision(input.draft);
  if (issues.length > 0) {
    throw new Error(`invalid Goal Requirement draft: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
  }
  const resourceKey = `${input.draftId}:revision:${input.draft.revision}`;
  const existing = await insertRuntimeResourceIfAbsentPg(db, {
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
  const existingDraft = existing.payload as unknown as GoalRequirementDraftV1;
  if (existingDraft.draftHash !== input.draft.draftHash) {
    throw new Error(`goal_requirement_revision_conflict: ${resourceKey}`);
  }
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

export async function loadCurrentUiInteractionContractPg(
  db: SouthstarDb,
  input: { draftId: string; contractId: string },
): Promise<UiInteractionContractV1> {
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
    [input.draftId],
  );
  if (!row) throw new Error(`planner draft not found: ${input.draftId}`);
  const draft = goalRequirementDraftFromStored(row.payload_json.goalRequirementDraft);
  if (!draft) throw new Error(`Goal Requirement draft not found: ${input.draftId}`);
  const contract = uiInteractionContractsFromStored(row.payload_json.uiInteractionContracts, draft)
    .find((entry) => entry.id === input.contractId);
  if (contract) return contract;
  const recovered = await recoverUiInteractionContractFromRevisionPg(db, {
    draftId: input.draftId,
    contractId: input.contractId,
    requirementDraft: draft,
  });
  if (!recovered) throw new Error(`UI interaction contract not found: ${input.contractId}`);
  return recovered;
}

async function recoverUiInteractionContractFromRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; contractId: string; requirementDraft: GoalRequirementDraftV1 },
): Promise<UiInteractionContractV1 | undefined> {
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'ui_interaction_contract_revision'
        and resource_key like $1
      order by (payload_json->>'revision')::int desc
      limit 1`,
    [`${input.draftId}:${input.contractId}:revision:%`],
  );
  const contractPayload = row ? { ...row.payload_json } : undefined;
  if (contractPayload) delete contractPayload.draftId;
  if (!contractPayload || contractPayload.id !== input.contractId) return undefined;
  return rebaseUiInteractionContractForDraft(
    contractPayload as UiInteractionContractV1,
    input.requirementDraft,
    { forceDraft: true },
  );
}

/**
 * Create or revise a goal-scoped visual contract in the existing planner
 * draft. Semantic screen data may come from an LLM or structured UI, while
 * this host path owns identity, lineage, validation, confirmation and hashes.
 */
export async function reviseUiInteractionContractPg(
  db: SouthstarDb,
  input: UiInteractionContractRevisionInput,
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
    const requirementDraft = goalRequirementDraftFromStored(payload.goalRequirementDraft);
    if (!requirementDraft) throw new Error(`Goal Requirement draft not found: ${input.draftId}`);
    const phase = goalDesignPhaseFromPayload(payload) ?? "requirements_review";
    if (phase !== "requirements_review") throw new Error(`ui_interaction_contract_frozen: ${input.draftId}`);
    await assertNoMaterializedGoalRequirementRunTx(tx, input.draftId);

    const contracts = uiInteractionContractsFromStored(payload.uiInteractionContracts, requirementDraft);
    const currentIndex = contracts.findIndex((entry) => entry.id === input.contractId);
    let next: UiInteractionContractV1;
    if (currentIndex < 0) {
      if (input.patch) {
        if (input.contract) throw new Error("revising a recovered UI interaction contract requires a structured patch only");
        const recovered = await recoverUiInteractionContractFromRevisionPg(tx, {
          draftId: input.draftId,
          contractId: input.contractId,
          requirementDraft,
        });
        if (!recovered || !input.expectedContractHash || recovered.contractHash !== input.expectedContractHash) {
          throw new Error(`ui_interaction_contract_stale: ${input.contractId}`);
        }
        next = reviseUiInteractionContract(recovered, input.patch, requirementDraft);
      } else {
        if (!input.contract) throw new Error("creating a UI interaction contract requires contract semantic content and no patch");
        if (input.expectedContractHash !== undefined) throw new Error(`ui_interaction_contract_stale: ${input.contractId}`);
        next = finalizeUiInteractionContract(input.contract, requirementDraft, { id: input.contractId });
      }
      contracts.push(next);
    } else {
      const current = contracts[currentIndex]!;
      if (!input.expectedContractHash || current.contractHash !== input.expectedContractHash) {
        throw new Error(`ui_interaction_contract_stale: ${input.contractId}`);
      }
      if (!input.patch || input.contract) throw new Error("revising a UI interaction contract requires exactly one structured patch");
      next = reviseUiInteractionContract(current, input.patch, requirementDraft);
      contracts[currentIndex] = next;
    }
    await persistUiInteractionContractRevisionPg(tx, {
      draftId: input.draftId,
      contract: next,
      requirementDraft,
      actor: input.actor,
    });
    const readiness = goalRequirementReviewReadiness(requirementDraft, phase, contracts);
    const updatedPayload = {
      ...payload,
      uiInteractionContracts: contracts,
      uiInteractionContractHashes: Object.fromEntries(contracts.map((entry) => [entry.id, entry.contractHash])),
      confirmable: readiness.confirmable,
      validationIssues: readiness.validationIssues,
    };
    const updatedSummary = {
      ...row.summary_json,
      confirmable: readiness.confirmable,
      validationIssues: readiness.validationIssues,
      uiInteractionContractCount: contracts.length,
      confirmedUiInteractionContractCount: contracts.filter((entry) => entry.status === "confirmed").length,
    };
    await upsertRuntimeResourcePg(tx, {
      id: row.id,
      resourceType: "planner_draft",
      resourceKey: input.draftId,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      scope: row.scope,
      status: row.status,
      ...(row.title ? { title: row.title } : {}),
      payload: updatedPayload,
      summary: updatedSummary,
      metrics: row.metrics_json,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    });
    return {
      draftId: input.draftId,
      goalRequirementDraftId: input.draftId,
      status: "requirements_review",
      phase: "requirements_review",
      goalPrompt: requirementDraft.originalPrompt,
      goalRequirementDraft: requirementDraft,
      goalRequirementDraftHash: requirementDraft.draftHash,
      ...readiness,
      uiInteractionContracts: contracts,
      blockers: requirementDraft.blockingInputs,
    };
  });
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
    sessionId?: string;
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
  const uiInteractionContracts = input.requirementInterpreter.designUiInteractionContracts
    ? await input.requirementInterpreter.designUiInteractionContracts({
      requirementDraft: draft,
      goalDesignSkill: skill,
    })
    : [];
  const readiness = goalRequirementReviewReadiness(draft, "requirements_review", uiInteractionContracts);
  const persistDraft = sessionScopedPlannerDraftPersistence(db, input.sessionId, input.persistDraft);
  await persistGoalRequirementDraftRevisionPg(db, { draftId, draft });
  for (const contract of uiInteractionContracts) {
    await persistUiInteractionContractRevisionPg(db, {
      draftId,
      contract,
      requirementDraft: draft,
      actor: "goal-requirement-interpreter",
    });
  }
  await persistPlannerDraftResource(db, {
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "requirements_review",
    title: "Goal Requirements Ready For Review",
    payload: {
      goalRequirementDraftId: draftId,
      goalRequirementDraft: draft,
      goalRequirementDraftHash: draft.draftHash,
      goalDesignPhase: "requirements_review" satisfies GoalDesignPhase,
      plannerRequest: {
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.projectRef !== undefined ? { projectRef: input.projectRef } : {}),
        ...(input.mode !== undefined ? { goalDesignMode: input.mode } : {}),
        ...(input.templatePolicy !== undefined ? { templatePolicy: input.templatePolicy } : {}),
      },
      goalDesignSkillRef: skill.objectKey,
      goalDesignSkillVersionRef: skill.versionRef,
      workspaceDiscoveryHash: workspaceDiscovery.discoveryHash,
      uiInteractionContracts,
      uiInteractionContractHashes: {},
      confirmable: readiness.confirmable,
      validationIssues: readiness.validationIssues,
    },
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: "",
      planner: "goal-design",
      status: "requirements_review",
      goalDesignPhase: "requirements_review" satisfies GoalDesignPhase,
      confirmable: readiness.confirmable,
      validationIssues: readiness.validationIssues,
      taskSummaries: [],
      goalRequirementDraftId: draftId,
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
  }, persistDraft);
  const result: GoalRequirementReviewResult = {
    draftId,
    goalRequirementDraftId: draftId,
    status: "requirements_review",
    phase: "requirements_review",
    goalPrompt: input.goalPrompt,
    goalRequirementDraft: draft,
    goalRequirementDraftHash: draft.draftHash,
    ...readiness,
    uiInteractionContracts,
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
    if (phase === "composing") {
      throw new Error(`goal_requirements_frozen: ${input.draftId}:${phase}`);
    }
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
    const currentUiInteractionContracts = uiInteractionContractsFromStored(payload.uiInteractionContracts, current);
    const uiInteractionContracts = input.uiInteractionContracts
      ? await rebaseGeneratedUiInteractionContracts(tx, input.draftId, next, currentUiInteractionContracts, input.uiInteractionContracts)
      : currentUiInteractionContracts.flatMap((contract) => {
        const rebased = rebaseUiInteractionContractForDraft(contract, next);
        return rebased ? [rebased] : [];
      });
    for (const contract of uiInteractionContracts) {
      if (!currentUiInteractionContracts.some((entry) => entry.id === contract.id && entry.contractHash === contract.contractHash && entry.revision === contract.revision)) {
        await persistUiInteractionContractRevisionPg(tx, {
          draftId: input.draftId,
          contract,
          requirementDraft: next,
          actor: input.actor,
        });
      }
    }
    const readiness = goalRequirementReviewReadiness(next, "requirements_review", uiInteractionContracts);
    const updatedPayload = {
      ...nextPayload,
      goalRequirementDraft: next,
      goalRequirementDraftHash: next.draftHash,
      goalDesignPhase: "requirements_review" satisfies GoalDesignPhase,
      uiInteractionContracts,
      uiInteractionContractHashes: Object.fromEntries(uiInteractionContracts.map((contract) => [contract.id, contract.contractHash])),
      ...readiness,
    };
    const updatedSummary = {
      ...row.summary_json,
      status: "requirements_review",
      goalDesignPhase: "requirements_review" satisfies GoalDesignPhase,
      goalRequirementDraftHash: next.draftHash,
      requirementCount: next.requirements.filter((requirement) => requirement.status !== "superseded").length,
      staleReason: "goal_requirements_revised",
      confirmable: readiness.confirmable,
      validationIssues: readiness.validationIssues,
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
      goalRequirementDraftId: input.draftId,
      status: "requirements_review",
      phase: "requirements_review",
      goalPrompt: next.originalPrompt,
      goalRequirementDraft: next,
      goalRequirementDraftHash: next.draftHash,
      ...readiness,
      uiInteractionContracts,
      blockers: next.blockingInputs,
      invalidated,
    };
  });
}

/**
 * Run the Goal Requirement interpreter for a chat revision, then persist the
 * host-finalized draft through the same hash-checked revision path as manual
 * edits. The interpreter supplies semantics; persistence owns lineage/status.
 */
export async function reviseGoalRequirementFromChatPg(
  db: SouthstarDb,
  input: {
    draftId: string;
    expectedDraftHash: string;
    message: string;
    selectedRequirementId?: string;
    selectedRequirementIds?: string[];
    actor?: string;
    requirementInterpreter: GoalRequirementDraftInterpreter;
    onDelta?: (text: string) => void;
  },
): Promise<GoalRequirementReviewResult | { kind: "needs_input"; question: string }> {
  const current = await loadCurrentGoalRequirementDraftPg(db, input.draftId);
  if (current.draftHash !== input.expectedDraftHash) throw new Error(`goal_requirement_draft_stale: ${input.draftId}`);
  const result = await input.requirementInterpreter.revise({
    currentDraft: current,
    message: input.message,
    ...(input.selectedRequirementId ? { selectedRequirementId: input.selectedRequirementId } : {}),
    ...(input.selectedRequirementIds ? { selectedRequirementIds: input.selectedRequirementIds } : {}),
    onDelta: input.onDelta,
  });
  if (result.kind === "needs_input") return result;
  const generatedUiInteractionContracts = input.requirementInterpreter.designUiInteractionContracts
    ? await input.requirementInterpreter.designUiInteractionContracts({
      requirementDraft: result.draft,
      goalDesignSkill: await loadGoalDesignSkillPg(db),
    })
    : undefined;
  const persisted = await reviseGoalRequirementPg(db, {
    draftId: input.draftId,
    expectedDraftHash: input.expectedDraftHash,
    patch: { kind: "replace", draft: result.draft },
    ...(generatedUiInteractionContracts ? { uiInteractionContracts: generatedUiInteractionContracts } : {}),
    actor: input.actor,
  });
  return persisted;
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
  const preflightRow = await db.maybeOne<PlannerDraftResourceRow>(
    `select id, resource_key, run_id, task_id, session_id, scope, status, title,
            payload_json, summary_json, metrics_json, expires_at
       from southstar.runtime_resources
      where resource_type = 'planner_draft' and resource_key = $1`,
    [input.draftId],
  );
  if (!preflightRow) throw new Error(`planner draft not found: ${input.draftId}`);
  const preflightPayload = asRecord(preflightRow.payload_json);
  const preflightDraft = goalRequirementDraftFromStored(preflightPayload.goalRequirementDraft);
  if (!preflightDraft) throw new Error(`Goal Requirement draft not found: ${input.draftId}`);
  if (preflightDraft.draftHash !== input.expectedDraftHash) {
    throw new Error(`goal_requirement_draft_stale: ${input.draftId}`);
  }
  const preflightPhase = goalDesignPhaseFromPayload(preflightPayload) ?? "requirements_review";
  const preflightUiContracts = uiInteractionContractsFromStored(preflightPayload.uiInteractionContracts, preflightDraft);
  if (preflightPhase === "requirements_review") {
    const readiness = goalRequirementReviewReadiness(preflightDraft, preflightPhase, preflightUiContracts);
    if (!readiness.confirmable) throw new Error(`goal_requirement_not_confirmable: ${JSON.stringify(readiness.validationIssues)}`);
  }
  const preflightContract = storedGoalContract(preflightPayload.goalContract);
  const preflightContractNeedsReconfirmation = preflightContract
    && ["validation_resolving", "library_review", "validation_ready"].includes(preflightPhase)
    && !goalContractMatchesRequirementDraft(preflightContract, preflightDraft);
  if (!preflightContract || !["validation_resolving", "library_review", "validation_ready"].includes(preflightPhase)) {
    if (preflightPhase !== "requirements_review" && preflightPhase !== "requirements_confirmed") {
      throw new Error(`goal requirements cannot be confirmed in phase ${preflightPhase}: ${input.draftId}`);
    }
  }
  const preflightMetadata = preflightContract && ["validation_resolving", "library_review", "validation_ready"].includes(preflightPhase)
    ? (preflightContractNeedsReconfirmation ? contractMetadata(preflightContract) : undefined)
    : await resolveGoalRequirementContractMetadata(db, preflightDraft, { ...input, draftId: input.draftId });

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
    const uiInteractionContracts = uiInteractionContractsFromStored(payload.uiInteractionContracts, current);
    const existingContract = storedGoalContract(payload.goalContract);
    const existingContractNeedsReconfirmation = existingContract
      && ["validation_resolving", "library_review", "validation_ready"].includes(phase)
      && !goalContractMatchesRequirementDraft(existingContract, current);
    if (existingContract && ["validation_resolving", "library_review", "validation_ready"].includes(phase) && !existingContractNeedsReconfirmation) {
      return {
        draftId: input.draftId,
        goalRequirementDraftId: input.draftId,
        status: phase as GoalRequirementReviewResult["status"],
        phase,
        goalPrompt: current.originalPrompt,
        goalRequirementDraft: current,
        goalRequirementDraftHash: current.draftHash,
        ...goalRequirementReviewReadiness(current, phase, uiInteractionContracts),
        uiInteractionContracts,
        goalContract: existingContract,
        goalContractHash: goalContractHash(existingContract),
        blockers: current.blockingInputs,
        ...(Array.isArray(payload.validationGaps) ? { validationGaps: payload.validationGaps } : {}),
      };
    }
    if (phase !== "requirements_review" && phase !== "requirements_confirmed"
      && !(existingContractNeedsReconfirmation && ["validation_resolving", "library_review", "validation_ready"].includes(phase))) {
      throw new Error(`goal requirements cannot be confirmed in phase ${phase}: ${input.draftId}`);
    }
    if (phase === "requirements_review") {
      const confirmationReadiness = goalRequirementReviewReadiness(current, phase, uiInteractionContracts);
      if (!confirmationReadiness.confirmable) {
        throw new Error(`goal_requirement_not_confirmable: ${JSON.stringify(confirmationReadiness.validationIssues)}`);
      }
    }
    if (!preflightMetadata) {
      throw new Error(`goal requirements confirmation metadata was superseded: ${input.draftId}`);
    }
    const metadata = preflightMetadata;
    const previousConfirmation = await tx.maybeOne<{ payload_json: unknown }>(
      `select payload_json
         from southstar.runtime_resources
        where resource_type = 'goal_contract_confirmation' and resource_key = $1
        for update`,
      [input.draftId],
    );
    const previousContract = storedGoalContract(asRecord(previousConfirmation?.payload_json).goalContract);
    const contract = confirmGoalRequirementDraft(current, metadata, previousContract);
    const contractHash = goalContractHash(contract);
    const criterionAssignments = current.requirements.flatMap((requirement) => {
      const confirmedRequirement = contract.requirements.find((entry) => entry.id === requirement.id);
      if (!confirmedRequirement) throw new Error(`confirmed requirement identity missing: ${requirement.id}`);
      return requirement.acceptanceCriteria.map((criterion) => {
        const confirmedCriterion = confirmedRequirement.acceptanceCriteria.find((entry) => entry.id === criterion.id);
        if (!confirmedCriterion) throw new Error(`confirmed Criterion identity missing: ${criterion.id}`);
        return {
          requirementId: requirement.id,
          proposedCriterionId: criterion.id,
          criterionId: confirmedCriterion.id,
          criterionVersion: confirmedCriterion.version,
        };
      });
    });
    const readiness = goalRequirementReviewReadiness(current, "validation_resolving", uiInteractionContracts);
    await upsertRuntimeResourcePg(tx, {
      resourceType: "goal_contract_confirmation",
      resourceKey: input.draftId,
      scope: "planner",
      status: "persisted",
      title: "Goal Contract Confirmed",
      payload: {
        draftId: input.draftId,
        goalRequirementDraftId: input.draftId,
        actor: input.actor ?? "user",
        goalRequirementDraftHash: current.draftHash,
        confirmable: readiness.confirmable,
        validationIssues: readiness.validationIssues,
        goalContract: contract,
        goalContractHash: contractHash,
        criterionAssignments,
        goalDesignPhase: "validation_resolving" satisfies GoalDesignPhase,
      },
      summary: {
        draftId: input.draftId,
        goalContractHash: contractHash,
        goalRequirementDraftHash: current.draftHash,
        confirmable: readiness.confirmable,
        validationIssues: readiness.validationIssues,
        goalDesignPhase: "validation_resolving" satisfies GoalDesignPhase,
      },
    });
    const updatedPayload = {
      ...payload,
      goalRequirementDraftId: input.draftId,
      goalContract: contract,
      goalContractHash: contractHash,
      goalRequirementDraftHash: current.draftHash,
      confirmable: readiness.confirmable,
      validationIssues: readiness.validationIssues,
      goalDesignPhase: "validation_resolving" satisfies GoalDesignPhase,
      requirementConfirmation: {
        actor: input.actor ?? "user",
        confirmedAt: new Date().toISOString(),
        draftHash: current.draftHash,
        criterionAssignments,
      },
    };
    const updatedSummary = {
      ...row.summary_json,
      status: "validation_resolving",
      goalDesignPhase: "validation_resolving" satisfies GoalDesignPhase,
      goalContractHash: contractHash,
      goalRequirementDraftHash: current.draftHash,
      confirmable: readiness.confirmable,
      validationIssues: readiness.validationIssues,
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
      goalRequirementDraftId: input.draftId,
      status: "validation_resolving",
      phase: "validation_resolving",
      goalPrompt: current.originalPrompt,
      goalRequirementDraft: current,
      goalRequirementDraftHash: current.draftHash,
      ...readiness,
      uiInteractionContracts,
      goalContract: contract,
      goalContractHash: contractHash,
      blockers: current.blockingInputs,
    };
  });
}

/**
 * Continue the same staged planner draft from frozen validation bindings into
 * a reviewable Slice Plan. The model runs outside the transaction; the final
 * write uses the resolution hash as a compare-and-swap guard.
 */
export async function designAndPersistGoalSlicesPg(
  db: SouthstarDb,
  input: {
    draftId: string;
    expectedResolutionHash: string;
    sliceDesigner: GoalSliceDesigner;
    onDelta?: (text: string) => void;
  },
): Promise<GoalSliceReviewResult> {
  const preflight = await db.maybeOne<PlannerDraftResourceRow>(
    `select id, resource_key, run_id, task_id, session_id, scope, status, title,
            payload_json, summary_json, metrics_json, expires_at
       from southstar.runtime_resources
      where resource_type = 'planner_draft' and resource_key = $1`,
    [input.draftId],
  );
  if (!preflight) throw new Error(`planner draft not found: ${input.draftId}`);
  const source = sliceDesignSourceFromPlannerRow(preflight, input.expectedResolutionHash);
  const workspaceDiscovery = await discoverGoalWorkspace(source.requirementDraft.workspace.cwd);
  const skill = await loadGoalDesignSkillPg(db);
  const storedSkillRef = optionalNonEmptyString(source.payload.goalDesignSkillRef);
  const storedSkillVersionRef = optionalNonEmptyString(source.payload.goalDesignSkillVersionRef);
  if ((storedSkillRef && storedSkillRef !== skill.objectKey)
    || (storedSkillVersionRef && storedSkillVersionRef !== skill.versionRef)) {
    throw new Error(`goal_design_skill_changed: ${input.draftId}`);
  }
  const plannerRequest = asRecord(source.payload.plannerRequest);
  const mode: GoalDesignMode = plannerRequest.goalDesignMode === "auto_until_blocked"
    ? "auto_until_blocked"
    : "review_before_compose";
  const templatePolicy = storedTemplatePolicy(plannerRequest.templatePolicy);
  const pkg = await input.sliceDesigner.design({
    goalContract: source.goalContract,
    requirementDraft: source.requirementDraft,
    validationBindings: source.resolution.bindings,
    workspaceDiscovery,
    mode,
    templatePolicy,
    skill,
    onDelta: input.onDelta,
  });
  if (pkg.requirementDraftHash !== source.requirementDraft.draftHash
    || pkg.goalContractHash !== source.goalContractHash
    || pkg.validationBindingsHash !== contentHashForPayload(source.resolution.bindings)) {
    throw new Error(`goal_slice_design_lineage_mismatch: ${input.draftId}`);
  }

  return await db.tx(async (tx) => {
    const locked = await tx.one<PlannerDraftResourceRow>(
      `select id, resource_key, run_id, task_id, session_id, scope, status, title,
              payload_json, summary_json, metrics_json, expires_at
         from southstar.runtime_resources
        where resource_type = 'planner_draft' and resource_key = $1
        for update`,
      [input.draftId],
    );
    const current = sliceDesignSourceFromPlannerRow(locked, input.expectedResolutionHash);
    if (current.requirementDraft.draftHash !== source.requirementDraft.draftHash
      || current.goalContractHash !== source.goalContractHash
      || contentHashForPayload(current.resolution.bindings) !== pkg.validationBindingsHash) {
      throw new Error(`goal_validation_resolution_stale: ${input.draftId}`);
    }
    await persistGoalDesignPackageRevisionPg(tx, { draftId: input.draftId, package: pkg });
    await upsertRuntimeResourcePg(tx, {
      id: locked.id,
      resourceType: "planner_draft",
      resourceKey: input.draftId,
      ...(locked.run_id ? { runId: locked.run_id } : {}),
      ...(locked.task_id ? { taskId: locked.task_id } : {}),
      ...(locked.session_id ? { sessionId: locked.session_id } : {}),
      scope: locked.scope,
      status: "ready_for_review",
      title: "Goal Slice Plan Ready For Review",
      payload: {
        ...locked.payload_json,
        goalDesignPhase: "slice_review" satisfies GoalDesignPhase,
        goalDesignPackage: pkg,
        goalDesignPackageHash: pkg.packageHash,
        slicePlan: pkg.slicePlan,
        workspaceDiscoveryHash: workspaceDiscovery.discoveryHash,
      },
      summary: {
        ...locked.summary_json,
        status: "ready_for_review",
        goalDesignPhase: "slice_review" satisfies GoalDesignPhase,
        goalDesignPackageHash: pkg.packageHash,
        sliceCount: pkg.slicePlan.slices.length,
        templatePolicy: pkg.templatePolicy,
        validationIssues: [],
        taskSummaries: [],
      },
      metrics: locked.metrics_json,
      ...(locked.expires_at ? { expiresAt: locked.expires_at } : {}),
    });
    return {
      draftId: input.draftId,
      status: "ready_for_review",
      phase: "slice_review",
      goalPrompt: current.requirementDraft.originalPrompt,
      goalRequirementDraftId: input.draftId,
      goalRequirementDraft: current.requirementDraft,
      goalRequirementDraftHash: current.requirementDraft.draftHash,
      goalContract: current.goalContract,
      goalContractHash: current.goalContractHash,
      goalDesignPackage: pkg,
      goalDesignPackageHash: pkg.packageHash,
      blockers: [],
    };
  });
}

export async function persistGoalDesignPackageRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; package: GoalDesignPackageV3 },
): Promise<void> {
  if (input.package.schemaVersion !== "southstar.goal_design_package.v3") {
    throw new Error(`unsupported Goal Design package schema: ${String(input.package.schemaVersion)}`);
  }
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
  const issues = validateGoalDesignPackageV3(input.package);
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
): Promise<GoalDesignPackageV3> {
  return await loadCanonicalGoalDesignPackagePg(db, draftId);
}

async function loadGoalDesignPackageForChatRevisionPg(
  db: SouthstarDb,
  draftId: string,
): Promise<GoalDesignPackageV3> {
  const transactionResult: CanonicalDraftTransactionResult<GoalDesignPackageV3> = await db.tx(async (tx) => {
    const draft = await tx.one<{ payload_json: Record<string, unknown> }>(
      `select payload_json
         from southstar.runtime_resources
        where resource_type = 'planner_draft' and resource_key = $1
        for update`,
      [draftId],
    );
    const current = goalDesignPackageFromStored(draft.payload_json.goalDesignPackage);
    if (!current || draft.payload_json.goalDesignPackageHash !== current.packageHash) {
      return {
        kind: "incompatible",
        rejection: await persistIncompatibleGoalDesignDraftPg(tx, { draftId }),
      };
    }
    return { kind: "accepted", value: current };
  });
  if (transactionResult.kind === "incompatible") {
    throwCanonicalGoalDesignDraftRejection(transactionResult.rejection);
  }
  return transactionResult.value;
}

export async function hasCanonicalGoalDesignPackagePg(
  db: SouthstarDb,
  draftId: string,
): Promise<boolean> {
  const row = await db.maybeOne<{ status: string; payload_json: Record<string, unknown> }>(
    "select status, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
    [draftId],
  );
  return Boolean(row && goalDesignPackageFromStored(row.payload_json.goalDesignPackage));
}

export async function reviseGoalSlicePg(
  db: SouthstarDb,
  input: { draftId: string; sliceId: string; expectedPackageHash: string; patch: GoalSlicePatchV1 },
): Promise<GoalDesignPackageV3> {
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
      return finalizeGoalDesignPackageV3({
        schemaVersion: "southstar.goal_design_package.v3",
        revision: nextRevision,
        parentRevision: current.revision,
        goalContract: current.goalContract,
        requirementDraftHash: current.requirementDraftHash,
        validationBindings: current.validationBindings,
        ...(current.assuranceRiskAcceptances ? { assuranceRiskAcceptances: current.assuranceRiskAcceptances } : {}),
        slicePlan: { ...current.slicePlan, revision: nextRevision, slices },
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
): Promise<GoalDesignPackageV3> {
  return await persistValidatedGoalDesignRevisionPg(db, {
    draftId: input.draftId,
    expectedPackageHash: input.expectedPackageHash,
    buildNext(current) {
      const nextRevision = current.revision + 1;
      return finalizeGoalDesignPackageV3({
        schemaVersion: "southstar.goal_design_package.v3",
        revision: nextRevision,
        parentRevision: current.revision,
        goalContract: current.goalContract,
        requirementDraftHash: current.requirementDraftHash,
        validationBindings: current.validationBindings,
        ...(current.assuranceRiskAcceptances ? { assuranceRiskAcceptances: current.assuranceRiskAcceptances } : {}),
        slicePlan: { ...current.slicePlan, revision: nextRevision },
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

export async function acceptAssuranceRiskPg(
  db: SouthstarDb,
  input: {
    draftId: string;
    expectedPackageHash: string;
    criterionId: string;
    criterionVersion: number;
    omittedAssurance: RequirementValidationMode[];
    reason: string;
    approvedBy: string;
  },
): Promise<GoalDesignPackageV3> {
  const approvalId = `assurance-approval-${randomUUID()}`;
  const auditEventRef = `assurance-risk-acceptance-audit-${randomUUID()}`;
  const acceptance: AssuranceRiskAcceptanceV1 = {
    schemaVersion: "southstar.assurance_risk_acceptance.v1",
    id: `assurance-risk-acceptance-${randomUUID()}`,
    criterionId: input.criterionId,
    criterionVersion: input.criterionVersion,
    omittedAssurance: [...input.omittedAssurance],
    reason: input.reason,
    approvalId,
    approvedBy: input.approvedBy,
    approvedAt: new Date().toISOString(),
    auditEventRef,
  };
  return await persistValidatedGoalDesignRevisionPg(db, {
    draftId: input.draftId,
    expectedPackageHash: input.expectedPackageHash,
    buildNext(current) {
      const criterion = current.goalContract.requirements
        .flatMap((requirement) => requirement.acceptanceCriteria)
        .find((candidate) => candidate.id === input.criterionId && candidate.version === input.criterionVersion);
      if (!criterion) throw new Error(`assurance_risk_criterion_not_found: ${input.criterionId}@${input.criterionVersion}`);
      if (input.omittedAssurance.length !== 1 || new Set(input.omittedAssurance).size !== input.omittedAssurance.length) {
        throw new Error("assurance_risk_omitted_assurance must contain exactly one assurance class");
      }
      if (criterion.requiredAssurance.length !== 1 || criterion.requiredAssurance[0] !== input.omittedAssurance[0]) {
        throw new Error(`assurance_risk_omitted_assurance is not required by Criterion ${input.criterionId}`);
      }
      const existing = current.assuranceRiskAcceptances ?? [];
      if (existing.some((candidate) => candidate.criterionId === input.criterionId
        && candidate.criterionVersion === input.criterionVersion
        && candidate.omittedAssurance.some((mode) => input.omittedAssurance.includes(mode)))) {
        throw new Error(`assurance_risk_acceptance_already_exists: ${input.criterionId}`);
      }
      const validationBindings = current.validationBindings
        .map((binding) => ({
          ...binding,
          criterionBindings: binding.criterionBindings.filter((child) => !(
            child.criterionContract.id === input.criterionId
            && child.criterionContract.version === input.criterionVersion
            && input.omittedAssurance.includes(child.verificationMode)
          )),
        }))
        .filter((binding) => binding.criterionBindings.length > 0);
      return finalizeGoalDesignPackageV3({
        schemaVersion: "southstar.goal_design_package.v3",
        revision: current.revision + 1,
        parentRevision: current.revision,
        goalContract: current.goalContract,
        requirementDraftHash: current.requirementDraftHash,
        validationBindings,
        assuranceRiskAcceptances: [...existing, acceptance],
        slicePlan: { ...current.slicePlan, revision: current.revision + 1 },
        compositionStrategy: current.compositionStrategy,
        templatePolicy: current.templatePolicy,
        goalDesignSkillRef: current.goalDesignSkillRef,
        goalDesignSkillVersionRef: current.goalDesignSkillVersionRef,
        workspaceDiscoveryHash: current.workspaceDiscoveryHash,
        mode: current.mode,
      });
    },
    persistAudit(tx, _current, next) {
      return upsertRuntimeResourcePg(tx, {
        id: auditEventRef,
        resourceType: "assurance_risk_acceptance_audit",
        resourceKey: auditEventRef,
        scope: "goal-design",
        status: "approved",
        title: `Assurance risk acceptance for ${input.criterionId}`,
        payload: {
          acceptance,
          previousPackageHash: input.expectedPackageHash,
          packageHash: next.packageHash,
        },
        summary: {
          criterionId: input.criterionId,
          omittedAssurance: input.omittedAssurance,
          approvedBy: input.approvedBy,
          approvalId,
        },
      }).then(() => undefined);
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
    onDelta?: (text: string) => void;
  },
): Promise<GoalDesignChatRevisionResult> {
  const current = await loadGoalDesignPackageForChatRevisionPg(context.db, input.draftId);
  if (current.packageHash !== input.expectedPackageHash) {
    throw new Error(`goal_design_package_stale: ${input.draftId}`);
  }
  return await reviseGoalDesignPackageV3FromChatPg(context, input, current);
}

async function reviseGoalDesignPackageV3FromChatPg(
  context: SubmitGoalContext,
  input: {
    draftId: string;
    expectedPackageHash: string;
    message: string;
    selectedSliceId?: string;
    onDelta?: (text: string) => void;
  },
  current: GoalDesignPackageV3,
): Promise<GoalDesignChatRevisionResult> {
  const designer = context.goalSliceDesigner;
  if (!designer) throw new Error("Goal Design chat revision for Package V3 requires the staged Slice designer");
  const row = await context.db.maybeOne<PlannerDraftResourceRow>(
    `select id, resource_key, run_id, task_id, session_id, scope, status, title,
            payload_json, summary_json, metrics_json, expires_at
       from southstar.runtime_resources
      where resource_type = 'planner_draft' and resource_key = $1`,
    [input.draftId],
  );
  if (!row) throw new Error(`planner draft not found: ${input.draftId}`);
  const source = sliceDesignRevisionSourceFromPlannerRow(row, current);
  const workspaceDiscovery = await discoverGoalWorkspace(source.requirementDraft.workspace.cwd);
  const skill = await loadGoalDesignSkillPg(context.db);
  if (
    skill.objectKey !== current.goalDesignSkillRef
    || skill.versionRef !== current.goalDesignSkillVersionRef
  ) {
    throw new Error(`goal_design_skill_changed: ${input.draftId}`);
  }
  const proposal = await designer.revise({
    currentPackage: current,
    requirementDraft: source.requirementDraft,
    validationBindings: current.validationBindings,
    workspaceDiscovery,
    mode: current.mode,
    templatePolicy: current.templatePolicy,
    skill,
    message: input.message,
    ...(input.selectedSliceId ? { selectedSliceId: input.selectedSliceId } : {}),
    onDelta: input.onDelta,
  });
  if (proposal.kind === "needs_input") return proposal;
  const next = await persistValidatedGoalDesignRevisionPg(context.db, {
    draftId: input.draftId,
    expectedPackageHash: input.expectedPackageHash,
    buildNext(lockedCurrent) {
      if (lockedCurrent.schemaVersion !== "southstar.goal_design_package.v3") {
        throw new Error(`goal_design_package_stale: ${input.draftId}`);
      }
      const nextRevision = lockedCurrent.revision + 1;
      return finalizeGoalDesignPackageV3({
        schemaVersion: "southstar.goal_design_package.v3",
        revision: nextRevision,
        parentRevision: lockedCurrent.revision,
        goalContract: lockedCurrent.goalContract,
        requirementDraftHash: lockedCurrent.requirementDraftHash,
        validationBindings: lockedCurrent.validationBindings,
        ...(lockedCurrent.assuranceRiskAcceptances ? { assuranceRiskAcceptances: lockedCurrent.assuranceRiskAcceptances } : {}),
        slicePlan: {
          schemaVersion: "southstar.goal_slice_plan.v1",
          goalContractHash: "host-filled",
          revision: nextRevision,
          slices: proposal.slicePlan.slices,
        },
        compositionStrategy: proposal.compositionStrategy,
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
    buildNext: (current: GoalDesignPackage) => GoalDesignPackage;
    persistAudit?: (db: SouthstarDb, current: GoalDesignPackage, next: GoalDesignPackage) => Promise<void>;
  },
): Promise<GoalDesignPackage> {
  const transactionResult: CanonicalDraftTransactionResult<GoalDesignPackage> = await db.tx(async (tx) => {
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
    const phase = goalDesignPhaseFromPayload(draft.payload_json) ?? "slice_review";
    if (phase === "composing" || phase === "dag_validated") {
      throw new Error(`goal_design_frozen: ${input.draftId}:${phase}`);
    }
    const current = goalDesignPackageFromStored(draft.payload_json.goalDesignPackage);
    if (!current || draft.payload_json.goalDesignPackageHash !== current.packageHash) {
      return {
        kind: "incompatible",
        rejection: await persistIncompatibleGoalDesignDraftPg(tx, { draftId: input.draftId }),
      };
    }
    if (current.packageHash !== input.expectedPackageHash) {
      throw new Error(`goal_design_package_stale: ${input.draftId}`);
    }
    await assertNoMaterializedGoalDesignRunTx(tx, input.draftId, current.packageHash);
    const next = input.buildNext(current);
    const issues = validateGoalDesignPackageV3(next);
    if (issues.length > 0) {
      throw new Error(`invalid Goal Design package: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join("; ")}`);
    }
    await persistGoalDesignPackageRevisionPg(tx, { draftId: input.draftId, package: next });
    if (input.persistAudit) await input.persistAudit(tx, current, next);
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
        goalDesignPhase: "slice_review" satisfies GoalDesignPhase,
      },
      summary: {
        ...draft.summary_json,
        status: "ready_for_review",
        validationIssues: [],
        taskSummaries: [],
        goalContractHash: next.goalContractHash,
        goalDesignPackageHash: next.packageHash,
        goalDesignPhase: "slice_review" satisfies GoalDesignPhase,
        sliceCount: next.slicePlan.slices.length,
        templatePolicy: next.templatePolicy,
      },
      metrics: draft.metrics_json,
      ...(draft.expires_at ? { expiresAt: draft.expires_at } : {}),
    });
    return { kind: "accepted", value: next };
  });
  if (transactionResult.kind === "incompatible") {
    throwCanonicalGoalDesignDraftRejection(transactionResult.rejection);
  }
  return transactionResult.value;
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
        and pd.resource_key = $1
        and pd.payload_json->>'goalDesignPackageHash' = $2
      limit 1`,
    [draftId, packageHash],
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
        and coalesce(pd.payload_json->>'goalDesignPhase', '') not in ('composing', 'dag_validated')
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
  before: GoalDesignPackage,
  after: GoalDesignPackage,
  proposed: string[],
): string[] {
  const beforeById = new Map(before.slicePlan.slices.map((slice) => [slice.id, JSON.stringify(slice)]));
  const afterById = new Map(after.slicePlan.slices.map((slice) => [slice.id, JSON.stringify(slice)]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys(), ...proposed]);
  return [...ids].filter((id) => beforeById.get(id) !== afterById.get(id)).sort();
}

async function persistPlannerDraftResource(
  db: SouthstarDb,
  resource: RuntimeResourceUpsertInput,
  persistDraft?: PlannerDraftPersistence,
): Promise<void> {
  if (persistDraft) return await persistDraft(resource);
  await upsertRuntimeResourcePg(db, resource);
}

function sessionScopedPlannerDraftPersistence(
  db: SouthstarDb,
  sessionId: string | undefined,
  persistDraft?: PlannerDraftPersistence,
): PlannerDraftPersistence | undefined {
  if (!sessionId && !persistDraft) return undefined;
  return async (resource) => {
    const scoped = {
      ...resource,
      ...(sessionId ? { sessionId } : {}),
    };
    if (persistDraft) return await persistDraft(scoped);
    await upsertRuntimeResourcePg(db, scoped);
  };
}

function goalRequirementDraftFromStored(value: unknown): GoalRequirementDraftV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const draft = value as GoalRequirementDraftV1;
  return validateGoalRequirementDraftForRevision(draft).length === 0 ? draft : undefined;
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
  const issues = validateGoalRequirementDraftForRevision(draft);
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
    candidatePacket: _candidatePacket,
    composition: _composition,
    compositionPlan: _compositionPlan,
    goalContract: _goalContract,
    goalContractHash: _goalContractHash,
    goalDesignPackage: _goalDesignPackage,
    goalDesignPackageHash: _goalDesignPackageHash,
    goalExecutionSet: _goalExecutionSet,
    validationBindings: _validationBindings,
    goalRequirementCoverage: _goalRequirementCoverage,
    goalRequirementCoverageHash: _goalRequirementCoverageHash,
    requirementValidationBindings: _requirementValidationBindings,
    goalValidationResolution: _goalValidationResolution,
    validationGaps: _validationGaps,
    orchestrationSnapshot: _orchestrationSnapshot,
    plannerTrace: _plannerTrace,
    repairAttempts: _repairAttempts,
    requirementSpec: _requirementSpec,
    slicePlan: _slicePlan,
    workflow: _workflow,
    workflowManifest: _workflowManifest,
    workflowManifestHash: _workflowManifestHash,
    executionProjection: _executionProjection,
    libraryImportDraftId: _libraryImportDraftId,
    uiInteractionContracts: _uiInteractionContracts,
    uiInteractionContractHashes: _uiInteractionContractHashes,
    ...rest
  } = payload;
  return rest;
}

async function rebaseGeneratedUiInteractionContracts(
  db: SouthstarDb,
  draftId: string,
  requirementDraft: GoalRequirementDraftV1,
  current: UiInteractionContractV1[],
  generated: UiInteractionContractV1[],
): Promise<UiInteractionContractV1[]> {
  const currentById = new Map(current.map((contract) => [contract.id, contract]));
  const ids = new Set<string>();
  const regenerated = await Promise.all(generated.map(async (candidate) => {
    if (ids.has(candidate.id)) throw new Error(`duplicate regenerated UI interaction contract: ${candidate.id}`);
    ids.add(candidate.id);
    const previous = currentById.get(candidate.id);
    const latest = await db.maybeOne<{ revision: number | null }>(
      `select max((payload_json->>'revision')::int) as revision
         from southstar.runtime_resources
        where resource_type = 'ui_interaction_contract_revision'
          and resource_key like $1`,
      [`${draftId}:${candidate.id}:revision:%`],
    );
    const latestRevision = latest?.revision ?? 0;
    const parentRevision = Math.max(previous?.revision ?? 0, latestRevision);
    const normalizedCandidate = rebaseUiInteractionContractForDraft(candidate, requirementDraft, { forceDraft: true });
    if (!normalizedCandidate) {
      throw new Error(`generated UI interaction contract is incompatible with the revised criteria: ${candidate.id}`);
    }
    return finalizeUiInteractionContract({
      requirementIds: normalizedCandidate.requirementIds,
      screens: normalizedCandidate.screens,
      flows: normalizedCandidate.flows,
      criterionBindings: normalizedCandidate.criterionBindings,
    }, requirementDraft, {
      id: candidate.id,
      revision: parentRevision + 1,
      ...(parentRevision > 0 ? { parentRevision } : {}),
      status: "draft",
    });
  }));
  const preserved = current.filter((contract) => (
    !ids.has(contract.id)
  )).flatMap((contract) => {
    const rebased = rebaseUiInteractionContractForDraft(contract, requirementDraft);
    return rebased ? [rebased] : [];
  });
  return [...regenerated, ...preserved];
}

function rebaseUiInteractionContractForDraft(
  contract: UiInteractionContractV1,
  requirementDraft: GoalRequirementDraftV1,
  options: { forceDraft?: boolean } = {},
): UiInteractionContractV1 | undefined {
  const issues = validateUiInteractionContract(contract, requirementDraft);
  if (issues.length === 0 && !options.forceDraft) return contract;
  if (!Number.isInteger(contract.revision) || contract.revision < 1) return undefined;
  const requirements = contract.requirementIds.map((requirementId) => requirementDraft.requirements.find((entry) => entry.id === requirementId));
  if (requirements.some((requirement) => !requirement)) return undefined;
  const criteria = requirements.flatMap((requirement) => requirement?.acceptanceCriteria ?? []);
  if (criteria.length !== contract.criterionBindings.length) return undefined;
  const currentCriterionIds = new Set(criteria.map((criterion) => criterion.id));
  if (contract.criterionBindings.some((binding) => !currentCriterionIds.has(binding.criterionId))) return undefined;
  const criterionBindings = contract.criterionBindings.map(({ criterionVersion: _criterionVersion, ...binding }) => binding);
  const boundCriterionIds = new Set(criterionBindings.map((binding) => binding.criterionId));
  if (boundCriterionIds.size !== criteria.length || criteria.some((criterion) => !boundCriterionIds.has(criterion.id))) return undefined;
  try {
    return finalizeUiInteractionContract({
      requirementIds: contract.requirementIds,
      screens: contract.screens,
      flows: contract.flows,
      criterionBindings,
    }, requirementDraft, {
      id: contract.id,
      revision: contract.revision + 1,
      parentRevision: contract.revision,
      status: "draft",
    });
  } catch {
    return undefined;
  }
}

async function assertNoMaterializedGoalRequirementRunTx(db: SouthstarDb, draftId: string): Promise<void> {
  const materialized = await db.maybeOne<{ id: string }>(
    `select wr.id
      from southstar.workflow_runs wr
      where wr.runtime_context_json->>'draftId' = $1
         or wr.runtime_context_json->>'goalRequirementDraftId' = $1
      limit 1`,
    [draftId],
  );
  if (materialized) throw new Error(`goal_requirements_already_materialized: ${draftId}`);
}

async function markRequirementDerivedResourcesStaleTx(
  db: SouthstarDb,
  input: { draftId: string; oldDraftHash: string; nextDraftHash: string },
): Promise<{ validationBindings: boolean; slicePlan: boolean; dagDraft: boolean; evidence: boolean; evaluation: boolean }> {
  const stalePayload = JSON.stringify({
    staleReason: "goal_requirements_revised",
    supersededByDraftHash: input.nextDraftHash,
    staleAt: new Date().toISOString(),
  });
  const bindings = await db.query(
    `update southstar.runtime_resources
        set status = 'stale', payload_json = payload_json || $2::jsonb,
            summary_json = summary_json || $2::jsonb, updated_at = now()
      where resource_type in ('goal_contract_confirmation', 'goal_validation_resolution', 'goal_validation_resolution_revision', 'goal_requirement_validation_binding', 'goal_requirement_coverage', 'ui_interaction_contract_revision')
        and (
          resource_key = $1
          or payload_json->>'draftId' = $1
          or payload_json->>'goalRequirementDraftId' = $1
          or payload_json->>'goalRequirementDraftHash' = $3
        )
        and status <> 'stale'`,
    [input.draftId, stalePayload, input.oldDraftHash],
  );
  const slices = await db.query(
    `update southstar.runtime_resources
        set status = 'stale', payload_json = payload_json || $2::jsonb,
            summary_json = summary_json || $2::jsonb, updated_at = now()
      where resource_type in ('goal_design_package_revision', 'goal_design_confirmation', 'goal_slice_plan', 'goal_execution_set')
        and (
          resource_key = $1
          or payload_json->>'draftId' = $1
          or payload_json->>'goalRequirementDraftId' = $1
          or payload_json->>'goalRequirementDraftHash' = $3
        )
        and status <> 'stale'`,
    [input.draftId, stalePayload, input.oldDraftHash],
  );
  const dagDrafts = await db.query(
    `update southstar.runtime_resources pd
        set status = 'stale', payload_json = pd.payload_json || $2::jsonb,
            summary_json = pd.summary_json || $2::jsonb, updated_at = now()
      where pd.resource_type = 'planner_draft'
        and pd.resource_key <> $1
        and (
          pd.payload_json->>'draftId' = $1
          or pd.payload_json->>'goalRequirementDraftId' = $1
          or pd.payload_json->>'goalRequirementDraftHash' = $3
          or pd.summary_json->>'goalRequirementDraftId' = $1
          or pd.summary_json->>'goalRequirementDraftHash' = $3
          or pd.payload_json->'plannerRequest'->>'goalRequirementDraftId' = $1
          or pd.payload_json->'plannerRequest'->>'goalRequirementDraftHash' = $3
          or pd.summary_json->'plannerRequest'->>'goalRequirementDraftId' = $1
          or pd.summary_json->'plannerRequest'->>'goalRequirementDraftHash' = $3
          or pd.payload_json->>'goalDesignPackageHash' is not null
             and pd.payload_json->'plannerRequest'->>'draftId' = $1
        )
        and pd.status <> 'stale'`,
    [input.draftId, stalePayload, input.oldDraftHash],
  );
  const evidence = await db.query(
    `update southstar.runtime_resources
        set status = 'stale', summary_json = summary_json || $2::jsonb, updated_at = now()
      where resource_type = 'evidence_packet'
        and (
          payload_json->>'draftId' = $1
          or payload_json->>'goalRequirementDraftId' = $1
          or payload_json->>'goalRequirementDraftHash' = $3
          or run_id in (
            select wr.id from southstar.workflow_runs wr
             where wr.runtime_context_json->>'draftId' = $1
                or wr.runtime_context_json->>'goalRequirementDraftId' = $1
                or wr.runtime_context_json->>'goalRequirementDraftHash' = $3
          )
        )
        and status <> 'stale'`,
    [input.draftId, stalePayload, input.oldDraftHash],
  );
  const evaluation = await db.query(
    `update southstar.runtime_resources
        set status = 'stale', summary_json = summary_json || $2::jsonb, updated_at = now()
      where resource_type in ('goal_outcome', 'requirement_evaluator_result', 'evaluator_result', 'validator_result')
        and (
          payload_json->>'draftId' = $1
          or payload_json->>'goalRequirementDraftId' = $1
          or payload_json->>'goalRequirementDraftHash' = $3
          or run_id in (
            select wr.id from southstar.workflow_runs wr
             where wr.runtime_context_json->>'draftId' = $1
                or wr.runtime_context_json->>'goalRequirementDraftId' = $1
                or wr.runtime_context_json->>'goalRequirementDraftHash' = $3
          )
        )
        and status <> 'stale'`,
    [input.draftId, stalePayload, input.oldDraftHash],
  );
  await db.query(
    `update southstar.runtime_resources
        set status = 'stale', payload_json = payload_json || $2::jsonb,
            summary_json = summary_json || $2::jsonb, updated_at = now()
      where resource_type = 'library_import_draft'
        and payload_json->>'originGoalDraftId' = $1
        and payload_json->>'originGoalRequirementDraftHash' = $3
        and status = 'draft'`,
    [input.draftId, stalePayload, input.oldDraftHash],
  );
  return {
    validationBindings: (bindings.rowCount ?? 0) > 0,
    slicePlan: (slices.rowCount ?? 0) > 0,
    dagDraft: (dagDrafts.rowCount ?? 0) > 0,
    evidence: (evidence.rowCount ?? 0) > 0,
    evaluation: (evaluation.rowCount ?? 0) > 0,
  };
}

async function resolveGoalRequirementContractMetadata(
  db: SouthstarDb,
  draft: GoalRequirementDraftV1,
  input: {
    draftId?: string;
    goalInterpreter?: GoalContractInterpreter;
    goalContractMetadata?: GoalRequirementContractMetadata;
  },
): Promise<GoalRequirementContractMetadata> {
  const supplied = input.goalContractMetadata;
  if (input.goalInterpreter) {
    const skill = await loadGoalDesignSkillPg(db);
    const workspaceDiscovery = await discoverGoalWorkspace(draft.workspace.cwd);
    let interpreted: GoalRequirementContractMetadata;
    try {
      const contract = await input.goalInterpreter.interpret({
        goalPrompt: draft.originalPrompt,
        cwd: draft.workspace.cwd,
        ...(draft.workspace.projectRef !== undefined ? { projectRef: draft.workspace.projectRef } : {}),
        libraryVocabulary: await loadGoalContractLibraryVocabularyPg(db),
        goalDesignSkill: skill,
        workspaceDiscovery,
      });
      interpreted = contractMetadata(contract);
    } catch (error) {
      if (error instanceof GoalContractVocabularyGapError) interpreted = contractMetadata(error.goalContract);
      else throw error;
    }
    if (supplied) assertGoalRequirementMetadataEquivalent(interpreted, supplied);
    return interpreted;
  }
  if (supplied) {
    await assertGoalRequirementMetadataApproved(db, supplied);
    return supplied;
  }
  throw new GoalRequirementContractMetadataMissingError(input.draftId ?? draft.originalPrompt);
}

async function assertGoalRequirementMetadataApproved(
  db: SouthstarDb,
  metadata: GoalRequirementContractMetadata,
): Promise<void> {
  const vocabulary = await loadGoalContractLibraryVocabularyPg(db);
  if (vocabulary.scopes.length === 0 || !vocabulary.scopes.includes(metadata.domain)) {
    throw new GoalRequirementContractMetadataInvalidError(`Goal Contract domain is not in the approved Library vocabulary: ${metadata.domain}`);
  }
  const unknownCapabilities = metadata.requiredCapabilities.filter((ref) => !vocabulary.capabilityRefs.includes(ref));
  if (unknownCapabilities.length > 0) {
    throw new GoalRequirementContractMetadataInvalidError(`Goal Contract capabilities are not approved: ${unknownCapabilities.join(", ")}`);
  }
  const unknownArtifacts = metadata.expectedArtifactRefs.filter((ref) => !vocabulary.artifactRefs.includes(ref));
  if (unknownArtifacts.length > 0) {
    throw new GoalRequirementContractMetadataInvalidError(`Goal Contract artifacts are not approved: ${unknownArtifacts.join(", ")}`);
  }
}

function assertGoalRequirementMetadataEquivalent(
  interpreted: GoalRequirementContractMetadata,
  supplied: GoalRequirementContractMetadata,
): void {
  if (JSON.stringify(interpreted) !== JSON.stringify(supplied)) {
    throw new GoalRequirementContractMetadataInvalidError(
      "Goal Contract metadata does not match the approved interpreter result",
    );
  }
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

function goalContractMatchesRequirementDraft(
  contract: GoalContractV1,
  draft: GoalRequirementDraftV1,
): boolean {
  if (contract.workspace.cwd !== draft.workspace.cwd) return false;
  const activeDraftRequirements = draft.requirements.filter((requirement) => requirement.status !== "superseded");
  const draftById = new Map(activeDraftRequirements.map((requirement) => [requirement.id, requirement]));
  if (draftById.size !== contract.requirements.length) return false;
  return contract.requirements.every((requirement) => {
    const draftRequirement = draftById.get(requirement.id);
    const draftProjection = draftRequirement
      ? {
          statement: draftRequirement.statement,
          acceptanceCriteria: draftRequirement.acceptanceCriteria.map((criterion) => ({
            id: criterion.id,
            version: criterion.version,
            observableClaim: criterion.observableClaim,
            blocking: criterion.blocking,
            verificationIntent: [...criterion.verificationIntent],
            requiredAssurance: [...criterion.requiredAssurance],
          })),
          ...(draftRequirement.semanticTags !== undefined ? { semanticTags: [...draftRequirement.semanticTags] } : {}),
          blocking: draftRequirement.blocking,
          source: draftRequirement.source,
          expectedArtifacts: draftRequirement.expectedOutcomeArtifacts.map((artifact) => ({ ...artifact })),
        }
      : undefined;
    const contractProjection = {
      statement: requirement.statement,
      acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        version: criterion.version,
        observableClaim: criterion.observableClaim,
        blocking: criterion.blocking,
        verificationIntent: [...criterion.verificationIntent],
        requiredAssurance: [...criterion.requiredAssurance],
      })),
      ...(requirement.semanticTags !== undefined ? { semanticTags: [...requirement.semanticTags] } : {}),
      blocking: requirement.blocking,
      source: requirement.source,
      expectedArtifacts: requirement.expectedArtifacts.map((artifact) => ({ ...artifact })),
    };
    return draftProjection !== undefined
      && contentHashForPayload(draftProjection) === contentHashForPayload(contractProjection);
  });
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

function goalRequirementReviewReadiness(
  draft: GoalRequirementDraftV1,
  phase: GoalDesignPhase,
  contracts: UiInteractionContractV1[] = [],
): Pick<GoalRequirementReviewResult, "confirmable" | "validationIssues"> {
  const readiness = goalRequirementDraftReadiness(draft);
  const uiIssues = uiInteractionContractReadinessIssues(draft, contracts);
  const issues: GoalRequirementReviewIssue[] = [...readiness.issues, ...uiIssues];
  return {
    confirmable: phase === "requirements_review" && issues.length === 0,
    validationIssues: issues,
  };
}

function uiInteractionContractsFromStored(value: unknown, draft: GoalRequirementDraftV1): UiInteractionContractV1[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is UiInteractionContractV1 => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return validateUiInteractionContract(entry as UiInteractionContractV1, draft).length === 0;
  }).map((entry) => structuredClone(entry));
}

function uiInteractionContractReadinessIssues(
  draft: GoalRequirementDraftV1,
  contracts: UiInteractionContractV1[],
): GoalRequirementReviewIssue[] {
  const issues: GoalRequirementReviewIssue[] = [];
  const byId = new Map(contracts.map((entry) => [entry.id, entry]));
  for (const [requirementIndex, requirement] of draft.requirements.entries()) {
    if (requirement.status === "superseded") continue;
    for (const [refIndex, contractId] of requirement.interactionContractRefs.entries()) {
      const path = `requirements.${requirementIndex}.interactionContractRefs.${refIndex}`;
      const contract = byId.get(contractId);
      if (!contract) {
        issues.push({ code: "missing_ui_interaction_contract", path, message: `UI interaction contract is not available: ${contractId}` });
      } else if (contract.status !== "confirmed") {
        issues.push({ code: "unconfirmed_ui_interaction_contract", path, message: `UI interaction contract is not confirmed: ${contractId}` });
      }
    }
  }
  return issues;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function goalDesignPackageFromStored(value: unknown): GoalDesignPackageV3 | undefined {
  return goalDesignPackageV3FromUnknown(value);
}

type SliceDesignSource = {
  payload: Record<string, unknown>;
  requirementDraft: GoalRequirementDraftV1;
  goalContract: GoalContractV1;
  goalContractHash: string;
  resolution: GoalValidationResolutionV2;
};

function sliceDesignSourceFromPlannerRow(
  row: PlannerDraftResourceRow,
  expectedResolutionHash: string,
): SliceDesignSource {
  const payload = asRecord(row.payload_json);
  const phase = goalDesignPhaseFromPayload(payload);
  if (row.status !== "validation_ready" || phase !== "validation_ready") {
    throw new Error(`goal validation is not ready for Slice Design: ${row.resource_key}`);
  }
  const requirementDraft = goalRequirementDraftFromStored(payload.goalRequirementDraft);
  if (!requirementDraft || payload.goalRequirementDraftHash !== requirementDraft.draftHash) {
    throw new Error(`Goal Requirement draft lineage is invalid: ${row.resource_key}`);
  }
  const goalContract = storedGoalContract(payload.goalContract);
  if (!goalContract) throw new Error(`Goal Contract not found: ${row.resource_key}`);
  const contractHash = goalContractHash(goalContract);
  if (payload.goalContractHash !== contractHash) throw new Error(`Goal Contract lineage is invalid: ${row.resource_key}`);
  const resolution = storedGoalValidationResolution(payload.goalValidationResolution);
  if (!resolution || resolution.resolutionHash !== expectedResolutionHash) {
    throw new Error(`goal_validation_resolution_stale: ${row.resource_key}`);
  }
  if (resolution.goalContractHash !== contractHash
    || resolution.requirementDraftHash !== requirementDraft.draftHash
    || resolution.gaps.length > 0
    || resolution.ready !== true
    || resolution.bindings.length === 0) {
    throw new Error(`goal validation resolution is not complete: ${row.resource_key}`);
  }
  return { payload, requirementDraft, goalContract, goalContractHash: contractHash, resolution };
}

function sliceDesignRevisionSourceFromPlannerRow(
  row: PlannerDraftResourceRow,
  pkg: GoalDesignPackageV3,
): SliceDesignSource {
  const payload = asRecord(row.payload_json);
  const phase = goalDesignPhaseFromPayload(payload);
  if (row.status !== "ready_for_review" || phase !== "slice_review") {
    throw new Error(`Goal Design package is not in staged Slice review: ${row.resource_key}`);
  }
  const requirementDraft = goalRequirementDraftFromStored(payload.goalRequirementDraft);
  if (!requirementDraft || requirementDraft.draftHash !== pkg.requirementDraftHash) {
    throw new Error(`Goal Requirement draft lineage is invalid: ${row.resource_key}`);
  }
  const goalContract = storedGoalContract(payload.goalContract);
  if (!goalContract) throw new Error(`Goal Contract not found: ${row.resource_key}`);
  const contractHash = goalContractHash(goalContract);
  if (contractHash !== pkg.goalContractHash || payload.goalContractHash !== contractHash) {
    throw new Error(`Goal Contract lineage is invalid: ${row.resource_key}`);
  }
  const resolution = storedGoalValidationResolution(payload.goalValidationResolution);
  if (!resolution
    || resolution.ready !== true
    || resolution.gaps.length > 0
    || resolution.goalContractHash !== contractHash
    || resolution.requirementDraftHash !== requirementDraft.draftHash
    || contentHashForPayload(resolution.bindings) !== pkg.validationBindingsHash) {
    throw new Error(`Goal validation resolution lineage is invalid: ${row.resource_key}`);
  }
  return { payload, requirementDraft, goalContract, goalContractHash: contractHash, resolution };
}

function storedGoalValidationResolution(value: unknown): GoalValidationResolutionV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const resolution = value as GoalValidationResolutionV2;
  if (resolution.schemaVersion !== "southstar.goal_validation_resolution.v2"
    || !Array.isArray(resolution.bindings)
    || !Array.isArray(resolution.gaps)
    || !nonEmptyResolutionHash(resolution.resolutionHash)) return undefined;
  const { resolutionHash: _resolutionHash, ...withoutHash } = resolution;
  return contentHashForPayload(withoutHash) === resolution.resolutionHash ? resolution : undefined;
}

function storedTemplatePolicy(value: unknown): WorkflowTemplatePolicyV1 {
  const policy = asRecord(value);
  if (policy.mode === "prefer" || policy.mode === "require") {
    const templateRef = optionalNonEmptyString(policy.templateRef);
    const versionRef = optionalNonEmptyString(policy.versionRef);
    if (templateRef && versionRef) return { mode: policy.mode, templateRef, versionRef };
  }
  return { mode: "auto" };
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function nonEmptyResolutionHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
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
