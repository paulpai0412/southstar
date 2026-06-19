// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import { appendHistoryEvent } from "../../stores/history-store.ts";
import { listResources, upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
import type { SouthstarCommandRequest, SouthstarCommandResult } from "./types.ts";
import { rejectedCommand } from "./types.ts";

type ExecutorPayload = { reason?: string };
type ExecutorCommand = SouthstarCommandRequest<ExecutorPayload> & { jobId: string };

export function retryExecutorJobCommand(db: SouthstarDb, input: ExecutorCommand): SouthstarCommandResult {
  return recordExecutorJobCommand(db, input, "retry", "executor.job.retry.requested", "Retry requested through Southstar task attempt policy.");
}

export function cancelExecutorJobCommand(db: SouthstarDb, input: ExecutorCommand): SouthstarCommandResult {
  return recordExecutorJobCommand(db, input, "cancel", "executor.job.cancel.requested", "Cancel requested through Southstar executor binding.");
}

export function reconcileExecutorJobCommand(db: SouthstarDb, input: ExecutorCommand): SouthstarCommandResult {
  return recordExecutorJobCommand(db, input, "reconcile", "executor.job.reconciled", "Executor projection reconciled against Southstar state.");
}

function recordExecutorJobCommand(db: SouthstarDb, input: ExecutorCommand, action: string, eventType: string, next: string): SouthstarCommandResult {
  const binding = findBinding(db, input.jobId);
  if (!binding) return rejectedCommand(input.commandId, "Select an existing executor job before issuing executor commands.");
  ensureRun(db, binding.runId ?? "executor-ops");
  const resource = upsertRuntimeResource(db, {
    resourceType: "executor_job_command",
    resourceKey: input.commandId,
    runId: binding.runId ?? undefined,
    taskId: binding.taskId ?? undefined,
    scope: "executor",
    status: action,
    title: `Executor ${action}`,
    payload: { jobId: input.jobId, action, reason: input.payload.reason ?? "", bindingId: binding.id },
  });
  const event = appendHistoryEvent(db, { runId: binding.runId ?? "executor-ops", taskId: binding.taskId ?? undefined, eventType, actorType: input.actor.type, payload: { commandId: input.commandId, jobId: input.jobId, action } });
  return { commandId: input.commandId, accepted: true, status: "queued", affectedRunId: binding.runId ?? undefined, affectedTaskId: binding.taskId ?? undefined, resourceRefs: [resource.id], eventRefs: [String(event.sequence)], nextSuggestedActions: [next] };
}

function findBinding(db: SouthstarDb, jobId: string) {
  return listResources(db, { resourceType: "executor_binding" }).find((resource) => {
    const payload = resource.payload as { torkJobId?: string; externalJobId?: string };
    return payload.torkJobId === jobId || payload.externalJobId === jobId || resource.resourceKey === jobId;
  });
}

function ensureRun(db: SouthstarDb, runId: string): void {
  const exists = db.prepare("select 1 from workflow_runs where id = ?").get(runId);
  if (exists) return;
  const now = new Date().toISOString();
  db.prepare(`insert into workflow_runs (id,status,domain,goal_prompt,executor_job_id,workflow_manifest_json,execution_projection_json,snapshot_json,runtime_context_json,metrics_json,created_at,updated_at,completed_at) values (?, 'running', 'software', '', null, '{"tasks":[]}', '{}', '{}', '{}', '{}', ?, ?, null)`).run(runId, now, now);
}
