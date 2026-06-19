import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, listResourcesPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { TorkObservationClient } from "./provider.ts";
import { listExecutorBindingsForRunPg, updateExecutorBindingStatusPg, type ExecutorBindingRecordPg } from "./postgres-bindings.ts";
import { actionsForExecutorClassification } from "./policy.ts";
import { classifyExecutorTimeouts, normalizeTorkStatus, type ExecutorBindingPayload, type SouthstarExecutorStatus } from "./observability-types.ts";

export type ExecutorReconcileFindingPg = {
  bindingId: string;
  runId: string;
  taskId: string;
  classification: SouthstarExecutorStatus | "failed";
  actions: string[];
};

export type ExecutorReconcileResultPg = {
  findings: ExecutorReconcileFindingPg[];
};

export async function reconcileExecutorBindingsPg(db: SouthstarDb, input: {
  tork: TorkObservationClient;
  actionMode?: "observe" | "auto";
  now?: string;
}): Promise<ExecutorReconcileResultPg> {
  const now = input.now ?? new Date().toISOString();
  const runIds = await executorBindingRunIds(db);
  const findings: ExecutorReconcileFindingPg[] = [];

  for (const runId of runIds) {
    const bindings = await listExecutorBindingsForRunPg(db, runId);
    for (const binding of bindings) {
      let observedStatus: string | undefined;
      let logs = "";
      try {
        const observed = await input.tork.getJob(binding.payload.torkJobId);
        observedStatus = observed.status;
        if (input.tork.capabilities().supportsJobLogs) logs = await compactLogs(input.tork, binding.payload.torkJobId);
      } catch (error) {
        const finding = await recordFinding(db, { binding, classification: "lost", now, detail: { error: (error as Error).message } });
        findings.push(finding);
        await maybeDispatchActionsPg(db, { finding, binding, tork: input.tork, actionMode: input.actionMode });
        continue;
      }

      const taskStatus = await readTaskStatus(db, binding.runId, binding.taskId);
      const normalized = normalizeTorkStatus(observedStatus);
      const timeoutFindings = classifyExecutorTimeouts({ ...binding.payload, torkObservedStatus: observedStatus }, Date.parse(now));

      if (taskStatus && ["completed", "failed", "cancelled"].includes(taskStatus) && normalized.category === "running-like") {
        const finding = await recordFinding(db, { binding, classification: "orphaned", now, detail: { torkObservedStatus: observedStatus, logs } });
        findings.push(finding);
        await maybeDispatchActionsPg(db, { finding, binding, tork: input.tork, actionMode: input.actionMode });
        continue;
      }

      if (normalized.category === "completed-like" && !binding.payload.callbackReceivedAt) {
        const finding = await recordFinding(db, { binding, classification: preserveCompletedClassification(binding.payload.southstarExecutorStatus), now, detail: { torkObservedStatus: observedStatus, logs } });
        findings.push(finding);
        await maybeDispatchActionsPg(db, { finding, binding, tork: input.tork, actionMode: input.actionMode });
        continue;
      }

      if (normalized.category === "failed-like") {
        const finding = await recordFinding(db, { binding, classification: "failed", now, detail: { torkObservedStatus: observedStatus, logs } });
        findings.push(finding);
        await maybeDispatchActionsPg(db, { finding, binding, tork: input.tork, actionMode: input.actionMode });
        continue;
      }

      for (const timeout of timeoutFindings) {
        const finding = await recordFinding(db, { binding, classification: timeout, now, detail: { torkObservedStatus: observedStatus, logs } });
        findings.push(finding);
        await maybeDispatchActionsPg(db, { finding, binding, tork: input.tork, actionMode: input.actionMode });
      }
    }
  }

  return { findings };
}

async function executorBindingRunIds(db: SouthstarDb): Promise<string[]> {
  const rows = await db.query<{ run_id: string }>(
    "select distinct run_id from southstar.runtime_resources where resource_type = 'executor_binding' and run_id is not null order by run_id",
  );
  return rows.rows.map((row) => row.run_id);
}

async function recordFinding(db: SouthstarDb, input: {
  binding: ExecutorBindingRecordPg;
  classification: SouthstarExecutorStatus | "failed";
  now: string;
  detail: Record<string, unknown>;
}): Promise<ExecutorReconcileFindingPg> {
  const status = input.classification === "failed" ? "failed" : input.classification;
  const actions = actionsForExecutorClassification(input.classification);
  const nextGeneration = input.binding.payload.reconcileGeneration + 1;
  await updateExecutorBindingStatusPg(db, {
    bindingId: input.binding.id,
    status,
    eventType: eventTypeForClassification(input.classification),
    payloadPatch: {
      torkObservedStatus: typeof input.detail.torkObservedStatus === "string" ? input.detail.torkObservedStatus : input.binding.payload.torkObservedStatus,
      lastReconcileAt: input.now,
      reconcileGeneration: nextGeneration,
    },
    eventPayload: input.detail,
  });

  const reconcileResourceKey = `reconcile-${input.binding.id}-${nextGeneration}-${input.classification}`;
  await upsertRuntimeResourcePg(db, {
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
    summary: { classification: input.classification, actionCount: actions.length },
  });

  if (typeof input.detail.logs === "string" && input.detail.logs.length > 0) {
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_log_ref",
      resourceKey: `log-${input.binding.id}-${nextGeneration}`,
      runId: input.binding.runId,
      taskId: input.binding.taskId,
      scope: "executor",
      status: "captured",
      title: "Executor logs summary",
      payload: { bindingId: input.binding.id, summary: input.detail.logs },
      summary: { preview: input.detail.logs.slice(0, 200) },
    });
  }

  await appendHistoryEventPg(db, {
    runId: input.binding.runId,
    taskId: input.binding.taskId,
    eventType: "executor.reconcile_completed",
    actorType: "orchestrator",
    payload: { bindingId: input.binding.id, classification: input.classification, actions },
  });

  return { bindingId: input.binding.id, runId: input.binding.runId, taskId: input.binding.taskId, classification: input.classification, actions };
}

async function maybeDispatchActionsPg(db: SouthstarDb, input: {
  finding: ExecutorReconcileFindingPg;
  binding: ExecutorBindingRecordPg;
  tork: TorkObservationClient;
  actionMode?: "observe" | "auto";
}): Promise<void> {
  if (input.actionMode === "observe") return;
  for (const action of input.finding.actions) {
    const commandId = `executor-action:${input.binding.id}:${input.finding.classification}:${action}`;
    const existing = await db.maybeOne<{ id: string }>("select id from southstar.runtime_resources where resource_type = 'executor_job_command' and resource_key = $1", [commandId]);
    if (existing) continue;
    try {
      if (action === "cancel-executor" && input.tork.capabilities().supportsJobCancel) await input.tork.cancelJob(input.binding.payload.torkJobId);
      await upsertRuntimeResourcePg(db, {
        resourceType: "executor_job_command",
        resourceKey: commandId,
        runId: input.binding.runId,
        taskId: input.binding.taskId,
        scope: "executor",
        status: "executed",
        title: `Executor ${action}`,
        payload: { bindingId: input.binding.id, torkJobId: input.binding.payload.torkJobId, classification: input.finding.classification, action },
      });
      await appendHistoryEventPg(db, {
        runId: input.binding.runId,
        taskId: input.binding.taskId,
        eventType: "executor.action_dispatched",
        actorType: "orchestrator",
        idempotencyKey: commandId,
        payload: { bindingId: input.binding.id, action, classification: input.finding.classification },
      });
    } catch (error) {
      await upsertRuntimeResourcePg(db, {
        resourceType: "executor_job_command",
        resourceKey: commandId,
        runId: input.binding.runId,
        taskId: input.binding.taskId,
        scope: "executor",
        status: "failed",
        title: `Executor ${action}`,
        payload: { bindingId: input.binding.id, torkJobId: input.binding.payload.torkJobId, classification: input.finding.classification, action, error: (error as Error).message },
      });
      await appendHistoryEventPg(db, {
        runId: input.binding.runId,
        taskId: input.binding.taskId,
        eventType: "executor.action_failed",
        actorType: "orchestrator",
        idempotencyKey: `${commandId}:failed`,
        payload: { bindingId: input.binding.id, action, classification: input.finding.classification, error: (error as Error).message },
      });
    }
  }
}

async function readTaskStatus(db: SouthstarDb, runId: string, taskId: string): Promise<string | undefined> {
  const row = await db.maybeOne<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1 and id = $2", [runId, taskId]);
  return row?.status;
}

async function compactLogs(tork: TorkObservationClient, jobId: string): Promise<string> {
  const logs = await tork.getJobLogs(jobId);
  return logs.slice(0, 4000).replace(/(token|password|secret)[=:]\S+/gi, "$1=<redacted>");
}

function preserveCompletedClassification(currentStatus: SouthstarExecutorStatus): SouthstarExecutorStatus | "failed" {
  if (["heartbeat-lost", "queue-timeout", "hard-timeout", "lost", "orphaned"].includes(currentStatus)) return currentStatus;
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
