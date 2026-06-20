import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { acceptOrRejectArtifactRefPg } from "../artifacts/artifact-ref-store.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import { evaluateRunCompletionGatePg } from "../evaluators/completion-gate.ts";
import { appendHistoryEventPg, listResourcesPg } from "../stores/postgres-runtime-store.ts";
import { triggerRunCompletedKnowledgeCardSynthesis } from "../evolution/cards.ts";
import { updateExecutorBindingStatusPg } from "./postgres-bindings.ts";
import type { TaskRunCallbackResult } from "./tork-callback.ts";

export type PostgresTaskRunCallbackResult = TaskRunCallbackResult & {
  receivedAt?: string;
};

export type PostgresCallbackIngestionResult = {
  accepted: boolean;
  duplicate?: boolean;
  artifactResourceId?: string;
  artifactRefId?: string;
};

export async function ingestTaskRunResultPg(db: SouthstarDb, result: PostgresTaskRunCallbackResult): Promise<PostgresCallbackIngestionResult> {
  const receipt = callbackReceiptToken(result);
  return await db.tx(async (tx) => {
    const task = await tx.maybeOne<{ status: string; root_session_id: string | null }>(
      "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [result.runId, result.taskId],
    );
    if (!task) throw new Error(`callback task not found: ${result.runId}/${result.taskId}`);

    const existingReceipt = await tx.maybeOne<{ id: string }>(
      "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
      [result.runId, receipt.idempotencyKey],
    );
    if (existingReceipt) return { ...(await duplicateCallbackOutcome(tx, result, receipt.idempotencyKey)), duplicate: true };

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
      attemptId: result.attemptId ?? `attempt-${result.attempts}`,
      handExecutionId: `executor-callback:${result.runId}:${result.taskId}:${result.attemptId ?? result.attempts}`,
      producer: { actorType: "hand", providerId: "tork-callback" },
      artifactType: artifactType(result.artifact),
      status: result.ok ? "accepted" : "rejected",
      content: result.artifact,
      contractRefs: [`task:${result.taskId}:completion`],
      summary: `Callback artifact ${result.taskId}`,
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

    if (result.attemptId) {
      const bindingId = `executor-${result.runId}-${result.taskId}-${result.attemptId}`;
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
        payload: { accepted: result.ok, artifactResourceId: artifactRef.resourceId, artifactRefId: artifactRef.artifactRefId },
      });
    }

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

export async function callbackBindingExistsPg(db: SouthstarDb, input: { runId: string; taskId: string; attemptId?: string }): Promise<boolean> {
  if (!input.attemptId) return true;
  const bindings = await listResourcesPg(db, { resourceType: "executor_binding" });
  return bindings.some((binding) => binding.resourceKey === `executor-${input.runId}-${input.taskId}-${input.attemptId}`);
}

function callbackReceiptToken(result: PostgresTaskRunCallbackResult): { idempotencyKey: string; artifactHash: string } {
  const artifactHash = createHash("sha256").update(stableStringify(result.artifact)).digest("hex");
  return {
    artifactHash,
    idempotencyKey: `executor-callback:${result.runId}:${result.taskId}:${result.attemptId ?? result.attempts}:${artifactHash}`,
  };
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
  const latestAttemptId = await latestExecutorAttemptIdPg(db, result.runId, result.taskId);
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

async function latestExecutorAttemptIdPg(db: SouthstarDb, runId: string, taskId: string): Promise<string | undefined> {
  const rows = await db.query<{ attempt_id: string | null }>(
    `select payload_json ->> 'attemptId' as attempt_id
       from southstar.runtime_resources
      where run_id = $1
        and task_id = $2
        and resource_type = 'executor_binding'`,
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
