import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { recordRuntimeExceptionPg } from "../exceptions/postgres-runtime-exceptions.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { goalContractHash, storedGoalContract, type GoalContractV1 } from "../orchestration/goal-contract.ts";
import { advanceGoalExecutionSetPg } from "../orchestration/goal-execution-set.ts";
import { loadRunLibrarySnapshotPg, type RunLibrarySnapshotV1 } from "../orchestration/run-library-snapshot.ts";
import {
  continueDynamicRepairApprovalPg,
  rejectDynamicRepairApprovalPg,
} from "../runtime-revision/dynamic-repair-revision.ts";
import {
  appendHistoryEventOncePg,
  appendHistoryEventPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import { startRunSchedulingPg, type StartRunSchedulingResult } from "../server/run-execution-controller.ts";

export type GoalExecutionApprovalPayload = {
  actionType: "goalExecution";
  decisionMode: "auto" | "manual";
  policyReason: string;
  riskTags: string[];
  requestedSideEffects: string[];
  goalContractHash: string;
  manifestHash: string;
  librarySnapshotHash: string;
  sideEffectEnvelopeHash: string;
};

export async function createApprovalPg(db: SouthstarDb, input: {
  runId: string;
  actionType: string;
  riskTags: string[];
  title: string;
  payload: Record<string, unknown>;
  status?: "pending" | "approved";
}): Promise<{ id: string; status: "pending" | "approved" }> {
  const approvalId = `approval-${randomUUID()}`;
  const status = input.status ?? "pending";
  await upsertRuntimeResourcePg(db, {
    id: approvalId,
    resourceType: "approval",
    resourceKey: approvalId,
    runId: input.runId,
    scope: "approval",
    status,
    title: input.title,
    payload: {
      ...input.payload,
      actionType: input.actionType,
      riskTags: input.riskTags,
      ...(status === "approved" ? { decision: "approved", decisionReason: input.payload.policyReason, decidedBy: "policy" } : {}),
    },
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    eventType: "approval.requested",
    actorType: "orchestrator",
    payload: { approvalId, actionType: input.actionType, riskTags: input.riskTags, decisionMode: input.payload.decisionMode },
  });
  if (status === "approved") {
    await appendHistoryEventOncePg(db, {
      runId: input.runId,
      eventType: "approval.decided",
      actorType: "orchestrator",
      idempotencyKey: `${approvalId}:decided:auto`,
      payload: { approvalId, decision: "approved", reason: input.payload.policyReason, decidedBy: "policy" },
    });
  }
  return { id: approvalId, status };
}

export async function decideApprovalPg(db: SouthstarDb, input: {
  runId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  reason: string;
  startScheduling?: (db: SouthstarDb, input: { runId: string }) => Promise<StartRunSchedulingResult>;
}) {
  const decision = await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string; runtime_context_json: Record<string, unknown> }>(
      "select status, runtime_context_json from southstar.workflow_runs where id = $1 for update",
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);
    const row = await tx.maybeOne<{ status: string; payload_json: Record<string, unknown>; title: string | null; task_id: string | null }>(
      `select status, payload_json, title, task_id
         from southstar.runtime_resources
        where resource_type = 'approval' and resource_key = $1 and run_id = $2
        for update`,
      [input.approvalId, input.runId],
    );
    if (!row) throw new Error(`approval not found: ${input.approvalId}`);
    const priorDecision = optionalString(row.payload_json.decision);
    const priorReason = optionalString(row.payload_json.decisionReason);
    if (priorDecision && (priorDecision !== input.decision || priorReason !== input.reason)) {
      throw new Error(`approval already ${priorDecision}: ${input.approvalId}`);
    }
    const goalExecutionApproval = row.payload_json.actionType === "goalExecution";
    const dynamicRepairApproval = row.payload_json.schemaVersion === "southstar.dynamic_repair_authority_approval.v1"
      && row.payload_json.actionType === "dynamic_repair_authority_expansion";
    if (priorDecision) {
      const schedulingResult = asRecord(row.payload_json.schedulingResult);
      return {
        shouldSchedule: goalExecutionApproval
          && input.decision === "approved"
          && row.payload_json.schedulingState === "requested",
        executionSetId: optionalString(run.runtime_context_json.goalExecutionSetId),
        goalExecutionApproval,
        dynamicRepairApproval,
        schedulingResult,
      };
    }
    if (goalExecutionApproval && input.decision === "approved") {
      await assertGoalExecutionHashesCurrent(tx, input.runId, row.payload_json);
      if (run.status !== "awaiting_approval") {
        throw new Error(`goal execution approval cannot schedule run from status ${run.status}`);
      }
      await tx.query("update southstar.workflow_runs set status = 'created', updated_at = now() where id = $1", [input.runId]);
    }
    await upsertRuntimeResourcePg(tx, {
      id: input.approvalId,
      resourceType: "approval",
      resourceKey: input.approvalId,
      runId: input.runId,
      taskId: row.task_id ?? undefined,
      scope: "approval",
      status: input.decision,
      title: row.title ?? "Approval",
      payload: {
        ...row.payload_json,
        decision: input.decision,
        decisionReason: input.reason,
        decidedBy: "user",
        ...(goalExecutionApproval && input.decision === "approved" ? { schedulingState: "requested" } : {}),
      },
    });
    await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      taskId: row.task_id ?? undefined,
      eventType: "approval.decided",
      actorType: "user",
      idempotencyKey: `${input.approvalId}:decided:${input.decision}`,
      payload: { approvalId: input.approvalId, decision: input.decision, reason: input.reason },
    });
    return {
      shouldSchedule: goalExecutionApproval && input.decision === "approved",
      executionSetId: optionalString(run.runtime_context_json.goalExecutionSetId),
      goalExecutionApproval,
      dynamicRepairApproval,
      schedulingResult: {},
    };
  });

  if (decision.shouldSchedule && decision.executionSetId) {
    await advanceGoalExecutionSetPg(db, { executionSetId: decision.executionSetId });
    return { id: input.approvalId, status: input.decision, runStatus: "created" as const };
  }
  if (decision.shouldSchedule) {
    const scheduling = await completeApprovalSchedulingHandoffPg(db, input, input.startScheduling ?? startRunSchedulingPg);
    return { id: input.approvalId, status: input.decision, ...scheduling };
  }
  if (decision.goalExecutionApproval) {
    return { id: input.approvalId, status: input.decision, ...decision.schedulingResult };
  }
  const continuation = !decision.dynamicRepairApproval
    ? undefined
    : input.decision === "approved"
      ? await continueDynamicRepairApprovalPg(db, { runId: input.runId, approvalId: input.approvalId })
      : await rejectDynamicRepairApprovalPg(db, { runId: input.runId, approvalId: input.approvalId, reason: input.reason });
  return { id: input.approvalId, status: input.decision, ...(continuation ? { continuation } : {}) };
}

async function completeApprovalSchedulingHandoffPg(
  db: SouthstarDb,
  input: { runId: string; approvalId: string },
  startScheduling: (db: SouthstarDb, input: { runId: string }) => Promise<StartRunSchedulingResult>,
): Promise<{ runStatus: "created" | "scheduling"; schedulerExceptionId?: string }> {
  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_runs where id = $1 for update",
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);
    const row = await tx.one<{ payload_json: Record<string, unknown> }>(
      `select payload_json
         from southstar.runtime_resources
        where resource_type = 'approval' and resource_key = $1 and run_id = $2
        for update`,
      [input.approvalId, input.runId],
    );
    if (row.payload_json.schedulingState === "completed") {
      return requireSchedulingResult(row.payload_json.schedulingResult, input.approvalId);
    }
    if (row.payload_json.schedulingState !== "requested") {
      throw new Error(`approval scheduling was not requested: ${input.approvalId}`);
    }
    let schedulingError: unknown;
    try {
      await startScheduling(tx, { runId: input.runId });
    } catch (error) {
      schedulingError = error;
      await tx.query("update southstar.workflow_runs set status = 'created', updated_at = now() where id = $1", [input.runId]);
    }
    const exception = schedulingError === undefined
      ? undefined
      : await recordRuntimeExceptionPg(tx, {
        runId: input.runId,
        source: "scheduler",
        kind: "provider_unreachable",
        severity: "blocking",
        observedAt: new Date().toISOString(),
        evidenceRefs: [`run:${input.runId}:scheduling-wakeup`],
        providerEvidence: { error: schedulingError instanceof Error ? schedulingError.message : String(schedulingError) },
      });
    const schedulingResult = {
      runStatus: exception ? "created" as const : "scheduling" as const,
      ...(exception ? { schedulerExceptionId: exception.id } : {}),
    };
    await tx.query(
      "update southstar.runtime_resources set payload_json = $3::jsonb, updated_at = now() where resource_type = 'approval' and resource_key = $1 and run_id = $2",
      [input.approvalId, input.runId, JSON.stringify({ ...row.payload_json, schedulingState: "completed", schedulingResult })],
    );
    return schedulingResult;
  });
}

export function deriveGoalExecutionRisk(input: {
  goalContract: GoalContractV1;
  workflow: SouthstarWorkflowManifest;
  librarySnapshot: RunLibrarySnapshotV1;
}): { riskTags: string[]; sideEffectEnvelopeHash: string } {
  const riskTags = new Set(input.goalContract.riskTags);
  const authority = authorityEnvelope(input.workflow, input.librarySnapshot);
  const authorityText = authority.values.join(" ").toLowerCase();
  if (authority.vaultLeasePolicyRefs.length > 0 || /secret|vault|credential/.test(authorityText)) riskTags.add("secret-access");
  if (authority.writableMounts.length > 0 || /external[-_ ]?write|webhook|upload/.test(authorityText)) riskTags.add("external-write");
  if (/deploy/.test(authorityText)) riskTags.add("deployment");
  if (/\bdelete\b|\bdestroy\b/.test(authorityText)) riskTags.add("delete");
  if (/cost[-_ ]?high|high[-_ ]?cost/.test(authorityText)) riskTags.add("cost-high");
  if (/production|prod[-_ ]?change/.test(authorityText)) riskTags.add("production-change");
  for (const sideEffect of input.goalContract.requestedSideEffects) {
    const normalized = sideEffect.toLowerCase();
    if (/secret|vault|credential/.test(normalized)) riskTags.add("secret-access");
    if (/external[-_ ]?write|webhook|upload/.test(normalized)) riskTags.add("external-write");
    if (/deploy/.test(normalized)) riskTags.add("deployment");
    if (/delete|destroy/.test(normalized)) riskTags.add("delete");
    if (/cost[-_ ]?high|high[-_ ]?cost/.test(normalized)) riskTags.add("cost-high");
    if (/production|prod[-_ ]?change/.test(normalized)) riskTags.add("production-change");
  }
  const effectiveRiskTags = [...riskTags].sort();
  return {
    riskTags: effectiveRiskTags,
    sideEffectEnvelopeHash: contentHashForPayload({
      requestedSideEffects: [...input.goalContract.requestedSideEffects].sort(),
      riskTags: effectiveRiskTags,
      authority,
    }),
  };
}

async function assertGoalExecutionHashesCurrent(
  db: SouthstarDb,
  runId: string,
  approvalPayload: Record<string, unknown>,
): Promise<void> {
  const run = await db.one<{
    workflow_manifest_json: SouthstarWorkflowManifest;
    runtime_context_json: Record<string, unknown>;
  }>("select workflow_manifest_json, runtime_context_json from southstar.workflow_runs where id = $1", [runId]);
  const draftId = requiredString(run.runtime_context_json.draftId, "run draftId");
  const draft = await getResourceByKeyPg(db, "planner_draft", draftId);
  const contract = storedGoalContract(asRecord(draft?.payload).goalContract);
  if (!contract) throw new Error(`goal execution approval Goal Contract missing: ${draftId}`);
  const snapshot = await loadRunLibrarySnapshotPg(db, runId);
  const risk = deriveGoalExecutionRisk({ goalContract: contract, workflow: run.workflow_manifest_json, librarySnapshot: snapshot });
  const current = {
    goalContractHash: goalContractHash(contract),
    manifestHash: contentHashForPayload(run.workflow_manifest_json),
    librarySnapshotHash: snapshot.snapshotHash,
    sideEffectEnvelopeHash: risk.sideEffectEnvelopeHash,
  };
  for (const [name, value] of Object.entries(current)) {
    if (approvalPayload[name] !== value) throw new Error(`${labelForHash(name)} hash mismatch for approval ${runId}`);
  }
}

function authorityEnvelope(workflow: SouthstarWorkflowManifest, snapshot: RunLibrarySnapshotV1) {
  const taskRefs = workflow.tasks.flatMap((task) => [
    ...(task.toolGrantRefs ?? []),
    ...(task.mcpGrantRefs ?? []),
    ...(task.vaultLeasePolicyRefs ?? []),
  ]);
  const selectedObjects = snapshot.objects.map((object) => ({
    objectKey: object.objectKey,
    objectKind: object.objectKind,
    state: object.state,
    stateHash: object.stateHash,
  }));
  const mounts = workflow.tasks.flatMap((task) => task.execution.mounts);
  return {
    selectedRefs: [...new Set(taskRefs)].sort(),
    vaultLeasePolicyRefs: [...new Set(workflow.tasks.flatMap((task) => task.vaultLeasePolicyRefs ?? []))].sort(),
    writableMounts: mounts.filter((mount) => !mount.readonly),
    mcpGrants: workflow.mcpGrants,
    selectedObjects,
    values: [
      ...taskRefs,
      ...workflow.mcpGrants.flatMap((grant) => [grant.serverId, ...grant.allowedTools]),
      ...mounts.map((mount) => JSON.stringify(mount)),
      ...selectedObjects.flatMap((object) => [object.objectKey, JSON.stringify(object.state)]),
    ],
  };
}

function labelForHash(name: string): string {
  return name.replace(/Hash$/, "").replace(/[A-Z]/g, (character) => ` ${character.toLowerCase()}`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireSchedulingResult(
  value: unknown,
  approvalId: string,
): { runStatus: "created" | "scheduling"; schedulerExceptionId?: string } {
  const result = asRecord(value);
  if (result.runStatus !== "created" && result.runStatus !== "scheduling") {
    throw new Error(`approval scheduling result missing: ${approvalId}`);
  }
  return {
    runStatus: result.runStatus,
    ...(typeof result.schedulerExceptionId === "string" ? { schedulerExceptionId: result.schedulerExceptionId } : {}),
  };
}
