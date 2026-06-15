import { appendRuntimeEvent } from "../../signals/events.ts";
import { upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
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
  const resource = upsertRuntimeResource(db, {
    resourceType: "recovery_decision",
    resourceKey: input.commandId,
    runId: input.runId,
    taskId: input.taskId,
    scope: "session",
    status,
    title,
    payload: { reason: input.payload.reason ?? "", commandId: input.commandId },
  });
  const event = appendRuntimeEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType,
    actorType: input.actor.type,
    payload: { commandId: input.commandId, reason: input.payload.reason ?? "" },
  });
  return {
    commandId: input.commandId,
    accepted: true,
    status: "queued",
    affectedRunId: input.runId,
    affectedTaskId: input.taskId,
    resourceRefs: [resource.id],
    eventRefs: [String(event.sequence)],
    nextSuggestedActions: [next],
  };
}
