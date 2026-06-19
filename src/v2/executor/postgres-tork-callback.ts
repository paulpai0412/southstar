import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, listResourcesPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
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
};

export async function ingestTaskRunResultPg(db: SouthstarDb, result: PostgresTaskRunCallbackResult): Promise<PostgresCallbackIngestionResult> {
  const receipt = callbackReceiptToken(result);
  return await db.tx(async (tx) => {
    const task = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2 for update",
      [result.runId, result.taskId],
    );
    if (!task) throw new Error(`callback task not found: ${result.runId}/${result.taskId}`);

    const existingReceipt = await tx.maybeOne<{ id: string }>(
      "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
      [result.runId, receipt.idempotencyKey],
    );
    if (existingReceipt) return { accepted: true, duplicate: true };

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

    const artifactResourceId = `artifact-${result.runId}-${result.taskId}-${result.attemptId ?? `attempt-${result.attempts}`}`;
    await upsertRuntimeResourcePg(tx, {
      id: artifactResourceId,
      resourceType: "artifact",
      resourceKey: artifactResourceId,
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      scope: "artifact",
      status: result.ok ? "accepted" : "rejected",
      title: `Callback artifact ${result.taskId}`,
      payload: result.artifact,
      summary: {
        attemptId: result.attemptId,
        artifactHash: receipt.artifactHash,
        accepted: result.ok,
      },
      metrics: result.metrics,
    });

    await appendHistoryEventPg(tx, {
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      eventType: "artifact.created",
      actorType: "orchestrator",
      payload: {
        artifactResourceId,
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
          artifactResourceId,
        },
      });
    } else {
      await appendHistoryEventPg(tx, {
        runId: result.runId,
        taskId: result.taskId,
        sessionId: result.rootSessionId,
        eventType: "executor.callback_completed",
        actorType: "orchestrator",
        payload: { accepted: result.ok, artifactResourceId },
      });
    }

    await tx.query(
      "update southstar.workflow_tasks set status = $1, updated_at = now(), completed_at = coalesce(completed_at, now()) where run_id = $2 and id = $3",
      [result.ok ? "completed" : "failed", result.runId, result.taskId],
    );

    const allTasks = await tx.query<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1", [result.runId]);
    if (allTasks.rows.length > 0 && allTasks.rows.every((row) => ["completed", "failed", "cancelled"].includes(row.status))) {
      const passed = allTasks.rows.every((row) => row.status === "completed");
      await tx.query(
        "update southstar.workflow_runs set status = $1, updated_at = now(), completed_at = coalesce(completed_at, now()) where id = $2",
        [passed ? "passed" : "failed", result.runId],
      );
      await appendHistoryEventPg(tx, {
        runId: result.runId,
        eventType: "run.completed",
        actorType: "orchestrator",
        payload: { status: passed ? "passed" : "failed" },
      });
      await triggerRunCompletedKnowledgeCardSynthesis(tx, {
        runId: result.runId,
        actor: "southstar-evolution",
        reason: "workflow run completed",
      });
    }

    return { accepted: result.ok, artifactResourceId };
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
