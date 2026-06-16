import { appendHistoryEvent } from "../stores/history-store.ts";
import { getResourceByKey, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { TorkObservationClient } from "./provider.ts";
import type { ExecutorBindingRecord } from "./bindings.ts";
import type { ExecutorReconcileFinding } from "./reconciler.ts";

export async function dispatchExecutorActions(db: SouthstarDb, input: {
  finding: ExecutorReconcileFinding;
  binding: ExecutorBindingRecord;
  tork: TorkObservationClient;
}): Promise<void> {
  for (const action of input.finding.actions) {
    const commandId = `executor-action:${input.binding.id}:${input.finding.classification}:${action}`;
    if (getResourceByKey(db, "executor_job_command", commandId)) continue;

    try {
      if (action === "cancel-executor" && input.tork.capabilities().supportsJobCancel) {
        await input.tork.cancelJob(input.binding.payload.torkJobId);
      }

      upsertRuntimeResource(db, {
        resourceType: "executor_job_command",
        resourceKey: commandId,
        runId: input.binding.runId,
        taskId: input.binding.taskId,
        scope: "executor",
        status: "executed",
        title: `Executor ${action}`,
        payload: {
          bindingId: input.binding.id,
          torkJobId: input.binding.payload.torkJobId,
          classification: input.finding.classification,
          action,
        },
      });

      appendHistoryEvent(db, {
        runId: input.binding.runId,
        taskId: input.binding.taskId,
        eventType: "executor.action_dispatched",
        actorType: "orchestrator",
        idempotencyKey: commandId,
        payload: {
          bindingId: input.binding.id,
          action,
          classification: input.finding.classification,
        },
      });
    } catch (error) {
      upsertRuntimeResource(db, {
        resourceType: "executor_job_command",
        resourceKey: commandId,
        runId: input.binding.runId,
        taskId: input.binding.taskId,
        scope: "executor",
        status: "failed",
        title: `Executor ${action}`,
        payload: {
          bindingId: input.binding.id,
          torkJobId: input.binding.payload.torkJobId,
          classification: input.finding.classification,
          action,
          error: (error as Error).message,
        },
      });
      appendHistoryEvent(db, {
        runId: input.binding.runId,
        taskId: input.binding.taskId,
        eventType: "executor.action_failed",
        actorType: "orchestrator",
        idempotencyKey: `${commandId}:failed`,
        payload: {
          bindingId: input.binding.id,
          action,
          classification: input.finding.classification,
          error: (error as Error).message,
        },
      });
    }
  }
}
