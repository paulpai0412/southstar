import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { acceptOrRejectArtifactRefPg, artifactRefIdentity } from "../artifacts/artifact-ref-store.ts";
import { recordArtifactRepairMarkerPg } from "../artifacts/lineage.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
import { recordRuntimeExceptionInTxPg, resolveTorkTerminalWithoutCallbackForCallbackPg } from "../exceptions/postgres-runtime-exceptions.ts";
import { evaluateRunCompletionGatePg } from "../evaluators/completion-gate.ts";
import {
  assertRequirementEvaluatorExecutionIdentityPg,
  prepareRequirementEvaluatorScreenshotProofPg,
  recordRequirementEvaluatorResultsPg,
} from "../evaluators/requirement-evaluator-results.ts";
import { writeCallbackMemoryPg } from "../memory/writeback-policy.ts";
import { appendHistoryEventPg, getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { triggerRunCompletedKnowledgeCardSynthesis } from "../evolution/cards.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { advanceGoalExecutionSetPg } from "../orchestration/goal-execution-set.ts";
import { maybeApplyDynamicRepairRevisionPg, type DynamicRepairRevisionResult } from "../runtime-revision/dynamic-repair-revision.ts";
import { assertNoRawCredentialPayloadPg } from "../tool-proxy/policy-enforcer.ts";
import { runtimeAttemptNumber } from "./attempt-identity.ts";
import { getExecutorBindingPg, updateExecutorBindingStatusPg } from "./postgres-bindings.ts";
import {
  canonicalHandExecutionId,
  settleHandExecutionPg,
} from "./attempt-settlement.ts";
import { finalizeTaskWorkspacePg } from "../workspace/task-workspace.ts";
import type { TaskRunCallbackResult } from "./tork-callback.ts";

export type PostgresTaskRunCallbackResult = TaskRunCallbackResult & {
  receivedAt?: string;
};

export type PostgresCallbackIngestionResult = {
  accepted: boolean;
  blocked?: boolean;
  workspaceConflict?: {
    resourceKey: string;
    worktreePath: string;
    errorMessage: string;
  };
  duplicate?: boolean;
  artifactResourceId?: string;
  artifactRefId?: string;
  ignoredRunStatus?: string;
  dynamicRepairRevision?: DynamicRepairRevisionResult;
};

export type PostgresCallbackIngestionOptions = {
  workflowComposer?: WorkflowComposer;
  maxDynamicRepairRounds?: number;
};

type PendingDynamicRepair = Parameters<typeof maybeApplyDynamicRepairRevisionPg>[1];

type PersistedCallbackResult = Omit<PostgresCallbackIngestionResult, "dynamicRepairRevision"> & {
  pendingDynamicRepair?: PendingDynamicRepair;
  dynamicRepairHistoryKey?: string;
  rootSessionId?: string;
  callbackPersisted?: boolean;
};

export async function ingestTaskRunResultPg(
  db: SouthstarDb,
  result: PostgresTaskRunCallbackResult,
  options: PostgresCallbackIngestionOptions = {},
): Promise<PostgresCallbackIngestionResult> {
  const attemptId = normalizedAttemptId(result);
  const handExecutionId = canonicalHandExecutionId(result.runId, result.taskId, attemptId);
  const receipt = callbackReceiptToken(result, handExecutionId);
  const preflight = await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_runs where id = $1 for update",
      [result.runId],
    );
    if (!run) throw new Error(`callback run not found: ${result.runId}`);

    try {
      await assertCallbackMetadataSafePg(tx, result);
    } catch (error) {
      return { kind: "error" as const, error };
    }

    const existingReceipt = await findCallbackReceiptPg(tx, result.runId, receipt.idempotencyKey);
    if (existingReceipt) {
      return {
        kind: "result" as const,
        result: {
          ...(await duplicateCallbackOutcome(tx, result, receipt.idempotencyKey)),
          duplicate: true,
          ...(run.status === "cancelled" ? { ignoredRunStatus: run.status } : {}),
        },
      };
    }

    if (run.status === "cancelled") {
      return { kind: "result" as const, result: await recordCancelledRunCallbackAuditPg(tx, result, receipt) };
    }

    try {
      await assertRequirementEvaluatorExecutionIdentityPg(tx, {
        runId: result.runId,
        taskId: result.taskId,
        rootSessionId: result.rootSessionId,
        attemptId: result.attemptId,
        handExecutionId,
      });
    } catch (error) {
      return { kind: "error" as const, error };
    }

    try {
      await assertCallbackPersistedSurfacesSafePg(tx, result, handExecutionId);
    } catch (error) {
      return { kind: "error" as const, error };
    }

    return { kind: "continue" as const };
  });

  if (preflight.kind === "result") return preflight.result;
  if (preflight.kind === "error") throw preflight.error;
  const screenshotProof = await prepareRequirementEvaluatorScreenshotProofPg(db, {
    runId: result.runId,
    artifact: result.artifact,
  });

  const ingested: PersistedCallbackResult = await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_runs where id = $1 for update",
      [result.runId],
    );
    if (!run) throw new Error(`callback run not found: ${result.runId}`);

    const existingReceipt = await findCallbackReceiptPg(tx, result.runId, receipt.idempotencyKey);
    if (existingReceipt) {
      return {
        ...(await duplicateCallbackOutcome(tx, result, receipt.idempotencyKey)),
        duplicate: true,
        ...(run.status === "cancelled" ? { ignoredRunStatus: run.status } : {}),
      };
    }
    if (run.status === "cancelled") return await recordCancelledRunCallbackAuditPg(tx, result, receipt);

    const task = await tx.maybeOne<{ status: string; root_session_id: string | null }>(
      "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [result.runId, result.taskId],
    );
    if (!task) throw new Error(`callback task not found: ${result.runId}/${result.taskId}`);

    await assertRequirementEvaluatorExecutionIdentityPg(tx, {
      runId: result.runId,
      taskId: result.taskId,
      rootSessionId: result.rootSessionId,
      attemptId: result.attemptId,
      handExecutionId,
    });

    await appendHistoryEventPg(tx, {
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      eventType: "executor.callback_received",
      actorType: "executor",
      idempotencyKey: receipt.idempotencyKey,
      payload: {
        attempts: result.attempts,
        attemptId: result.attemptId,
        artifactHash: receipt.artifactHash,
      },
    });

    const staleAttempt = await staleAttemptReasonPg(tx, result);
    if (staleAttempt) {
      await appendHistoryEventPg(tx, {
        runId: result.runId,
        taskId: result.taskId,
        sessionId: result.rootSessionId,
        eventType: "executor.callback_ignored_stale_attempt",
        actorType: "orchestrator",
        payload: staleAttempt,
      });
      await recordCallbackExceptionDecisionPg(tx, {
        result,
        attemptId,
        handExecutionId,
        receiptIdempotencyKey: receipt.idempotencyKey,
        kind: "stale_callback",
        providerEvidence: {
          ...staleAttempt,
          rootSessionId: result.rootSessionId,
          currentRootSessionId: task.root_session_id,
        },
      });
      return { accepted: false };
    }

    if (isTaskTerminalStatus(task.status)) {
      await appendHistoryEventPg(tx, {
        runId: result.runId,
        taskId: result.taskId,
        sessionId: result.rootSessionId,
        eventType: "executor.callback_ignored_terminal",
        actorType: "orchestrator",
        payload: { status: task.status },
      });
      await recordCallbackExceptionDecisionPg(tx, {
        result,
        attemptId,
        handExecutionId,
        receiptIdempotencyKey: receipt.idempotencyKey,
        kind: "late_callback",
        providerEvidence: { status: task.status },
      });
      return { accepted: false };
    }

    for (const event of result.events) {
      await appendHistoryEventPg(tx, {
        runId: result.runId,
        taskId: result.taskId,
        sessionId: event.sessionId ?? result.rootSessionId,
        eventType: event.eventType,
        actorType: event.actorType,
        payload: event.payload,
      });
    }

    const effectiveResult = semanticCallbackResult(result);
    const identity = artifactRefIdentity({
      runId: effectiveResult.runId,
      taskId: effectiveResult.taskId,
      attemptId,
      content: effectiveResult.artifact,
    });
    const requirementEvaluation = await recordRequirementEvaluatorResultsPg(tx, {
      runId: effectiveResult.runId,
      taskId: effectiveResult.taskId,
      artifactRefId: identity.artifactRefId,
      artifact: effectiveResult.artifact,
      callbackOk: effectiveResult.ok,
      rootSessionId: effectiveResult.rootSessionId,
      attemptId: effectiveResult.attemptId,
      handExecutionId,
      screenshotProof,
      now: effectiveResult.receivedAt,
    });
    const accepted = effectiveResult.ok && requirementEvaluation.ok;
    const evaluatedResult = accepted === effectiveResult.ok ? effectiveResult : { ...effectiveResult, ok: accepted };
    const semanticOutcome = effectiveResult.ok !== result.ok
      ? "verification_failed"
      : accepted !== result.ok
        ? "requirement_evidence_failed"
        : undefined;
    const artifactContractLineage = await artifactContractRefsForTaskPg(tx, effectiveResult.runId, effectiveResult.taskId);

    const artifactRef = await acceptOrRejectArtifactRefPg(tx, {
      runId: effectiveResult.runId,
      taskId: effectiveResult.taskId,
      sessionId: effectiveResult.rootSessionId,
      attemptId,
      handExecutionId,
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: artifactType(effectiveResult.artifact),
      status: accepted ? "accepted" : "rejected",
      content: effectiveResult.artifact,
      contractRefs: artifactContractLineage.contractRefs,
      contractVersionRefs: artifactContractLineage.contractVersionRefs,
      summary: `Callback artifact ${effectiveResult.taskId}`,
      failedArtifactRefs: failedArtifactRefIds(effectiveResult.artifact),
      evidenceRefs: requirementEvaluation.evidenceRefs,
      evaluatorResultRefs: requirementEvaluation.evaluatorResultRefs,
      sourceEventRefs: [receipt.idempotencyKey],
    });

    await appendHistoryEventPg(tx, {
      runId: effectiveResult.runId,
      taskId: effectiveResult.taskId,
      sessionId: effectiveResult.rootSessionId,
      eventType: "artifact.created",
      actorType: "orchestrator",
      payload: {
        artifactResourceId: artifactRef.resourceId,
        artifactRefId: artifactRef.artifactRefId,
        attempts: effectiveResult.attempts,
        accepted,
        ...(semanticOutcome ? { semanticOutcome } : {}),
      },
    });

    await writeCallbackMemoryPg(tx, {
      runId: effectiveResult.runId,
      taskId: effectiveResult.taskId,
      sessionId: effectiveResult.rootSessionId,
      ok: accepted,
      artifact: effectiveResult.artifact,
      artifactRefId: artifactRef.artifactRefId,
      artifactResourceId: artifactRef.resourceId,
    });
    await recordCallbackArtifactRepairMarkersPg(tx, {
      result: evaluatedResult,
      rejectedArtifactRefId: artifactRef.artifactRefId,
      rejectedArtifactResourceId: artifactRef.resourceId,
    });

    if (effectiveResult.attemptId) {
      const bindingId = `executor-${effectiveResult.runId}-${effectiveResult.taskId}-${effectiveResult.attemptId}`;
      const binding = await getExecutorBindingPg(tx, bindingId);
      if (binding) {
        await updateExecutorBindingStatusPg(tx, {
          bindingId,
          status: accepted ? "completed" : "failed",
          eventType: "executor.callback_completed",
          payloadPatch: {
            callbackReceivedAt: effectiveResult.receivedAt ?? new Date().toISOString(),
            terminalObservedAt: effectiveResult.receivedAt ?? new Date().toISOString(),
          },
          eventPayload: {
            accepted,
            artifactResourceId: artifactRef.resourceId,
            artifactRefId: artifactRef.artifactRefId,
            ...(semanticOutcome ? { semanticOutcome } : {}),
          },
        });
      } else {
        await appendHistoryEventPg(tx, {
          runId: effectiveResult.runId,
          taskId: effectiveResult.taskId,
          sessionId: effectiveResult.rootSessionId,
          eventType: "executor.callback_completed",
          actorType: "orchestrator",
          payload: {
            accepted,
            artifactResourceId: artifactRef.resourceId,
            artifactRefId: artifactRef.artifactRefId,
            legacyBindingMissing: true,
            ...(semanticOutcome ? { semanticOutcome } : {}),
          },
        });
      }
    } else {
      await appendHistoryEventPg(tx, {
        runId: effectiveResult.runId,
        taskId: effectiveResult.taskId,
        sessionId: effectiveResult.rootSessionId,
        eventType: "executor.callback_completed",
        actorType: "orchestrator",
        payload: {
          accepted,
          artifactResourceId: artifactRef.resourceId,
          artifactRefId: artifactRef.artifactRefId,
          ...(semanticOutcome ? { semanticOutcome } : {}),
        },
      });
    }

    const existingHandExecution = await getResourceByKeyPg(tx, "hand_execution", handExecutionId);
    const existingHandPayload = asRecord(existingHandExecution?.payload);
    const handExecutionSettled = await settleHandExecutionPg(tx, {
      resourceKey: handExecutionId,
      runId: effectiveResult.runId,
      taskId: effectiveResult.taskId,
      sessionId: effectiveResult.rootSessionId,
      status: evaluatedResult.ok ? "completed" : "failed",
      terminalAt: effectiveResult.receivedAt ?? new Date().toISOString(),
      payloadPatch: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId,
        providerId: "tork",
        runId: effectiveResult.runId,
        taskId: effectiveResult.taskId,
        sessionId: effectiveResult.rootSessionId,
        attemptId,
      },
      summaryPatch: {
        providerId: "tork",
        attemptId,
        accepted: evaluatedResult.ok,
        artifactRefId: artifactRef.artifactRefId,
        artifactResourceId: artifactRef.resourceId,
      },
      metricsPatch: effectiveResult.metrics,
    });
    if (handExecutionSettled) {
      const terminalAt = effectiveResult.receivedAt ?? new Date().toISOString();
      const bindingStatus = evaluatedResult.ok ? "succeeded" : "failed";
      await patchManagedBindingTerminalPg(tx, {
        resourceType: "brain_binding",
        resourceKey: nonEmptyString(existingHandPayload.brainBindingId),
        status: bindingStatus,
        terminalAt,
        runId: effectiveResult.runId,
        taskId: effectiveResult.taskId,
      });
      await patchManagedBindingTerminalPg(tx, {
        resourceType: "hand_binding",
        resourceKey: nonEmptyString(existingHandPayload.handBindingId),
        status: bindingStatus,
        terminalAt,
        runId: effectiveResult.runId,
        taskId: effectiveResult.taskId,
      });
    }

    const workspaceFinalization = await finalizeTaskWorkspacePg(tx, {
      runId: effectiveResult.runId,
      taskId: effectiveResult.taskId,
      accepted,
    });

    if (workspaceFinalization.status === "merge_conflict") {
      const exception = await recordRuntimeExceptionInTxPg(tx, {
        runId: effectiveResult.runId,
        taskId: effectiveResult.taskId,
        sessionId: effectiveResult.rootSessionId,
        attemptId,
        handExecutionId,
        source: "callback",
        kind: "workspace_merge_conflict",
        severity: "blocking",
        observedAt: effectiveResult.receivedAt ?? new Date().toISOString(),
        evidenceRefs: [workspaceFinalization.resourceKey],
        providerEvidence: {
          repoRoot: workspaceFinalization.repoRoot,
          worktreePath: workspaceFinalization.worktreePath,
          errorMessage: workspaceFinalization.errorMessage,
          worktreePreserved: true,
        },
      });
      const exceptionController = createRuntimeExceptionController({ db: tx });
      const classification = await exceptionController.classify(exception);
      await exceptionController.decide(classification);
      await appendHistoryEventPg(tx, {
        runId: effectiveResult.runId,
        taskId: effectiveResult.taskId,
        sessionId: effectiveResult.rootSessionId,
        eventType: "workspace.merge_conflict_blocked",
        actorType: "orchestrator",
        idempotencyKey: `${workspaceFinalization.resourceKey}:merge-conflict-blocked`,
        payload: {
          resourceKey: workspaceFinalization.resourceKey,
          worktreePath: workspaceFinalization.worktreePath,
          exceptionId: exception.exceptionId,
          recoveryPath: classification.recoveryPath,
          operatorApprovalRequired: classification.operatorApprovalRequired,
        },
      });
      await tx.query(
        "update southstar.workflow_tasks set status = 'blocked', updated_at = now(), completed_at = coalesce(completed_at, now()) where run_id = $1 and id = $2",
        [effectiveResult.runId, effectiveResult.taskId],
      );
    }

    if (workspaceFinalization.status !== "merge_conflict") {
      await tx.query(
        "update southstar.workflow_tasks set status = $1, updated_at = now(), completed_at = coalesce(completed_at, now()) where run_id = $2 and id = $3",
        [accepted ? "completed" : "failed", effectiveResult.runId, effectiveResult.taskId],
      );
    }

    const pendingDynamicRepair: PendingDynamicRepair | undefined = accepted || workspaceFinalization.status === "merge_conflict" || !options.workflowComposer
      ? undefined
      : {
        runId: effectiveResult.runId,
        failedTaskId: effectiveResult.taskId,
        failedArtifactRefId: artifactRef.artifactRefId,
        failedArtifact: {
          ...asRecord(effectiveResult.artifact),
          requirementEvaluation: {
            findings: requirementEvaluation.findings,
            evidenceRefs: requirementEvaluation.evidenceRefs,
            evaluatorResultRefs: requirementEvaluation.evaluatorResultRefs,
          },
        },
        failedRequirementIds: requirementEvaluation.failedBlockingRequirementIds,
        workflowComposer: options.workflowComposer,
        maxDynamicRepairRounds: options.maxDynamicRepairRounds,
      }

    return {
      accepted,
      ...(workspaceFinalization.status === "merge_conflict"
        ? {
            blocked: true,
            workspaceConflict: {
              resourceKey: workspaceFinalization.resourceKey,
              worktreePath: workspaceFinalization.worktreePath,
              errorMessage: workspaceFinalization.errorMessage,
            },
          }
        : {}),
      callbackPersisted: true,
      artifactResourceId: artifactRef.resourceId,
      artifactRefId: artifactRef.artifactRefId,
      ...(pendingDynamicRepair ? { pendingDynamicRepair } : {}),
      ...(!accepted ? { dynamicRepairHistoryKey: `${receipt.idempotencyKey}:dynamic-repair-evaluated` } : {}),
      rootSessionId: effectiveResult.rootSessionId,
    };
  });
  const dynamicRepairRevision = ingested.pendingDynamicRepair
    ? await safeApplyDynamicRepairRevisionPg(db, ingested.pendingDynamicRepair)
    : undefined;
  if (ingested.callbackPersisted && !ingested.duplicate) {
    await resolveTorkTerminalWithoutCallbackForCallbackPg(db, {
      runId: result.runId,
      taskId: result.taskId,
      attemptId,
      handExecutionId,
      resolvedAt: result.receivedAt ?? new Date().toISOString(),
      reason: "callback_received_for_observed_terminal_execution",
    });
  }
  await finalizeCallbackLifecyclePg(db, {
    runId: result.runId,
    taskId: result.taskId,
    rootSessionId: ingested.rootSessionId,
    accepted: ingested.accepted,
    artifactRefId: ingested.artifactRefId,
    dynamicRepairHistoryKey: ingested.dynamicRepairHistoryKey,
    dynamicRepairRevision,
  });
  await advanceExecutionSetForRunIfNeededPg(db, result.runId);
  return {
    accepted: ingested.accepted,
    ...(ingested.blocked ? { blocked: true } : {}),
    ...(ingested.workspaceConflict ? { workspaceConflict: ingested.workspaceConflict } : {}),
    ...(ingested.duplicate ? { duplicate: true } : {}),
    ...(ingested.artifactResourceId ? { artifactResourceId: ingested.artifactResourceId } : {}),
    ...(ingested.artifactRefId ? { artifactRefId: ingested.artifactRefId } : {}),
    ...(ingested.ignoredRunStatus ? { ignoredRunStatus: ingested.ignoredRunStatus } : {}),
    ...(dynamicRepairRevision ? { dynamicRepairRevision } : {}),
  };
}

async function finalizeCallbackLifecyclePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    rootSessionId?: string;
    accepted: boolean;
    artifactRefId?: string;
    dynamicRepairHistoryKey?: string;
    dynamicRepairRevision?: DynamicRepairRevisionResult;
  },
): Promise<void> {
  await db.tx(async (tx) => {
    if (!input.accepted && input.dynamicRepairHistoryKey) {
      await appendHistoryEventPg(tx, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.rootSessionId,
        eventType: "workflow.dynamic_repair_revision_evaluated",
        actorType: "orchestrator",
        idempotencyKey: input.dynamicRepairHistoryKey,
        payload: {
          ...(input.dynamicRepairRevision ?? { status: "skipped", reason: "workflow-composer-unavailable" }),
          ...(input.artifactRefId ? { artifactRefId: input.artifactRefId } : {}),
        },
      });
    }
    const allTasks = await tx.query<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1",
      [input.runId],
    );
    if (
      input.dynamicRepairRevision?.status !== "waiting_operator_approval"
      && allTasks.rows.length > 0
      && allTasks.rows.every((row) => ["completed", "failed", "cancelled", "lost", "blocked"].includes(row.status))
    ) {
      const gateResult = await evaluateRunCompletionGatePg(tx, { runId: input.runId });
      if (gateResult.executionStatus === "completed") {
        await triggerRunCompletedKnowledgeCardSynthesis(tx, {
          runId: input.runId,
          actor: "southstar-evolution",
          reason: "workflow run completed",
        });
      }
    }
  });
}

async function advanceExecutionSetForRunIfNeededPg(db: SouthstarDb, runId: string): Promise<void> {
  const row = await db.maybeOne<{ runtime_context_json: Record<string, unknown> }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  const executionSetId = typeof row?.runtime_context_json.goalExecutionSetId === "string"
    ? row.runtime_context_json.goalExecutionSetId
    : undefined;
  if (executionSetId) await advanceGoalExecutionSetPg(db, { executionSetId });
}

async function findCallbackReceiptPg(
  db: SouthstarDb,
  runId: string,
  idempotencyKey: string,
): Promise<{ id: string } | null> {
  return await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [runId, idempotencyKey],
  );
}

async function safeApplyDynamicRepairRevisionPg(
  db: SouthstarDb,
  input: Parameters<typeof maybeApplyDynamicRepairRevisionPg>[1],
): Promise<DynamicRepairRevisionResult> {
  try {
    return await maybeApplyDynamicRepairRevisionPg(db, input);
  } catch (error) {
    return {
      status: "skipped",
      reason: `dynamic-repair-revision-error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function recordCancelledRunCallbackAuditPg(
  db: SouthstarDb,
  result: PostgresTaskRunCallbackResult,
  receipt: { idempotencyKey: string; artifactHash: string },
): Promise<PostgresCallbackIngestionResult> {
  await appendHistoryEventPg(db, {
    runId: result.runId,
    taskId: result.taskId,
    sessionId: result.rootSessionId,
    eventType: "executor.callback_received",
    actorType: "executor",
    idempotencyKey: receipt.idempotencyKey,
    payload: {
      attempts: result.attempts,
      attemptId: result.attemptId,
      artifactHash: receipt.artifactHash,
    },
  });
  await appendHistoryEventPg(db, {
    runId: result.runId,
    taskId: result.taskId,
    sessionId: result.rootSessionId,
    eventType: "executor.callback_ignored_cancelled_run",
    actorType: "orchestrator",
    idempotencyKey: `${receipt.idempotencyKey}:ignored-cancelled-run`,
    payload: { status: "cancelled", attemptId: result.attemptId, attempts: result.attempts },
  });
  return { accepted: false, ignoredRunStatus: "cancelled" };
}

async function recordCallbackArtifactRepairMarkersPg(
  db: SouthstarDb,
  input: { result: PostgresTaskRunCallbackResult; rejectedArtifactRefId: string; rejectedArtifactResourceId: string },
): Promise<void> {
  if (input.result.ok) return;
  const refs = failedArtifactRepairRefs(input.result.artifact);
  if (refs.length === 0) return;

  for (const ref of refs) {
    const producer = await db.maybeOne<{ task_id: string | null; session_id: string | null }>(
      `select task_id, session_id
         from southstar.runtime_resources
        where resource_type = $1
          and resource_key = $2
          and run_id = $3
        limit 1`,
      [ARTIFACT_REF_RESOURCE_TYPE, ref.artifactRefId, input.result.runId],
    );
    if (!producer?.task_id) continue;

    await recordArtifactRepairMarkerPg(db, {
      runId: input.result.runId,
      taskId: producer.task_id,
      sessionId: producer.session_id ?? input.result.rootSessionId,
      artifactRefId: ref.artifactRefId,
      reason: ref.reason,
      sourceRefs: [input.rejectedArtifactRefId, input.rejectedArtifactResourceId],
      payload: {
        consumerTaskId: input.result.taskId,
        rejectedArtifactRefId: input.rejectedArtifactRefId,
        rejectedArtifactResourceId: input.rejectedArtifactResourceId,
      },
    });
  }
}

function failedArtifactRepairRefs(artifact: unknown): Array<{ artifactRefId: string; reason: string }> {
  const payload = asRecord(artifact);
  const summary = nonEmptyString(payload.summary) ?? "consumer validation rejected producer artifact";
  const refs = new Map<string, string>();
  for (const artifactRefId of stringArray(payload.failedArtifactRefs)) {
    refs.set(artifactRefId, summary);
  }
  for (const finding of arrayOfRecords(payload.findings)) {
    const artifactRefId = nonEmptyString(finding.artifactRefId)
      ?? nonEmptyString(finding.failedArtifactRef)
      ?? nonEmptyString(finding.sourceArtifactRef)
      ?? nonEmptyString(finding.artifactRef);
    if (!artifactRefId) continue;
    refs.set(artifactRefId, nonEmptyString(finding.reason) ?? nonEmptyString(finding.message) ?? summary);
  }
  return [...refs.entries()].map(([artifactRefId, reason]) => ({ artifactRefId, reason }));
}

function failedArtifactRefIds(artifact: unknown): string[] {
  return failedArtifactRepairRefs(artifact).map((ref) => ref.artifactRefId);
}

async function recordCallbackExceptionDecisionPg(
  db: SouthstarDb,
  input: {
    result: PostgresTaskRunCallbackResult;
    attemptId: string;
    handExecutionId: string;
    receiptIdempotencyKey: string;
    kind: "stale_callback" | "late_callback";
    providerEvidence: Record<string, unknown>;
  },
): Promise<void> {
  const controller = createRuntimeExceptionController({ db });
  const exception = await controller.observe({
    runId: input.result.runId,
    taskId: input.result.taskId,
    sessionId: input.result.rootSessionId,
    attemptId: input.attemptId,
    handExecutionId: input.handExecutionId,
    source: "callback",
    kind: input.kind,
    severity: "warning",
    observedAt: input.result.receivedAt ?? new Date().toISOString(),
    evidenceRefs: [input.receiptIdempotencyKey],
    providerEvidence: input.providerEvidence,
  });
  await controller.decide(await controller.classify(exception));
}

async function patchManagedBindingTerminalPg(
  db: SouthstarDb,
  input: {
    resourceType: "brain_binding" | "hand_binding";
    resourceKey?: string;
    status: "succeeded" | "failed";
    terminalAt: string;
    runId: string;
    taskId: string;
  },
): Promise<void> {
  if (!input.resourceKey) return;
  const existing = await getResourceByKeyPg(db, input.resourceType, input.resourceKey);
  if (!existing) return;
  if (["succeeded", "failed", "cancelled", "lost", "destroyed"].includes(existing.status)) return;
  await upsertRuntimeResourcePg(db, {
    id: existing.id,
    resourceType: input.resourceType,
    resourceKey: input.resourceKey,
    runId: existing.runId ?? input.runId,
    taskId: existing.taskId ?? input.taskId,
    sessionId: existing.sessionId,
    scope: existing.scope,
    status: input.status,
    title: existing.title,
    payload: {
      ...asRecord(existing.payload),
      status: input.status,
      terminalAt: input.terminalAt,
    },
    summary: {
      ...asRecord(existing.summary),
      terminalAt: input.terminalAt,
    },
    metrics: existing.metrics,
    expiresAt: existing.expiresAt,
  });
}

async function assertCallbackPersistedSurfacesSafePg(
  db: SouthstarDb,
  result: PostgresTaskRunCallbackResult,
  handExecutionId: string,
): Promise<void> {
  await assertNoRawCredentialPayloadPg(db, {
    runId: result.runId,
    taskId: result.taskId,
    sessionId: result.rootSessionId,
    handExecutionId,
    evidenceRef: `${handExecutionId}:artifact`,
    value: result.artifact,
  });
  for (const [index, event] of result.events.entries()) {
    await assertNoRawCredentialPayloadPg(db, {
      runId: result.runId,
      taskId: result.taskId,
      sessionId: event.sessionId ?? result.rootSessionId,
      handExecutionId,
      evidenceRef: `${handExecutionId}:events[${index}].payload`,
      value: event.payload,
    });
  }
  await assertNoRawCredentialPayloadPg(db, {
    runId: result.runId,
    taskId: result.taskId,
    sessionId: result.rootSessionId,
    handExecutionId,
    evidenceRef: `${handExecutionId}:metrics`,
    value: result.metrics,
  });
}

async function assertCallbackMetadataSafePg(
  db: SouthstarDb,
  result: PostgresTaskRunCallbackResult,
): Promise<void> {
  await assertNoRawCredentialPayloadPg(db, {
    runId: result.runId,
    taskId: result.taskId,
    evidenceRef: `callback:${result.runId}:${result.taskId}:metadata`,
    value: {
      rootSessionId: result.rootSessionId,
      attemptId: result.attemptId,
      events: result.events.map(({ eventType, actorType, sessionId }) => ({ eventType, actorType, sessionId })),
    },
  });
}

function callbackReceiptToken(result: PostgresTaskRunCallbackResult, handExecutionId: string): { idempotencyKey: string; artifactHash: string } {
  const artifactHash = createHash("sha256").update(stableStringify(result.artifact)).digest("hex");
  const semanticHash = createHash("sha256").update(stableStringify({
    runId: result.runId,
    taskId: result.taskId,
    rootSessionId: result.rootSessionId,
    attemptId: normalizedAttemptId(result),
    ok: result.ok,
    attempts: result.attempts,
    artifact: result.artifact,
    events: result.events,
    metrics: result.metrics,
  })).digest("hex");
  return {
    artifactHash,
    idempotencyKey: `${handExecutionId}:callback:${semanticHash}`,
  };
}

function normalizedAttemptId(result: PostgresTaskRunCallbackResult): string {
  if (!result.attemptId) throw new Error("executor callback requires attemptId");
  return result.attemptId;
}

async function artifactContractRefsForTaskPg(
  db: SouthstarDb,
  runId: string,
  taskId: string,
): Promise<{ contractRefs: string[]; contractVersionRefs: string[] }> {
  const run = await db.one<{ workflow_manifest_json: unknown }>(
    "select workflow_manifest_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  const manifest = asRecord(run.workflow_manifest_json);
  const tasks = manifest.tasks;
  const task = Array.isArray(tasks)
    ? tasks.map(asRecord).find((candidate) => candidate.id === taskId)
    : undefined;
  const contractRefs = [...new Set([
    ...stringArray(task?.requiredArtifactRefs),
    `task:${taskId}:completion`,
  ])].sort();
  const artifactContracts = Array.isArray(manifest.artifactContracts)
    ? manifest.artifactContracts.map(asRecord)
    : [];
  const contractVersionRefs = contractRefs.flatMap((contractRef) => {
    const normalized = normalizeArtifactContractRef(contractRef);
    const contract = artifactContracts.find((candidate) => (
      normalizeArtifactContractRef(nonEmptyString(candidate.id) ?? "") === normalized
    ));
    const versionRef = nonEmptyString(contract?.libraryVersionRef);
    return versionRef ? [versionRef] : [];
  }).sort();
  return { contractRefs, contractVersionRefs };
}

function normalizeArtifactContractRef(value: string): string {
  return value.replace(/^artifact[.:]/, "");
}

function artifactType(artifact: unknown): string {
  if (artifact && typeof artifact === "object" && typeof (artifact as { kind?: unknown }).kind === "string") {
    return (artifact as { kind: string }).kind;
  }
  if (verificationReportPayload(artifact)) return "verification_report";
  return "callback_artifact";
}

function semanticCallbackResult(result: PostgresTaskRunCallbackResult): PostgresTaskRunCallbackResult {
  if (!result.ok) return result;
  if (!verificationReportIndicatesFailure(result.artifact)) return result;
  return { ...result, ok: false };
}

function verificationReportIndicatesFailure(artifact: unknown): boolean {
  const report = verificationReportPayload(artifact);
  if (!report) return false;

  if (report.pass === false || report.safeToSave === false) return true;

  const verdict = nonEmptyString(report.verdict) ?? nonEmptyString(report.status) ?? nonEmptyString(report.outcome);
  if (verdict && ["failed", "fail", "rejected", "blocked", "not-verified", "not_run", "not-run"].includes(verdict.toLowerCase())) {
    return true;
  }

  return [...arrayOfRecords(report.testResults), ...arrayOfRecords(report.tests)].some((entry) => {
    const status = nonEmptyString(entry.status)?.toLowerCase();
    if (!status || !["failed", "fail", "blocked", "not-verified", "not_run", "not-run"].includes(status)) return false;
    const gating = nonEmptyString(entry.gating) ?? nonEmptyString(entry.severity);
    return !gating || ["blocking", "error", "fatal"].includes(gating.toLowerCase());
  });
}

function verificationReportPayload(artifact: unknown): Record<string, unknown> | undefined {
  const payload = asRecord(artifact);
  if (payload.kind === "verification_report") return payload;
  if (looksLikeVerificationReport(payload)) return payload;
  const direct = asRecord(payload.verification_report);
  if (Object.keys(direct).length > 0) return direct;
  const nestedArtifact = asRecord(payload.artifact);
  const nestedReport = asRecord(nestedArtifact.verification_report);
  return Object.keys(nestedReport).length > 0 ? nestedReport : undefined;
}

function looksLikeVerificationReport(payload: Record<string, unknown>): boolean {
  if (Object.keys(payload).length === 0) return false;
  if (typeof payload.pass === "boolean" || typeof payload.safeToSave === "boolean") return true;
  if (Array.isArray(payload.testResults) || Array.isArray(payload.blockingTests)) return true;
  const verdict = nonEmptyString(payload.verdict) ?? nonEmptyString(payload.outcome);
  return Boolean(verdict && ["passed", "pass", "failed", "fail", "rejected", "blocked", "not-verified"].includes(verdict.toLowerCase()));
}

async function duplicateCallbackOutcome(
  db: SouthstarDb,
  result: PostgresTaskRunCallbackResult,
  idempotencyKey: string,
): Promise<PostgresCallbackIngestionResult> {
  const artifact = await db.maybeOne<{ id: string; resource_key: string; status: string }>(
    `select id, resource_key, status
       from southstar.runtime_resources
      where run_id = $1
        and task_id = $2
        and resource_type = $3
        and payload_json -> 'sourceEventRefs' @> $4::jsonb
      order by created_at desc
      limit 1`,
    [result.runId, result.taskId, ARTIFACT_REF_RESOURCE_TYPE, JSON.stringify([idempotencyKey])],
  );
  if (!artifact) return { accepted: false };
  return {
    accepted: artifact.status === "accepted",
    artifactResourceId: artifact.id,
    artifactRefId: artifact.resource_key,
  };
}

async function staleAttemptReasonPg(
  db: SouthstarDb,
  result: PostgresTaskRunCallbackResult,
): Promise<{ callbackAttemptId: string; latestAttemptId: string } | undefined> {
  const latestAttemptId = await latestCallbackAttemptIdPg(db, result.runId, result.taskId);
  if (!latestAttemptId) return undefined;

  if (!result.attemptId) throw new Error("executor callback requires attemptId");

  if (runtimeAttemptNumber(result.attemptId) < runtimeAttemptNumber(latestAttemptId)) {
    return { callbackAttemptId: result.attemptId, latestAttemptId };
  }
  return undefined;
}

async function latestCallbackAttemptIdPg(db: SouthstarDb, runId: string, taskId: string): Promise<string | undefined> {
  const rows = await db.query<{ attempt_id: string | null }>(
    `select payload_json ->> 'attemptId' as attempt_id
       from southstar.runtime_resources
      where run_id = $1
        and task_id = $2
        and resource_type in ('hand_execution', 'executor_binding')`,
    [runId, taskId],
  );
  return rows.rows
    .map((row) => row.attempt_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => runtimeAttemptNumber(right) - runtimeAttemptNumber(left))[0];
}

function isTaskTerminalStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "lost", "blocked"].includes(status);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
