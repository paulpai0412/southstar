import { appendHistoryEvent } from "../stores/history-store.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type {
  TorkObservationClient,
} from "./provider.ts";
import {
  listExecutorBindingsForRun,
  updateExecutorBindingStatus,
} from "./bindings.ts";
import { dispatchExecutorActions } from "./action-dispatcher.ts";
import {
  classifyExecutorTimeouts,
  normalizeTorkStatus,
  type ExecutorBindingPayload,
  type SouthstarExecutorStatus,
} from "./observability-types.ts";
import { actionsForExecutorClassification } from "./policy.ts";

export type ExecutorReconcileFinding = {
  bindingId: string;
  runId: string;
  taskId: string;
  classification: SouthstarExecutorStatus | "failed";
  actions: string[];
};

export type ExecutorReconcileResult = {
  findings: ExecutorReconcileFinding[];
};

export async function reconcileExecutorBindings(db: SouthstarDb, input: {
  tork: TorkObservationClient;
  actionMode?: "observe" | "auto";
  now?: string;
}): Promise<ExecutorReconcileResult> {
  const now = input.now ?? new Date().toISOString();
  const runRows = db.prepare("select distinct run_id from runtime_resources where resource_type = 'executor_binding' and run_id is not null")
    .all() as Array<{ run_id: string }>;
  const findings: ExecutorReconcileFinding[] = [];

  for (const row of runRows) {
    const bindings = listExecutorBindingsForRun(db, row.run_id);
    for (const binding of bindings) {
      let observedStatus: string | undefined;
      let logs = "";

      try {
        const observed = await input.tork.getJob(binding.payload.torkJobId);
        observedStatus = observed.status;
        if (input.tork.capabilities().supportsJobLogs) {
          logs = await compactLogs(input.tork, binding.payload.torkJobId);
        }
      } catch (error) {
        const finding = recordFinding(db, {
          binding,
          classification: "lost",
          now,
          detail: { error: (error as Error).message },
        });
        findings.push(finding);
        if (input.actionMode !== "observe") {
          await dispatchExecutorActions(db, { finding, binding, tork: input.tork });
        }
        continue;
      }

      const taskStatus = readTaskStatus(db, binding.runId, binding.taskId);
      const normalized = normalizeTorkStatus(observedStatus);
      const timeoutFindings = classifyExecutorTimeouts(
        {
          ...binding.payload,
          torkObservedStatus: observedStatus,
        },
        Date.parse(now),
      );

      if (taskStatus && ["completed", "failed", "cancelled"].includes(taskStatus) && normalized.category === "running-like") {
        const finding = recordFinding(db, {
          binding,
          classification: "orphaned",
          now,
          detail: { torkObservedStatus: observedStatus, logs },
        });
        findings.push(finding);
        if (input.actionMode !== "observe") {
          await dispatchExecutorActions(db, { finding, binding, tork: input.tork });
        }
        continue;
      }

      if (normalized.category === "completed-like" && !binding.payload.callbackReceivedAt) {
        const completedClassification = preserveCompletedClassification(binding.payload.southstarExecutorStatus);
        const finding = recordFinding(db, {
          binding,
          classification: completedClassification,
          now,
          detail: { torkObservedStatus: observedStatus, logs },
        });
        findings.push(finding);
        if (input.actionMode !== "observe") {
          await dispatchExecutorActions(db, { finding, binding, tork: input.tork });
        }
        continue;
      }

      if (normalized.category === "failed-like") {
        const finding = recordFinding(db, {
          binding,
          classification: "failed",
          now,
          detail: { torkObservedStatus: observedStatus, logs },
        });
        findings.push(finding);
        if (input.actionMode !== "observe") {
          await dispatchExecutorActions(db, { finding, binding, tork: input.tork });
        }
        continue;
      }

      for (const timeout of timeoutFindings) {
        const finding = recordFinding(db, {
          binding,
          classification: timeout,
          now,
          detail: { torkObservedStatus: observedStatus, logs },
        });
        findings.push(finding);
        if (input.actionMode !== "observe") {
          await dispatchExecutorActions(db, { finding, binding, tork: input.tork });
        }
      }
    }
  }

  return { findings };
}

function recordFinding(db: SouthstarDb, input: {
  binding: {
    id: string;
    runId: string;
    taskId: string;
    payload: ExecutorBindingPayload;
  };
  classification: SouthstarExecutorStatus | "failed";
  now: string;
  detail: Record<string, unknown>;
}): ExecutorReconcileFinding {
  const status = input.classification === "failed" ? "failed" : input.classification;
  const actions = actionsForExecutorClassification(input.classification);

  updateExecutorBindingStatus(db, {
    bindingId: input.binding.id,
    status,
    eventType: eventTypeForClassification(input.classification),
    payloadPatch: {
      torkObservedStatus: typeof input.detail.torkObservedStatus === "string"
        ? input.detail.torkObservedStatus
        : input.binding.payload.torkObservedStatus,
      lastReconcileAt: input.now,
      reconcileGeneration: input.binding.payload.reconcileGeneration + 1,
    },
    eventPayload: input.detail,
  });

  const reconcileResourceKey = `reconcile-${input.binding.id}-${input.binding.payload.reconcileGeneration + 1}-${input.classification}`;
  upsertRuntimeResource(db, {
    resourceType: "executor_reconcile_result",
    resourceKey: reconcileResourceKey,
    runId: input.binding.runId,
    taskId: input.binding.taskId,
    scope: "executor",
    status,
    title: `Executor reconcile ${input.classification}`,
    payload: {
      bindingId: input.binding.id,
      classification: input.classification,
      actions,
      detail: input.detail,
    },
    summary: {
      classification: input.classification,
      actionCount: actions.length,
    },
  });

  if (typeof input.detail.logs === "string" && input.detail.logs.length > 0) {
    upsertRuntimeResource(db, {
      resourceType: "executor_log_ref",
      resourceKey: `log-${input.binding.id}-${input.binding.payload.reconcileGeneration + 1}`,
      runId: input.binding.runId,
      taskId: input.binding.taskId,
      scope: "executor",
      status: "captured",
      title: "Executor logs summary",
      payload: {
        bindingId: input.binding.id,
        summary: input.detail.logs,
      },
      summary: {
        preview: input.detail.logs.slice(0, 200),
      },
    });
  }

  appendHistoryEvent(db, {
    runId: input.binding.runId,
    taskId: input.binding.taskId,
    eventType: "executor.reconcile_completed",
    actorType: "orchestrator",
    payload: {
      bindingId: input.binding.id,
      classification: input.classification,
      actions,
    },
  });

  return {
    bindingId: input.binding.id,
    runId: input.binding.runId,
    taskId: input.binding.taskId,
    classification: input.classification,
    actions,
  };
}

function readTaskStatus(db: SouthstarDb, runId: string, taskId: string): string | undefined {
  const row = db.prepare("select status from workflow_tasks where run_id = ? and id = ?")
    .get(runId, taskId) as { status: string } | undefined;
  return row?.status;
}

async function compactLogs(tork: TorkObservationClient, jobId: string): Promise<string> {
  const logs = await tork.getJobLogs(jobId);
  return logs
    .slice(0, 4000)
    .replace(/(token|password|secret)[=:]\S+/gi, "$1=<redacted>");
}

function preserveCompletedClassification(currentStatus: SouthstarExecutorStatus): SouthstarExecutorStatus | "failed" {
  if (["heartbeat-lost", "queue-timeout", "hard-timeout", "lost", "orphaned"].includes(currentStatus)) {
    return currentStatus;
  }
  return "callback-missing";
}

function eventTypeForClassification(classification: SouthstarExecutorStatus | "failed"): string {
  if (classification === "callback-missing") return "executor.callback_missing";
  if (classification === "heartbeat-lost") return "executor.heartbeat_lost";
  if (classification === "queue-timeout") return "executor.queue_timeout";
  if (classification === "hard-timeout") return "executor.hard_timeout";
  if (classification === "orphaned") return "executor.orphaned";
  if (classification === "lost") return "executor.lost";
  if (classification === "failed") return "executor.failed_observed";
  return "executor.observed";
}
