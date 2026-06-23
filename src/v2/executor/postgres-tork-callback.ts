import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { acceptOrRejectArtifactRefPg } from "../artifacts/artifact-ref-store.ts";
import { recordArtifactRepairMarkerPg } from "../artifacts/lineage.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
import { evaluateRunCompletionGatePg } from "../evaluators/completion-gate.ts";
import { writeCallbackMemoryPg } from "../memory/writeback-policy.ts";
import { appendHistoryEventPg, getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { triggerRunCompletedKnowledgeCardSynthesis } from "../evolution/cards.ts";
import { assertNoRawCredentialPayloadPg } from "../tool-proxy/policy-enforcer.ts";
import { getExecutorBindingPg, updateExecutorBindingStatusPg } from "./postgres-bindings.ts";
import type { TaskRunCallbackResult } from "./tork-callback.ts";

export type PostgresTaskRunCallbackResult = TaskRunCallbackResult & {
  receivedAt?: string;
};

export type PostgresCallbackIngestionResult = {
  accepted: boolean;
  duplicate?: boolean;
  artifactResourceId?: string;
  artifactRefId?: string;
  ignoredRunStatus?: string;
};

export async function ingestTaskRunResultPg(db: SouthstarDb, result: PostgresTaskRunCallbackResult): Promise<PostgresCallbackIngestionResult> {
  const attemptId = normalizedAttemptId(result);
  const handExecutionId = canonicalHandExecutionId(result.runId, result.taskId, attemptId);
  const receipt = callbackReceiptToken(result, handExecutionId);
  const preflight = await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_runs where id = $1 for update",
      [result.runId],
    );
    if (!run) throw new Error(`callback run not found: ${result.runId}`);

    const existingReceipt = await tx.maybeOne<{ id: string }>(
      "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
      [result.runId, receipt.idempotencyKey],
    );
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
      await assertCallbackPersistedSurfacesSafePg(tx, result, handExecutionId);
    } catch (error) {
      return { kind: "error" as const, error };
    }

    return { kind: "continue" as const };
  });

  if (preflight.kind === "result") return preflight.result;
  if (preflight.kind === "error") throw preflight.error;

  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_runs where id = $1 for update",
      [result.runId],
    );
    if (!run) throw new Error(`callback run not found: ${result.runId}`);

    const existingReceipt = await tx.maybeOne<{ id: string }>(
      "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
      [result.runId, receipt.idempotencyKey],
    );
    if (existingReceipt) return { ...(await duplicateCallbackOutcome(tx, result, receipt.idempotencyKey)), duplicate: true };
    if (run.status === "cancelled") return await recordCancelledRunCallbackAuditPg(tx, result, receipt);

    const task = await tx.maybeOne<{ status: string; root_session_id: string | null }>(
      "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [result.runId, result.taskId],
    );
    if (!task) throw new Error(`callback task not found: ${result.runId}/${result.taskId}`);

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

    const staleAttempt = await staleAttemptReasonPg(tx, result, task.root_session_id ?? undefined);
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

    const artifactRef = await acceptOrRejectArtifactRefPg(tx, {
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      attemptId,
      handExecutionId,
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: artifactType(result.artifact),
      status: result.ok ? "accepted" : "rejected",
      content: result.artifact,
      contractRefs: [`task:${result.taskId}:completion`],
      summary: `Callback artifact ${result.taskId}`,
      failedArtifactRefs: failedArtifactRefIds(result.artifact),
      evidenceRefs: [],
      evaluatorResultRefs: [],
      sourceEventRefs: [receipt.idempotencyKey],
    });

    await appendHistoryEventPg(tx, {
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      eventType: "artifact.created",
      actorType: "orchestrator",
      payload: {
        artifactResourceId: artifactRef.resourceId,
        artifactRefId: artifactRef.artifactRefId,
        attempts: result.attempts,
        accepted: result.ok,
      },
    });

    await writeCallbackMemoryPg(tx, {
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      ok: result.ok,
      artifact: result.artifact,
      artifactRefId: artifactRef.artifactRefId,
      artifactResourceId: artifactRef.resourceId,
    });
    await recordCallbackArtifactRepairMarkersPg(tx, {
      result,
      rejectedArtifactRefId: artifactRef.artifactRefId,
      rejectedArtifactResourceId: artifactRef.resourceId,
    });

    if (result.attemptId) {
      const bindingId = `executor-${result.runId}-${result.taskId}-${result.attemptId}`;
      const binding = await getExecutorBindingPg(tx, bindingId);
      if (binding) {
        await updateExecutorBindingStatusPg(tx, {
          bindingId,
          status: result.ok ? "completed" : "failed",
          eventType: "executor.callback_completed",
          payloadPatch: {
            callbackReceivedAt: result.receivedAt ?? new Date().toISOString(),
            terminalObservedAt: result.receivedAt ?? new Date().toISOString(),
          },
          eventPayload: {
            accepted: result.ok,
            artifactResourceId: artifactRef.resourceId,
            artifactRefId: artifactRef.artifactRefId,
          },
        });
      } else {
        await appendHistoryEventPg(tx, {
          runId: result.runId,
          taskId: result.taskId,
          sessionId: result.rootSessionId,
          eventType: "executor.callback_completed",
          actorType: "orchestrator",
          payload: { accepted: result.ok, artifactResourceId: artifactRef.resourceId, artifactRefId: artifactRef.artifactRefId, legacyBindingMissing: true },
        });
      }
    } else {
      await appendHistoryEventPg(tx, {
        runId: result.runId,
        taskId: result.taskId,
        sessionId: result.rootSessionId,
        eventType: "executor.callback_completed",
        actorType: "orchestrator",
        payload: { accepted: result.ok, artifactResourceId: artifactRef.resourceId, artifactRefId: artifactRef.artifactRefId },
      });
    }

    await patchManagedHandExecutionTerminalPg(tx, {
      result,
      attemptId,
      handExecutionId,
      artifactRefId: artifactRef.artifactRefId,
      artifactResourceId: artifactRef.resourceId,
    });

    await tx.query(
      "update southstar.workflow_tasks set status = $1, updated_at = now(), completed_at = coalesce(completed_at, now()) where run_id = $2 and id = $3",
      [result.ok ? "completed" : "failed", result.runId, result.taskId],
    );

    const allTasks = await tx.query<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1", [result.runId]);
    if (allTasks.rows.length > 0 && allTasks.rows.every((row) => ["completed", "failed", "cancelled", "lost", "blocked"].includes(row.status))) {
      const gateResult = await evaluateRunCompletionGatePg(tx, { runId: result.runId });
      if (gateResult.status !== "not_ready") {
        await triggerRunCompletedKnowledgeCardSynthesis(tx, {
          runId: result.runId,
          actor: "southstar-evolution",
          reason: "workflow run completed",
        });
      }
    }

    return { accepted: result.ok, artifactResourceId: artifactRef.resourceId, artifactRefId: artifactRef.artifactRefId };
  });
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

async function patchManagedHandExecutionTerminalPg(
  db: SouthstarDb,
  input: {
    result: PostgresTaskRunCallbackResult;
    attemptId: string;
    handExecutionId: string;
    artifactRefId: string;
    artifactResourceId: string;
  },
): Promise<void> {
  const existing = await getResourceByKeyPg(db, "hand_execution", input.handExecutionId);
  if (!existing) return;
  if (isHandExecutionTerminalStatus(existing.status)) return;
  const existingPayload = asRecord(existing?.payload);
  const terminalAt = input.result.receivedAt ?? new Date().toISOString();
  const status = input.result.ok ? "completed" : "failed";
  await upsertRuntimeResourcePg(db, {
    id: existing?.id ?? input.handExecutionId,
    resourceType: "hand_execution",
    resourceKey: input.handExecutionId,
    runId: input.result.runId,
    taskId: input.result.taskId,
    sessionId: input.result.rootSessionId,
    scope: "hand",
    status,
    title: existing?.title ?? `Hand execution ${input.result.taskId}`,
    payload: {
      ...existingPayload,
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId: input.handExecutionId,
      providerId: "tork",
      runId: input.result.runId,
      taskId: input.result.taskId,
      sessionId: input.result.rootSessionId,
      attemptId: input.attemptId,
      status,
      terminalAt,
    },
    summary: {
      ...asRecord(existing?.summary),
      providerId: "tork",
      attemptId: input.attemptId,
      accepted: input.result.ok,
      artifactRefId: input.artifactRefId,
      artifactResourceId: input.artifactResourceId,
    },
    metrics: {
      ...asRecord(existing.metrics),
      ...input.result.metrics,
    },
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

export async function callbackBindingExistsPg(db: SouthstarDb, input: { runId: string; taskId: string; attemptId?: string }): Promise<boolean> {
  if (!input.attemptId) return true;
  const handExecution = await getResourceByKeyPg(db, "hand_execution", canonicalHandExecutionId(input.runId, input.taskId, input.attemptId));
  if (handExecution) return true;
  const binding = await getResourceByKeyPg(db, "executor_binding", `executor-${input.runId}-${input.taskId}-${input.attemptId}`);
  return Boolean(binding);
}

function callbackReceiptToken(result: PostgresTaskRunCallbackResult, handExecutionId: string): { idempotencyKey: string; artifactHash: string } {
  const artifactHash = createHash("sha256").update(stableStringify(result.artifact)).digest("hex");
  return {
    artifactHash,
    idempotencyKey: `${handExecutionId}:callback:${artifactHash}`,
  };
}

function normalizedAttemptId(result: PostgresTaskRunCallbackResult): string {
  return result.attemptId ?? `attempt-${result.attempts}`;
}

function canonicalHandExecutionId(runId: string, taskId: string, attemptId: string): string {
  return `hand-execution:${runId}:${taskId}:${attemptId}`;
}

function artifactType(artifact: unknown): string {
  if (artifact && typeof artifact === "object" && typeof (artifact as { kind?: unknown }).kind === "string") {
    return (artifact as { kind: string }).kind;
  }
  return "callback_artifact";
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
  currentRootSessionId?: string,
): Promise<{ callbackAttemptId: string; latestAttemptId: string } | undefined> {
  const latestAttemptId = await latestCallbackAttemptIdPg(db, result.runId, result.taskId);
  if (!latestAttemptId) return undefined;

  if (!result.attemptId) {
    if (currentRootSessionId === result.rootSessionId) return undefined;
    return attemptNumber(latestAttemptId) > 1 ? { callbackAttemptId: "unknown", latestAttemptId } : undefined;
  }

  if (attemptNumber(result.attemptId) < attemptNumber(latestAttemptId)) {
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
    .sort((left, right) => attemptNumber(right) - attemptNumber(left))[0];
}

function attemptNumber(value: string): number {
  const match = value.match(/attempt-(\d+)/);
  return match ? Number(match[1]) : 1;
}

function isTaskTerminalStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "lost", "blocked"].includes(status);
}

function isHandExecutionTerminalStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "lost", "superseded"].includes(status);
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
