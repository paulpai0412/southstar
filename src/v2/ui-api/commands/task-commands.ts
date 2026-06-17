import { appendRuntimeEvent } from "../../signals/events.ts";
import { upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { createSessionCheckpoint } from "../../session-recovery/checkpoints.ts";
import { commitRecoveryDecision } from "../../session-recovery/operations.ts";
import type { RecoveryStrategy } from "../../session-recovery/types.ts";
import type { SouthstarCommandRequest, SouthstarCommandResult } from "./types.ts";

type TaskCommandPayload = { reason?: string; prompt?: string };
type TaskCommand = SouthstarCommandRequest<TaskCommandPayload> & { runId: string; taskId: string };

export function retryTaskCommand(db: SouthstarDb, input: TaskCommand): SouthstarCommandResult {
  return recordTaskDecision(db, input, "task.retry.requested", "retry", "Retry task requested", "Watch Runtime Monitor for executor submission.");
}

export function requestTaskSessionForkCommand(db: SouthstarDb, input: TaskCommand): SouthstarCommandResult {
  return recordTaskDecision(db, input, "session.fork.requested", "fork", "Session fork requested", "Inspect Sessions / Memory lineage.");
}

export function rollbackWorkspaceCommand(db: SouthstarDb, input: TaskCommand): SouthstarCommandResult {
  return recordTaskDecision(db, input, "workspace.rollback.requested", "rollback", "Workspace rollback requested", "Open Worktree Console for rollback preview.");
}

export function requestWorkflowRevisionCommand(db: SouthstarDb, input: TaskCommand): SouthstarCommandResult {
  const resource = upsertRuntimeResource(db, {
    resourceType: "workflow_revision_request",
    resourceKey: input.commandId,
    runId: input.runId,
    taskId: input.taskId,
    scope: "workflow",
    status: "requested",
    title: "Workflow revision requested",
    payload: { prompt: input.payload.prompt ?? input.payload.reason ?? "" },
  });
  const event = appendRuntimeEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: "workflow.revision.requested",
    actorType: input.actor.type,
    payload: { commandId: input.commandId, prompt: input.payload.prompt ?? "" },
  });
  return {
    commandId: input.commandId,
    accepted: true,
    status: "queued",
    affectedRunId: input.runId,
    affectedTaskId: input.taskId,
    resourceRefs: [resource.id],
    eventRefs: [String(event.sequence)],
    nextSuggestedActions: ["Review revision proposal in Workflow Canvas."],
  };
}

function recordTaskDecision(db: SouthstarDb, input: TaskCommand, eventType: string, status: string, title: string, next: string): SouthstarCommandResult {
  const sessionId = taskSessionId(db, input.runId, input.taskId) ?? `root-${input.runId}-${input.taskId}`;
  const checkpoint = createSessionCheckpoint(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId,
    kind: "before-recovery",
    createdBy: input.actor.type === "root-session" ? "root-session" : input.actor.type === "user" ? "operator" : "orchestrator",
    checkpointSummary: input.payload.reason ?? title,
    failureSummary: input.payload.reason,
    contextTokenEstimate: latestContextTokenEstimate(db, input.runId, input.taskId),
    policy: {
      safeForAutoRetry: status === "retry",
      safeForFork: status === "fork",
      safeForReset: status === "retry",
      safeForWorkspaceRollback: status === "rollback",
    },
  });
  const strategy = strategyForStatus(status);
  const decision = commitRecoveryDecision(db, {
    runId: input.runId,
    taskId: input.taskId,
    source: input.actor.type === "user" ? "operator" : "evaluator",
    requestedStrategy: strategy,
    selectedStrategy: strategy,
    beforeRecoveryCheckpointId: checkpoint.checkpointId,
    baseCheckpointId: checkpoint.checkpointId,
    reason: input.payload.reason ?? title,
    authorization: { mode: status === "rollback" ? "operator-approved" : "auto", policyReasons: [`operator_${status}`] },
    tokenTelemetry: { originalContextTokenEstimate: checkpoint.tokenTelemetry.contextTokenEstimate },
  });
  const event = appendRuntimeEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType,
    actorType: input.actor.type,
    payload: {
      commandId: input.commandId,
      reason: input.payload.reason ?? "",
      recoveryDecisionId: decision.decisionId,
      checkpointId: checkpoint.checkpointId,
    },
  });
  return {
    commandId: input.commandId,
    accepted: true,
    status: "queued",
    affectedRunId: input.runId,
    affectedTaskId: input.taskId,
    resourceRefs: [decision.decisionId, checkpoint.checkpointId],
    eventRefs: [String(event.sequence)],
    nextSuggestedActions: [next],
  };
}

function strategyForStatus(status: string): RecoveryStrategy {
  if (status === "retry") return "retry-same-agent";
  if (status === "fork") return "fork-from-checkpoint";
  if (status === "rollback") return "rollback-workspace";
  return "ask-human";
}

function taskSessionId(db: SouthstarDb, runId: string, taskId: string): string | undefined {
  const row = db.prepare("select root_session_id from workflow_tasks where run_id = ? and id = ?")
    .get(runId, taskId) as { root_session_id: string | null } | undefined;
  return row?.root_session_id ?? undefined;
}

function latestContextTokenEstimate(db: SouthstarDb, runId: string, taskId: string): number {
  const row = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and task_id = ? and resource_type = 'context_packet'
    order by updated_at desc limit 1
  `).get(runId, taskId) as { payload_json: string } | undefined;
  if (!row) return 1;
  const payload = JSON.parse(row.payload_json) as { tokenEstimate?: { total?: number } };
  return typeof payload.tokenEstimate?.total === "number" ? payload.tokenEstimate.total : 1;
}
