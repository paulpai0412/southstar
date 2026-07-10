import { randomUUID } from "node:crypto";
import {
  createApprovalPg,
  deriveGoalExecutionRisk,
  scheduleRunOrRecordExceptionPg,
  type GoalExecutionApprovalPayload,
} from "../approvals/postgres-approval-service.ts";
import { evaluateApprovalPolicy } from "../approvals/policy.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import type { WorkflowComposer } from "./composer.ts";
import { storedGoalContract, type GoalContractInterpreter } from "./goal-contract.ts";
import { loadRunLibrarySnapshotPg } from "./run-library-snapshot.ts";
import { getResourceByKeyPg } from "../stores/postgres-runtime-store.ts";
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
  runStatus?: "awaiting_approval" | "scheduling";
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

export async function submitGoalPg(context: SubmitGoalContext, request: RunGoalRequest): Promise<RunGoalResult> {
  validateRequest(request);
  const requestHash = contentHashForPayload(request);
  const claim = await claimSubmissionPg(context.db, request, requestHash);
  if (claim.result) {
    for (const stage of claim.stages) context.onStage?.(stage);
    return claim.result;
  }

  const observedStages: string[] = [];
  const draft = await createPostgresPlannerDraft(context.db, {
    goalPrompt: request.goalPrompt,
    cwd: request.cwd,
    goalInterpreter: context.goalInterpreter,
    composer: context.composer,
    onProgress(event) {
      if (event.stage === "goal_contract.interpreted" || event.stage === "draft.persisted") {
        observedStages.push(event.stage);
      }
    },
  });
  await persistStagesPg(context.db, claim.submissionId, observedStages);
  observedStages.forEach((stage) => context.onStage?.(stage));

  if (draft.status !== "validated") {
    const result: RunGoalResult = {
      goalContractHash: draft.goalContractHash,
      draftId: draft.draftId,
      draftStatus: draft.status === "needs_input" ? "needs_input" : "invalid",
      blockers: draft.blockers,
    };
    const finalStages = draft.status === "needs_input" ? ["draft.needs_input", "done"] : ["done"];
    await completeSubmissionPg(context.db, claim.submissionId, result, finalStages);
    finalStages.forEach((stage) => context.onStage?.(stage));
    return result;
  }

  const transaction = await context.db.tx(async (tx) => {
    const run = await createPostgresRunFromDraft(tx, { draftId: draft.draftId });
    const runRow = await tx.one<{
      workflow_manifest_json: SouthstarWorkflowManifest;
      runtime_context_json: Record<string, unknown>;
    }>("select workflow_manifest_json, runtime_context_json from southstar.workflow_runs where id = $1 for update", [run.runId]);
    const draftResource = await getResourceByKeyPg(tx, "planner_draft", draft.draftId);
    const goalContract = storedGoalContract(asRecord(draftResource?.payload).goalContract);
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
      runStatus: policy.status === "approved" ? "scheduling" : "awaiting_approval",
      approvalId: approval.id,
      blockers: draft.blockers,
    };
    const stages = [
      "coverage.validated",
      "library_snapshot.persisted",
      "approval.persisted",
      ...(policy.status === "pending" ? ["run.awaiting_approval", "done"] : []),
    ];
    await completeSubmissionPg(tx, claim.submissionId, result, stages);
    return { result, stages, autoSchedule: policy.status === "approved" };
  });
  transaction.stages.forEach((stage) => context.onStage?.(stage));
  if (!transaction.autoSchedule || !transaction.result.runId) return transaction.result;

  const scheduling = await scheduleRunOrRecordExceptionPg(
    context.db,
    transaction.result.runId,
    context.startScheduling ?? startRunSchedulingPg,
  );
  const finalStages = scheduling.schedulerExceptionId ? ["done"] : ["run.scheduling_started", "done"];
  await persistStagesPg(context.db, claim.submissionId, finalStages);
  finalStages.forEach((stage) => context.onStage?.(stage));
  if (!scheduling.schedulerExceptionId) return transaction.result;
  const result = { ...transaction.result, schedulerExceptionId: scheduling.schedulerExceptionId };
  await replaceCompletedResultPg(context.db, claim.submissionId, result);
  return result;
}

async function claimSubmissionPg(
  db: SouthstarDb,
  request: RunGoalRequest,
  requestHash: string,
): Promise<{ submissionId: string; result?: RunGoalResult; stages: string[] }> {
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

async function replaceCompletedResultPg(db: SouthstarDb, submissionId: string, result: RunGoalResult): Promise<void> {
  await db.query(
    "update southstar.runtime_resources set payload_json = jsonb_set(payload_json, '{result}', $2::jsonb), summary_json = $2::jsonb, updated_at = now() where id = $1 and status = 'completed'",
    [submissionId, JSON.stringify(result)],
  );
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
