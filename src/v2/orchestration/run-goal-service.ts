import { randomUUID } from "node:crypto";
import {
  createApprovalPg,
  deriveGoalExecutionRisk,
  type GoalExecutionApprovalPayload,
} from "../approvals/postgres-approval-service.ts";
import { evaluateApprovalPolicy } from "../approvals/policy.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { recordRuntimeExceptionPg } from "../exceptions/postgres-runtime-exceptions.ts";
import type { WorkflowComposer } from "./composer.ts";
import { materializeGoalExecutionSetPg } from "./goal-execution-set.ts";
import {
  loadCurrentGoalDesignPackagePg,
  preparePostgresGoalRequirementDraft,
  preparePostgresGoalDesignDraft,
  type GoalRequirementReviewResult,
} from "./goal-design-draft-service.ts";
import {
  validateGoalDesignPackage,
  type GoalDesigner,
  type GoalDesignMode,
  type GoalDesignPackageV1,
  type WorkflowTemplatePolicyV1,
} from "./goal-design.ts";
import {
  storedGoalContract,
  type GoalContractInterpreter,
  type GoalContractV1,
  type GoalContractVocabularyGapV1,
} from "./goal-contract.ts";
import { loadRunLibrarySnapshotPg } from "./run-library-snapshot.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { StartRunSchedulingResult } from "../server/run-execution-controller.ts";
import { startRunSchedulingPg } from "../server/run-execution-controller.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../ui-api/postgres-run-api.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import type { LibraryImportLlmProvider } from "../design-library/importers/library-llm-import-analyzer.ts";
import type { LibraryImportSourceFetcher } from "../design-library/importers/library-source-fetcher.ts";
import type { GoalRequirementDraftInterpreter, GoalRequirementDraftIssue } from "./goal-requirement-draft.ts";

export type RunGoalRequest = {
  goalPrompt: string;
  cwd: string;
  projectRef?: string;
  idempotencyKey: string;
  goalDesignMode?: GoalDesignMode;
  templatePolicy?: WorkflowTemplatePolicyV1;
};

export type RunGoalResult = {
  goalDesignPackageHash?: string;
  goalRequirementDraftId?: string;
  goalRequirementDraftHash?: string;
  goalDesignPhase?: string;
  goalContractHash: string;
  draftId: string;
  draftStatus: "requirements_review" | "validation_resolving" | "library_review" | "validation_ready" | "needs_input" | "needs_library_input" | "invalid" | "template_incompatible" | "ready_for_review" | "validated";
  runId?: string;
  runStatus?: "created" | "awaiting_approval" | "scheduling";
  approvalId?: string;
  executionSetId?: string;
  sliceRuns?: SliceRunResult[];
  blockers: string[];
  vocabularyGaps?: GoalContractVocabularyGapV1[];
  libraryImportDraftId?: string;
  schedulerExceptionId?: string;
  /** Host-owned requirement review projection (present for requirement-review results). */
  confirmable?: boolean;
  validationIssues?: GoalRequirementDraftIssue[];
};

export type SliceRunResult = {
  sliceId: string;
  runId: string;
  runStatus: "created" | "awaiting_approval" | "scheduling";
  approvalId: string;
};

export type SubmitGoalContext = {
  db: SouthstarDb;
  goalInterpreter: GoalContractInterpreter;
  goalRequirementInterpreter?: GoalRequirementDraftInterpreter;
  goalDesigner?: GoalDesigner;
  composer?: WorkflowComposer;
  libraryImportLlmProvider?: LibraryImportLlmProvider;
  libraryImportSourceFetcher?: LibraryImportSourceFetcher;
  startScheduling?: (db: SouthstarDb, input: { runId: string }) => Promise<StartRunSchedulingResult>;
  onStage?: (stage: string, data?: Record<string, unknown>) => void;
};

export class GoalSubmissionConflictError extends Error {
  readonly status = 409;
}

export class GoalSubmissionPendingError extends Error {
  readonly status = 202;

  constructor(readonly submissionId: string) {
    super(`goal submission is already processing: ${submissionId}`);
  }
}

export type GoalSubmissionClaim = {
  submissionId: string;
  result?: RunGoalResult;
  schedulingRequest?: RunGoalResult;
  stages: string[];
};

export async function submitGoalPg(context: SubmitGoalContext, request: RunGoalRequest): Promise<RunGoalResult> {
  validateRequest(request);
  const claim = await claimGoalSubmissionPg(context.db, request);
  return await submitClaimedGoalPg(context, request, claim);
}

export async function submitClaimedGoalPg(
  context: SubmitGoalContext,
  request: RunGoalRequest,
  claim: GoalSubmissionClaim,
): Promise<RunGoalResult> {
  if (claim.result) {
    for (const stage of claim.stages) context.onStage?.(stage);
    return claim.result;
  }
  if (claim.schedulingRequest) {
    for (const stage of claim.stages) context.onStage?.(stage);
    return await completeGoalSchedulingHandoffPg(context, claim.submissionId);
  }
  if (context.goalRequirementInterpreter) {
    return await submitGoalRequirementDraftPg(context, request, claim);
  }
  if (context.goalDesigner) {
    return await submitGoalDesignDraftPg(context, request, claim);
  }

  const observedStages: string[] = [];
  let draftResource: Parameters<typeof upsertRuntimeResourcePg>[1] | undefined;
  let draft: Awaited<ReturnType<typeof createPostgresPlannerDraft>>;
  try {
    draft = await createPostgresPlannerDraft(context.db, {
      goalPrompt: request.goalPrompt,
      cwd: request.cwd,
      goalInterpreter: context.goalInterpreter,
      composer: context.composer,
      async persistDraft(resource) {
        draftResource = resource;
      },
      onProgress(event) {
        if (event.stage === "goal_contract.interpreted" || event.stage === "draft.persisted") {
          observedStages.push(event.stage);
        }
      },
    });
    if (!draftResource) throw new Error(`planner draft was not prepared: ${draft.draftId}`);
  } catch (error) {
    await failSubmissionPg(context.db, claim.submissionId, error, observedStages);
    throw error;
  }

  if (draft.status !== "validated") {
    const result: RunGoalResult = {
      goalContractHash: draft.goalContractHash,
      draftId: draft.draftId,
      draftStatus: draft.status === "needs_library_input"
        ? "needs_library_input"
        : draft.status === "needs_input"
          ? "needs_input"
          : "invalid",
      blockers: draft.blockers,
      ...(draft.vocabularyGaps ? { vocabularyGaps: draft.vocabularyGaps } : {}),
      ...(draft.libraryImportDraftId ? { libraryImportDraftId: draft.libraryImportDraftId } : {}),
    };
    const finalStages = draft.status === "needs_library_input"
      ? ["draft.needs_library_input", "done"]
      : draft.status === "needs_input"
        ? ["draft.needs_input", "done"]
        : ["done"];
    try {
      await context.db.tx(async (tx) => {
        await upsertRuntimeResourcePg(tx, draftResource!);
        await completeSubmissionPg(tx, claim.submissionId, result, [...observedStages, ...finalStages]);
      });
    } catch (error) {
      await failSubmissionPg(context.db, claim.submissionId, error, []);
      throw error;
    }
    [...observedStages, ...finalStages].forEach((stage) => context.onStage?.(stage));
    return result;
  }

  let transaction: {
    result: RunGoalResult;
    stages: string[];
    autoSchedule: boolean;
  };
  try {
    transaction = await context.db.tx(async (tx) => {
      await upsertRuntimeResourcePg(tx, draftResource!);
      return await createRunRequestFromValidatedDraftTx(tx, {
        draft,
        resourceId: claim.submissionId,
        observedStages,
      });
    });
  } catch (error) {
    await failSubmissionPg(context.db, claim.submissionId, error, []);
    throw error;
  }
  transaction.stages.forEach((stage) => context.onStage?.(stage));
  if (!transaction.autoSchedule || !transaction.result.runId) return transaction.result;

  return await completeGoalSchedulingHandoffPg(context, claim.submissionId);
}

async function submitGoalRequirementDraftPg(
  context: SubmitGoalContext,
  request: RunGoalRequest,
  claim: GoalSubmissionClaim,
): Promise<RunGoalResult> {
  const observedStages: string[] = [];
  let draft: GoalRequirementReviewResult;
  try {
    draft = await preparePostgresGoalRequirementDraft(context.db, {
      goalPrompt: request.goalPrompt,
      cwd: request.cwd,
      ...(request.projectRef !== undefined ? { projectRef: request.projectRef } : {}),
      mode: request.goalDesignMode ?? "review_before_compose",
      templatePolicy: request.templatePolicy ?? { mode: "auto" },
      requirementInterpreter: context.goalRequirementInterpreter!,
      onProgress(event) {
        observedStages.push(event.stage);
        if (event.stage === "requirements.persisted") {
          context.onStage?.(event.stage, event.package as Record<string, unknown> | undefined);
        } else {
          context.onStage?.(event.stage);
        }
      },
    });
  } catch (error) {
    await failSubmissionPg(context.db, claim.submissionId, error, observedStages);
    throw error;
  }
  const result: RunGoalResult = {
    goalContractHash: "",
    goalRequirementDraftId: draft.draftId,
    goalRequirementDraftHash: draft.goalRequirementDraftHash,
    goalDesignPhase: draft.phase,
    draftId: draft.draftId,
    draftStatus: draft.status,
    blockers: draft.blockers,
    confirmable: draft.confirmable,
    validationIssues: draft.validationIssues,
  };
  try {
    await completeSubmissionPg(context.db, claim.submissionId, result, [...observedStages, "draft.requirements_review", "done"]);
  } catch (error) {
    await failSubmissionPg(context.db, claim.submissionId, error, observedStages);
    throw error;
  }
  context.onStage?.("draft.requirements_review", {
    draftId: draft.draftId,
    goalRequirementDraftHash: draft.goalRequirementDraftHash,
    goalRequirementDraft: draft.goalRequirementDraft,
    confirmable: draft.confirmable,
    validationIssues: draft.validationIssues,
  });
  context.onStage?.("done");
  return result;
}

async function submitGoalDesignDraftPg(
  context: SubmitGoalContext,
  request: RunGoalRequest,
  claim: GoalSubmissionClaim,
): Promise<RunGoalResult> {
  const observedStages: string[] = [];
  let draft: Awaited<ReturnType<typeof preparePostgresGoalDesignDraft>>;
  const goalDesignMode = request.goalDesignMode ?? "review_before_compose";
  const templatePolicy = request.templatePolicy ?? { mode: "auto" };
  try {
    draft = await preparePostgresGoalDesignDraft(context.db, {
      goalPrompt: request.goalPrompt,
      cwd: request.cwd,
      ...(request.projectRef !== undefined ? { projectRef: request.projectRef } : {}),
      mode: goalDesignMode,
      templatePolicy,
      goalInterpreter: context.goalInterpreter,
      goalDesigner: context.goalDesigner!,
      libraryImportLlmProvider: context.libraryImportLlmProvider,
      libraryImportSourceFetcher: context.libraryImportSourceFetcher,
      onProgress(event) {
        if (event.stage === "goal_contract.interpreted" || event.stage === "goal_design.persisted" || event.stage === "draft.persisted") {
          observedStages.push(event.stage);
        }
      },
    });
  } catch (error) {
    await failSubmissionPg(context.db, claim.submissionId, error, observedStages);
    throw error;
  }
  const draftStatus = draft.status === "ready_for_review"
    ? "ready_for_review"
    : draft.status === "needs_library_input"
      ? "needs_library_input"
    : draft.status === "needs_input"
      ? "needs_input"
      : draft.status === "template_incompatible"
        ? "template_incompatible"
        : draft.status === "validated"
          ? "validated"
          : "invalid";
  const result: RunGoalResult = {
    goalContractHash: draft.goalContractHash,
    ...(draft.goalDesignPackageHash ? { goalDesignPackageHash: draft.goalDesignPackageHash } : {}),
    draftId: draft.draftId,
    draftStatus,
    blockers: draft.blockers,
    ...(draft.vocabularyGaps ? { vocabularyGaps: draft.vocabularyGaps } : {}),
    ...(draft.libraryImportDraftId ? { libraryImportDraftId: draft.libraryImportDraftId } : {}),
  };
  const finalStages = draftStatus === "ready_for_review"
    ? ["draft.ready_for_review", "done"]
    : draftStatus === "needs_library_input"
      ? ["draft.needs_library_input", "done"]
    : draftStatus === "needs_input"
      ? ["draft.needs_input", "done"]
      : ["done"];
  try {
    if (goalDesignMode === "auto_until_blocked" && draftStatus === "ready_for_review" && draft.goalDesignPackageHash) {
      const autoResult = await continueGoalDesignToRunPg(context, {
        draftId: draft.draftId,
        expectedPackageHash: draft.goalDesignPackageHash,
        confirmationMode: "auto",
      });
      await completeSubmissionPg(context.db, claim.submissionId, autoResult, [...observedStages, "done"]);
      for (const stage of observedStages) {
        context.onStage?.(stage, stage === "goal_design.persisted"
          ? { draftId: draft.draftId, goalDesignPackageHash: draft.goalDesignPackageHash, draftStatus: result.draftStatus, package: draft.goalDesignPackage }
          : undefined);
      }
      return autoResult;
    }
    await completeSubmissionPg(context.db, claim.submissionId, result, [...observedStages, ...finalStages]);
  } catch (error) {
    await failSubmissionPg(context.db, claim.submissionId, error, []);
    throw error;
  }
  for (const stage of observedStages) {
    context.onStage?.(stage, stage === "goal_design.persisted"
      ? { draftId: draft.draftId, goalDesignPackageHash: draft.goalDesignPackageHash, draftStatus: result.draftStatus, package: draft.goalDesignPackage }
      : undefined);
  }
  finalStages.forEach((stage) => context.onStage?.(stage));
  return result;
}

export async function confirmGoalDesignPg(
  context: SubmitGoalContext,
  input: { draftId: string; expectedPackageHash: string },
): Promise<RunGoalResult> {
  return await continueGoalDesignToRunPg(context, {
    ...input,
    confirmationMode: "manual",
  });
}

export async function continueGoalDesignToRunPg(
  context: SubmitGoalContext,
  input: { draftId: string; expectedPackageHash: string; confirmationMode: "manual" | "auto" },
): Promise<RunGoalResult> {
  requiredString(input.draftId, "draftId");
  requiredString(input.expectedPackageHash, "expectedPackageHash");
  const prepared = await prepareGoalDesignConfirmationPg(context.db, input);
  if (prepared.result) {
    if (prepared.schedulingRequest) {
      prepared.stages.forEach((stage) => context.onStage?.(stage));
      return await completeGoalSchedulingHandoffPg(context, prepared.confirmationId);
    }
    prepared.stages.forEach((stage) => context.onStage?.(stage));
    return prepared.result;
  }

  const observedStages: string[] = [];
  let composedDraft: Awaited<ReturnType<typeof createPostgresPlannerDraft>>;
  try {
    if (prepared.package.compositionStrategy.mode === "per-slice-runs") {
      const executionSet = await materializeGoalExecutionSetPg(context, {
        draftId: input.draftId,
        expectedPackageHash: input.expectedPackageHash,
        ...(prepared.goalRequirementDraftId ? { goalRequirementDraftId: prepared.goalRequirementDraftId } : {}),
        ...(prepared.goalRequirementDraftHash ? { goalRequirementDraftHash: prepared.goalRequirementDraftHash } : {}),
      });
      const result: RunGoalResult = {
        goalContractHash: prepared.package.goalContractHash,
        ...(prepared.goalRequirementDraftId ? { goalRequirementDraftId: prepared.goalRequirementDraftId } : {}),
        ...(prepared.goalRequirementDraftHash ? { goalRequirementDraftHash: prepared.goalRequirementDraftHash } : {}),
        goalDesignPackageHash: prepared.package.packageHash,
        draftId: input.draftId,
        draftStatus: "validated",
        executionSetId: executionSet.id,
        sliceRuns: executionSet.entries.map((entry) => ({
          sliceId: entry.sliceId,
          runId: entry.runId,
          runStatus: sliceRunStatus(entry.status),
          approvalId: entry.approvalId,
        })),
        blockers: [],
      };
      await completeConfirmationPg(context.db, prepared.confirmationId, result, ["goal_execution_set.materialized", "done"]);
      return result;
    }
    composedDraft = await createPostgresPlannerDraft(context.db, {
      goalPrompt: prepared.goalPrompt,
      cwd: prepared.cwd,
      ...(prepared.projectRef !== undefined ? { projectRef: prepared.projectRef } : {}),
      goalInterpreter: fixedGoalInterpreter(prepared.package.goalContract),
      goalDesignPackage: prepared.package,
      composer: context.composer,
      ...(prepared.goalRequirementDraftId ? { goalRequirementDraftId: prepared.goalRequirementDraftId } : {}),
      ...(prepared.goalRequirementDraftHash ? { goalRequirementDraftHash: prepared.goalRequirementDraftHash } : {}),
      onProgress(event) {
        observedStages.push(event.stage);
        context.onStage?.(event.stage);
      },
    });
  } catch (error) {
    await failConfirmationPg(context.db, prepared.confirmationId, error, observedStages);
    throw error;
  }

  if (composedDraft.status !== "validated") {
    const draftStatus = composedDraft.status === "needs_library_input"
      ? "needs_library_input"
      : composedDraft.status === "needs_input"
        ? "needs_input"
        : "invalid";
    const result: RunGoalResult = {
      goalContractHash: composedDraft.goalContractHash,
      goalDesignPackageHash: prepared.package.packageHash,
      draftId: composedDraft.draftId,
      draftStatus,
      blockers: composedDraft.blockers,
      ...(prepared.goalRequirementDraftId ? { goalRequirementDraftId: prepared.goalRequirementDraftId } : {}),
      ...(prepared.goalRequirementDraftHash ? { goalRequirementDraftHash: prepared.goalRequirementDraftHash } : {}),
      ...(composedDraft.vocabularyGaps ? { vocabularyGaps: composedDraft.vocabularyGaps } : {}),
      ...(composedDraft.libraryImportDraftId ? { libraryImportDraftId: composedDraft.libraryImportDraftId } : {}),
    };
    await completeConfirmationPg(context.db, prepared.confirmationId, result, [...observedStages, "done"]);
    return result;
  }

  const transaction = await context.db.tx(async (tx) => {
    await assertCurrentGoalDesignPackageHashTx(tx, input.draftId, input.expectedPackageHash);
    const confirmation = await tx.one<{ status: string; payload_json: Record<string, unknown> }>(
      "select status, payload_json from southstar.runtime_resources where id = $1 for update",
      [prepared.confirmationId],
    );
    if (confirmation.status === "completed") {
      return {
        result: requireRunGoalResult(confirmation.payload_json.result),
        stages: stringArray(confirmation.payload_json.stages),
        autoSchedule: confirmation.payload_json.schedulingState === "requested",
      };
    }
    if (confirmation.status !== "composing") {
      throw new Error(`goal design confirmation is not composing: ${prepared.confirmationId}`);
    }
    return await createRunRequestFromValidatedDraftTx(tx, {
      draft: {
        ...composedDraft,
        goalDesignPackageHash: prepared.package.packageHash,
      },
      resourceId: prepared.confirmationId,
      observedStages,
    });
  });
  transaction.stages.forEach((stage) => context.onStage?.(stage));
  if (!transaction.autoSchedule || !transaction.result.runId) return transaction.result;
  return await completeGoalSchedulingHandoffPg(context, prepared.confirmationId);
}

function sliceRunStatus(status: string): SliceRunResult["runStatus"] {
  if (status === "awaiting_approval") return "awaiting_approval";
  if (status === "scheduling" || status === "running") return "scheduling";
  return "created";
}

type GoalDesignConfirmationPreparation = {
  confirmationId: string;
  package: GoalDesignPackageV1;
  goalPrompt: string;
  cwd: string;
  projectRef?: string;
  goalRequirementDraftId?: string;
  goalRequirementDraftHash?: string;
  stages: string[];
  result?: RunGoalResult;
  schedulingRequest?: RunGoalResult;
};

async function prepareGoalDesignConfirmationPg(
  db: SouthstarDb,
  input: { draftId: string; expectedPackageHash: string; confirmationMode: "manual" | "auto" },
): Promise<GoalDesignConfirmationPreparation> {
  return await db.tx(async (tx) => {
    const draft = await tx.one<{ payload_json: Record<string, unknown>; status: string }>(
      "select payload_json, status from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1 for update",
      [input.draftId],
    );
    if (draft.status !== "ready_for_review") {
      throw new Error(`goal design draft is not ready for review: ${input.draftId}`);
    }
    const pkg = storedGoalDesignPackage(asRecord(draft.payload_json).goalDesignPackage);
    if (!pkg) throw new Error(`Goal Design package not found: ${input.draftId}`);
    if (pkg.packageHash !== input.expectedPackageHash) {
      throw new Error(`goal_design_package_stale: ${input.draftId}`);
    }
    const plannerRequest = asRecord(draft.payload_json.plannerRequest);
    const goalRequirementDraftId = optionalString(draft.payload_json.goalRequirementDraftId)
      ?? optionalString(plannerRequest.goalRequirementDraftId);
    const goalRequirementDraftHash = optionalString(draft.payload_json.goalRequirementDraftHash)
      ?? optionalString(plannerRequest.goalRequirementDraftHash);
    const goalPrompt = optionalString(plannerRequest.goalPrompt)
      ?? pkg.goalContract.originalPrompt;
    const cwd = optionalString(plannerRequest.cwd)
      ?? optionalString(asRecord(pkg.goalContract.workspace).cwd)
      ?? process.cwd();
    const projectRef = optionalString(plannerRequest.projectRef)
      ?? optionalString(asRecord(pkg.goalContract.workspace).projectRef);
    const confirmationId = `goal-design-confirmation-${randomUUID()}`;
    const inserted = await tx.maybeOne<{ id: string }>(
      `insert into southstar.runtime_resources (
         id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json
       ) values ($1, 'goal_design_confirmation', $2, 'planner', 'composing', $3, $4::jsonb, $5::jsonb, '{}'::jsonb)
       on conflict (resource_type, resource_key) do nothing
       returning id`,
      [
        confirmationId,
        input.draftId,
        "Goal Design Confirmation",
        JSON.stringify({
          draftId: input.draftId,
          ...(goalRequirementDraftId ? { goalRequirementDraftId } : {}),
          ...(goalRequirementDraftHash ? { goalRequirementDraftHash } : {}),
          packageHash: input.expectedPackageHash,
          confirmationMode: input.confirmationMode,
          stages: [],
        }),
        JSON.stringify({
          draftId: input.draftId,
          packageHash: input.expectedPackageHash,
          confirmationMode: input.confirmationMode,
        }),
      ],
    );
    if (inserted) {
      return {
        confirmationId: inserted.id,
        package: pkg,
        goalPrompt,
        cwd,
        ...(projectRef ? { projectRef } : {}),
        ...(goalRequirementDraftId ? { goalRequirementDraftId } : {}),
        ...(goalRequirementDraftHash ? { goalRequirementDraftHash } : {}),
        stages: [],
      };
    }
    const existing = await tx.one<{ id: string; status: string; payload_json: Record<string, unknown> }>(
      "select id, status, payload_json from southstar.runtime_resources where resource_type = 'goal_design_confirmation' and resource_key = $1 for update",
      [input.draftId],
    );
    if (existing.status === "stale") {
      await tx.query(
        "update southstar.runtime_resources set status = 'composing', payload_json = $2::jsonb, summary_json = $3::jsonb, updated_at = now() where id = $1",
        [
          existing.id,
          JSON.stringify({
            draftId: input.draftId,
            ...(goalRequirementDraftId ? { goalRequirementDraftId } : {}),
            ...(goalRequirementDraftHash ? { goalRequirementDraftHash } : {}),
            packageHash: input.expectedPackageHash,
            confirmationMode: input.confirmationMode,
            stages: [],
            attempt: Number(existing.payload_json.attempt ?? 0) + 1,
          }),
          JSON.stringify({
            draftId: input.draftId,
            packageHash: input.expectedPackageHash,
            confirmationMode: input.confirmationMode,
          }),
        ],
      );
      return {
        confirmationId: existing.id,
        package: pkg,
        goalPrompt,
        cwd,
        ...(projectRef ? { projectRef } : {}),
        ...(goalRequirementDraftId ? { goalRequirementDraftId } : {}),
        ...(goalRequirementDraftHash ? { goalRequirementDraftHash } : {}),
        stages: [],
      };
    }
    if (existing.payload_json.packageHash !== input.expectedPackageHash) {
      throw new Error(`goal_design_confirmation_conflict: ${input.draftId}`);
    }
    const stages = stringArray(existing.payload_json.stages);
    if (existing.status === "completed") {
      return {
        confirmationId: existing.id,
        package: pkg,
        goalPrompt,
        cwd,
        ...(projectRef ? { projectRef } : {}),
        ...(goalRequirementDraftId ? { goalRequirementDraftId } : {}),
        ...(goalRequirementDraftHash ? { goalRequirementDraftHash } : {}),
        stages,
        result: requireRunGoalResult(existing.payload_json.result),
        ...(existing.payload_json.schedulingState === "requested"
          ? { schedulingRequest: requireRunGoalResult(existing.payload_json.schedulingRequest) }
          : {}),
      };
    }
    if (existing.status === "failed") {
      const { failure: _failure, failedAt: _failedAt, result: _result, ...payload } = existing.payload_json;
      await tx.query(
        "update southstar.runtime_resources set status = 'composing', payload_json = $2::jsonb, summary_json = $3::jsonb, updated_at = now() where id = $1",
        [
          existing.id,
          JSON.stringify({ ...payload, stages: [], attempt: Number(payload.attempt ?? 1) + 1 }),
          JSON.stringify({
            draftId: input.draftId,
            packageHash: input.expectedPackageHash,
            confirmationMode: input.confirmationMode,
          }),
        ],
      );
      return {
        confirmationId: existing.id,
        package: pkg,
        goalPrompt,
        cwd,
        ...(projectRef ? { projectRef } : {}),
        ...(goalRequirementDraftId ? { goalRequirementDraftId } : {}),
        ...(goalRequirementDraftHash ? { goalRequirementDraftHash } : {}),
        stages: [],
      };
    }
    throw new GoalSubmissionPendingError(existing.id);
  });
}

async function assertCurrentGoalDesignPackageHashTx(
  db: SouthstarDb,
  draftId: string,
  expectedPackageHash: string,
): Promise<void> {
  const current = await loadCurrentGoalDesignPackagePg(db, draftId);
  if (current.packageHash !== expectedPackageHash) {
    throw new Error(`goal_design_package_stale: ${draftId}`);
  }
}

async function createRunRequestFromValidatedDraftTx(
  tx: SouthstarDb,
  input: {
    draft: Awaited<ReturnType<typeof createPostgresPlannerDraft>>;
    resourceId: string;
    observedStages: string[];
  },
): Promise<{
  result: RunGoalResult;
  stages: string[];
  autoSchedule: boolean;
}> {
  const run = await createPostgresRunFromDraft(tx, { draftId: input.draft.draftId });
  const runRow = await tx.one<{
    workflow_manifest_json: SouthstarWorkflowManifest;
    runtime_context_json: Record<string, unknown>;
  }>("select workflow_manifest_json, runtime_context_json from southstar.workflow_runs where id = $1 for update", [run.runId]);
  const storedDraftResource = await getResourceByKeyPg(tx, "planner_draft", input.draft.draftId);
  const goalContract = storedGoalContract(asRecord(storedDraftResource?.payload).goalContract);
  if (!goalContract) throw new Error(`planner draft Goal Contract missing: ${input.draft.draftId}`);
  const librarySnapshot = await loadRunLibrarySnapshotPg(tx, run.runId);
  const risk = deriveGoalExecutionRisk({
    goalContract,
    workflow: runRow.workflow_manifest_json,
    librarySnapshot,
  });
  const policy = evaluateApprovalPolicy({ mode: "policy", actionType: "goalExecution", riskTags: risk.riskTags });
  const approvalPayload: GoalExecutionApprovalPayload = {
    actionType: "goalExecution",
    decisionMode: policy.decisionMode,
    policyReason: policy.reason,
    riskTags: risk.riskTags,
    requestedSideEffects: goalContract.requestedSideEffects,
    goalContractHash: input.draft.goalContractHash,
    manifestHash: requiredString(runRow.runtime_context_json.manifestHash, "manifestHash"),
    librarySnapshotHash: librarySnapshot.snapshotHash,
    sideEffectEnvelopeHash: risk.sideEffectEnvelopeHash,
  };
  const approval = await createApprovalPg(tx, {
    runId: run.runId,
    actionType: "goalExecution",
    riskTags: risk.riskTags,
    title: "Goal execution approval",
    payload: approvalPayload,
    status: policy.status === "approved" ? "approved" : "pending",
  });
  if (policy.status === "pending") {
    await tx.query("update southstar.workflow_runs set status = 'awaiting_approval', updated_at = now() where id = $1", [run.runId]);
  }
  const result: RunGoalResult = {
    goalContractHash: input.draft.goalContractHash,
    ...(input.draft.goalRequirementDraftId ? { goalRequirementDraftId: input.draft.goalRequirementDraftId } : {}),
    ...(input.draft.goalRequirementDraftHash ? { goalRequirementDraftHash: input.draft.goalRequirementDraftHash } : {}),
    ...(input.draft.goalDesignPackageHash ? { goalDesignPackageHash: input.draft.goalDesignPackageHash } : {}),
    draftId: input.draft.draftId,
    draftStatus: "validated",
    runId: run.runId,
    runStatus: policy.status === "approved" ? "created" : "awaiting_approval",
    approvalId: approval.id,
    blockers: input.draft.blockers,
  };
  const stages = [
    ...input.observedStages,
    "coverage.validated",
    "library_snapshot.persisted",
    "approval.persisted",
    ...(policy.status === "pending" ? ["run.awaiting_approval", "done"] : []),
  ];
  if (policy.status === "approved") await requestGoalSchedulingPg(tx, input.resourceId, result, stages);
  else await completeSubmissionPg(tx, input.resourceId, result, stages);
  return { result, stages, autoSchedule: policy.status === "approved" };
}

async function completeConfirmationPg(
  db: SouthstarDb,
  confirmationId: string,
  result: RunGoalResult,
  stages: string[],
): Promise<void> {
  await completeSubmissionPg(db, confirmationId, result, stages);
}

async function failConfirmationPg(
  db: SouthstarDb,
  confirmationId: string,
  error: unknown,
  stages: string[],
): Promise<void> {
  await failSubmissionPg(db, confirmationId, error, stages);
}

function fixedGoalInterpreter(goalContract: GoalContractV1): GoalContractInterpreter {
  return {
    async interpret() {
      return goalContract;
    },
  };
}

async function completeGoalSchedulingHandoffPg(
  context: SubmitGoalContext,
  submissionId: string,
): Promise<RunGoalResult> {
  const finalized = await context.db.tx(async (tx) => {
    const submission = await tx.one<{ status: string; payload_json: Record<string, unknown> }>(
      "select status, payload_json from southstar.runtime_resources where id = $1 for update",
      [submissionId],
    );
    if (submission.status === "completed") return {
      result: requireRunGoalResult(submission.payload_json.result),
      finalStages: [] as string[],
    };
    if ((submission.status !== "processing" && submission.status !== "composing") || submission.payload_json.schedulingState !== "requested") {
      throw new Error(`goal submission scheduling was not requested: ${submissionId}`);
    }
    const requestedResult = requireRunGoalResult(submission.payload_json.schedulingRequest);
    const runId = requiredString(requestedResult.runId, "runId");
    let schedulingError: unknown;
    try {
      await (context.startScheduling ?? startRunSchedulingPg)(tx, { runId });
    } catch (error) {
      schedulingError = error;
      await tx.query("update southstar.workflow_runs set status = 'created', updated_at = now() where id = $1", [runId]);
    }
    const exception = schedulingError === undefined
      ? undefined
      : await recordRuntimeExceptionPg(tx, {
        runId,
        source: "scheduler",
        kind: "provider_unreachable",
        severity: "blocking",
        observedAt: new Date().toISOString(),
        evidenceRefs: [`run:${runId}:scheduling-wakeup`],
        providerEvidence: { error: schedulingError instanceof Error ? schedulingError.message : String(schedulingError) },
      });
    const result: RunGoalResult = {
      ...requestedResult,
      runStatus: exception ? "created" : "scheduling",
      ...(exception ? { schedulerExceptionId: exception.id } : {}),
    };
    const finalStages = exception ? ["done"] : ["run.scheduling_started", "done"];
    await completeSubmissionPg(tx, submissionId, result, finalStages);
    return { result, finalStages };
  });
  finalized.finalStages.forEach((stage) => context.onStage?.(stage));
  return finalized.result;
}

export async function claimGoalSubmissionPg(db: SouthstarDb, request: RunGoalRequest): Promise<GoalSubmissionClaim> {
  validateRequest(request);
  const requestHash = contentHashForPayload(request);
  return await db.tx(async (tx) => {
    const submissionId = `goal-submission-${randomUUID()}`;
    const inserted = await tx.maybeOne<{ id: string }>(
      `insert into southstar.runtime_resources (
         id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json
       ) values ($1, 'goal_submission', $2, 'planner', 'processing', 'Goal submission', $3::jsonb, '{}'::jsonb, '{}'::jsonb)
       on conflict (resource_type, resource_key) do nothing
       returning id`,
      [submissionId, request.idempotencyKey, JSON.stringify({ requestHash, request, stages: [] })],
    );
    if (inserted) return { submissionId: inserted.id, stages: [] };
    const observed = await tx.one<{ id: string; status: string; payload_json: Record<string, unknown> }>(
      "select id, status, payload_json from southstar.runtime_resources where resource_type = 'goal_submission' and resource_key = $1",
      [request.idempotencyKey],
    );
    if (observed.payload_json.requestHash !== requestHash) {
      throw new GoalSubmissionConflictError(`idempotency key already belongs to a different goal submission: ${request.idempotencyKey}`);
    }
    const observedStages = stringArray(observed.payload_json.stages);
    if (observed.status === "completed") {
      return { submissionId: observed.id, result: requireRunGoalResult(observed.payload_json.result), stages: observedStages };
    }
    if (observed.status === "processing" && observed.payload_json.schedulingState !== "requested") {
      throw new GoalSubmissionPendingError(observed.id);
    }
    let existing: typeof observed;
    try {
      existing = await tx.one<typeof observed>(
        "select id, status, payload_json from southstar.runtime_resources where resource_type = 'goal_submission' and resource_key = $1 for update nowait",
        [request.idempotencyKey],
      );
    } catch (error) {
      if (postgresErrorCode(error) === "55P03") throw new GoalSubmissionPendingError(observed.id);
      throw error;
    }
    const stages = stringArray(existing.payload_json.stages);
    if (existing.status === "completed") {
      return { submissionId: existing.id, result: requireRunGoalResult(existing.payload_json.result), stages };
    }
    if (existing.status === "processing" && existing.payload_json.schedulingState === "requested") {
      return {
        submissionId: existing.id,
        schedulingRequest: requireRunGoalResult(existing.payload_json.schedulingRequest),
        stages,
      };
    }
    if (existing.status === "failed") {
      const { failure: _failure, failedAt: _failedAt, retryable: _retryable, result: _result, ...payload } = existing.payload_json;
      await tx.query(
        "update southstar.runtime_resources set status = 'processing', payload_json = $2::jsonb, summary_json = '{}'::jsonb, updated_at = now() where id = $1",
        [existing.id, JSON.stringify({ ...payload, stages: [], attempt: Number(payload.attempt ?? 1) + 1 })],
      );
      return { submissionId: existing.id, stages: [] };
    }
    throw new GoalSubmissionPendingError(existing.id);
  });
}

async function requestGoalSchedulingPg(
  db: SouthstarDb,
  submissionId: string,
  schedulingRequest: RunGoalResult,
  stages: string[],
): Promise<void> {
  const row = await db.one<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where id = $1 for update",
    [submissionId],
  );
  await db.query(
    "update southstar.runtime_resources set payload_json = $2::jsonb, updated_at = now() where id = $1",
    [submissionId, JSON.stringify({
      ...row.payload_json,
      stages: [...stringArray(row.payload_json.stages), ...stages],
      schedulingState: "requested",
      schedulingRequest,
    })],
  );
}

async function persistStagesPg(db: SouthstarDb, submissionId: string, stages: string[]): Promise<void> {
  if (stages.length === 0) return;
  await db.tx(async (tx) => {
    const row = await tx.one<{ payload_json: Record<string, unknown> }>(
      "select payload_json from southstar.runtime_resources where id = $1 for update",
      [submissionId],
    );
    await tx.query(
      "update southstar.runtime_resources set payload_json = $2::jsonb, updated_at = now() where id = $1",
      [submissionId, JSON.stringify({ ...row.payload_json, stages: [...stringArray(row.payload_json.stages), ...stages] })],
    );
  });
}

async function completeSubmissionPg(
  db: SouthstarDb,
  submissionId: string,
  result: RunGoalResult,
  stages: string[],
): Promise<void> {
  const row = await db.one<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where id = $1 for update",
    [submissionId],
  );
  await db.query(
    "update southstar.runtime_resources set status = 'completed', payload_json = $2::jsonb, summary_json = $3::jsonb, updated_at = now() where id = $1",
    [
      submissionId,
      JSON.stringify({ ...row.payload_json, stages: [...stringArray(row.payload_json.stages), ...stages], result }),
      JSON.stringify(result),
    ],
  );
}

async function failSubmissionPg(
  db: SouthstarDb,
  submissionId: string,
  error: unknown,
  stages: string[],
): Promise<void> {
  await db.tx(async (tx) => {
    const row = await tx.one<{ payload_json: Record<string, unknown> }>(
      "select payload_json from southstar.runtime_resources where id = $1 for update",
      [submissionId],
    );
    const { result: _result, ...payload } = row.payload_json;
    await tx.query(
      "update southstar.runtime_resources set status = 'failed', payload_json = $2::jsonb, summary_json = $3::jsonb, updated_at = now() where id = $1",
      [
        submissionId,
        JSON.stringify({
          ...payload,
          stages: [...stringArray(payload.stages), ...stages, "submission.failed"],
          retryable: true,
          failure: error instanceof Error ? error.message : String(error),
          failedAt: new Date().toISOString(),
        }),
        JSON.stringify({ retryable: true, failure: error instanceof Error ? error.message : String(error) }),
      ],
    );
  });
}

function validateRequest(request: RunGoalRequest): void {
  requiredString(request.goalPrompt, "goalPrompt");
  requiredString(request.cwd, "cwd");
  if (request.projectRef !== undefined) requiredString(request.projectRef, "projectRef");
  requiredString(request.idempotencyKey, "idempotencyKey");
}

function requireRunGoalResult(value: unknown): RunGoalResult {
  const result = asRecord(value);
  const hasContractHash = typeof result.goalContractHash === "string" && result.goalContractHash.length > 0;
  const stagedRequirementReview = ["requirements_review", "validation_resolving", "library_review", "validation_ready"].includes(String(result.draftStatus));
  if ((!hasContractHash && !(stagedRequirementReview && typeof result.goalRequirementDraftHash === "string" && result.goalRequirementDraftHash.length > 0)) || !requiredString(result.draftId, "draftId")) {
    throw new Error("invalid completed goal submission result");
  }
  return result as RunGoalResult;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function storedGoalDesignPackage(value: unknown): GoalDesignPackageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pkg = value as GoalDesignPackageV1;
  return validateGoalDesignPackage(pkg).length === 0 ? pkg : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function postgresErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
