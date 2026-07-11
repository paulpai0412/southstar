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
import { storedGoalContract, type GoalContractInterpreter } from "./goal-contract.ts";
import { loadRunLibrarySnapshotPg } from "./run-library-snapshot.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { StartRunSchedulingResult } from "../server/run-execution-controller.ts";
import { startRunSchedulingPg } from "../server/run-execution-controller.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../ui-api/postgres-run-api.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";

export type RunGoalRequest = {
  goalPrompt: string;
  cwd: string;
  idempotencyKey: string;
};

export type RunGoalResult = {
  goalContractHash: string;
  draftId: string;
  draftStatus: "needs_input" | "invalid" | "validated";
  runId?: string;
  runStatus?: "created" | "awaiting_approval" | "scheduling";
  approvalId?: string;
  blockers: string[];
  schedulerExceptionId?: string;
};

export type SubmitGoalContext = {
  db: SouthstarDb;
  goalInterpreter: GoalContractInterpreter;
  composer?: WorkflowComposer;
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
      draftStatus: draft.status === "needs_input" ? "needs_input" : "invalid",
      blockers: draft.blockers,
    };
    const finalStages = draft.status === "needs_input" ? ["draft.needs_input", "done"] : ["done"];
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
      const run = await createPostgresRunFromDraft(tx, { draftId: draft.draftId });
      const runRow = await tx.one<{
        workflow_manifest_json: SouthstarWorkflowManifest;
        runtime_context_json: Record<string, unknown>;
      }>("select workflow_manifest_json, runtime_context_json from southstar.workflow_runs where id = $1 for update", [run.runId]);
      const storedDraftResource = await getResourceByKeyPg(tx, "planner_draft", draft.draftId);
      const goalContract = storedGoalContract(asRecord(storedDraftResource?.payload).goalContract);
      if (!goalContract) throw new Error(`planner draft Goal Contract missing: ${draft.draftId}`);
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
        goalContractHash: draft.goalContractHash,
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
        goalContractHash: draft.goalContractHash,
        draftId: draft.draftId,
        draftStatus: "validated",
        runId: run.runId,
        runStatus: policy.status === "approved" ? "created" : "awaiting_approval",
        approvalId: approval.id,
        blockers: draft.blockers,
      };
      const stages = [
        ...observedStages,
        "coverage.validated",
        "library_snapshot.persisted",
        "approval.persisted",
        ...(policy.status === "pending" ? ["run.awaiting_approval", "done"] : []),
      ];
      if (policy.status === "approved") await persistStagesPg(tx, claim.submissionId, stages);
      else await completeSubmissionPg(tx, claim.submissionId, result, stages);
      return { result, stages, autoSchedule: policy.status === "approved" };
    });
  } catch (error) {
    await failSubmissionPg(context.db, claim.submissionId, error, []);
    throw error;
  }
  transaction.stages.forEach((stage) => context.onStage?.(stage));
  if (!transaction.autoSchedule || !transaction.result.runId) return transaction.result;

  let schedulingError: unknown;
  try {
    await (context.startScheduling ?? startRunSchedulingPg)(context.db, { runId: transaction.result.runId });
  } catch (error) {
    schedulingError = error;
  }
  const finalized = await context.db.tx(async (tx) => {
    const exception = schedulingError === undefined
      ? undefined
      : await recordRuntimeExceptionPg(tx, {
        runId: transaction.result.runId!,
        source: "scheduler",
        kind: "provider_unreachable",
        severity: "blocking",
        observedAt: new Date().toISOString(),
        evidenceRefs: [`run:${transaction.result.runId}:scheduling-wakeup`],
        providerEvidence: { error: schedulingError instanceof Error ? schedulingError.message : String(schedulingError) },
      });
    const result: RunGoalResult = {
      ...transaction.result,
      runStatus: exception ? "created" : "scheduling",
      ...(exception ? { schedulerExceptionId: exception.id } : {}),
    };
    const finalStages = exception ? ["done"] : ["run.scheduling_started", "done"];
    await completeSubmissionPg(tx, claim.submissionId, result, finalStages);
    return { result, finalStages };
  });
  const finalStages = finalized.finalStages;
  finalStages.forEach((stage) => context.onStage?.(stage));
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
    const existing = await tx.one<{ id: string; status: string; payload_json: Record<string, unknown> }>(
      "select id, status, payload_json from southstar.runtime_resources where resource_type = 'goal_submission' and resource_key = $1 for update",
      [request.idempotencyKey],
    );
    if (existing.payload_json.requestHash !== requestHash) {
      throw new GoalSubmissionConflictError(`idempotency key already belongs to a different goal submission: ${request.idempotencyKey}`);
    }
    const stages = stringArray(existing.payload_json.stages);
    if (existing.status === "completed") {
      return { submissionId: existing.id, result: requireRunGoalResult(existing.payload_json.result), stages };
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
  requiredString(request.idempotencyKey, "idempotencyKey");
}

function requireRunGoalResult(value: unknown): RunGoalResult {
  const result = asRecord(value);
  if (!requiredString(result.goalContractHash, "goalContractHash") || !requiredString(result.draftId, "draftId")) {
    throw new Error("invalid completed goal submission result");
  }
  return result as RunGoalResult;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
