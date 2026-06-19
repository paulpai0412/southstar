// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import { appendHistoryEvent } from "../../stores/history-store.ts";
import { getResourceByKey, upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
import type { SouthstarCommandRequest, SouthstarCommandResult } from "./types.ts";
import { rejectedCommand } from "./types.ts";

type SessionPayload = { checkpointId?: string; reason?: string };
type SessionCommand = SouthstarCommandRequest<SessionPayload> & { sessionId: string };
type MemoryPayload = { reason?: string };
type MemoryCommand = SouthstarCommandRequest<MemoryPayload> & { memoryId: string };

export function forkSessionCommand(db: SouthstarDb, input: SessionCommand): SouthstarCommandResult {
  return recordSessionLineage(db, input, "session_fork", "session.forked", "forked");
}

export function resetSessionCommand(db: SouthstarDb, input: SessionCommand): SouthstarCommandResult {
  return recordSessionLineage(db, input, "session_reset", "session.reset", "reset");
}

export function rollbackSessionCommand(db: SouthstarDb, input: SessionCommand): SouthstarCommandResult {
  return recordSessionLineage(db, input, "session_rollback", "session.rollback", "rollback");
}

export function rewindSessionCommand(db: SouthstarDb, input: SessionCommand): SouthstarCommandResult {
  return recordSessionLineage(db, input, "session_operation", "session.rewind.requested", "queued");
}

export function approveMemoryCommand(db: SouthstarDb, input: MemoryCommand): SouthstarCommandResult {
  return recordMemoryDecision(db, input, "approved", "memory.approved");
}

export function rejectMemoryCommand(db: SouthstarDb, input: MemoryCommand): SouthstarCommandResult {
  return recordMemoryDecision(db, input, "rejected", "memory.rejected");
}

export function doNotInjectMemoryCommand(db: SouthstarDb, input: MemoryCommand): SouthstarCommandResult {
  return recordMemoryDecision(db, input, "do-not-inject", "memory.do_not_inject");
}

function recordSessionLineage(db: SouthstarDb, input: SessionCommand, resourceType: string, eventType: string, status: string): SouthstarCommandResult {
  const checkpointId = input.payload.checkpointId;
  const checkpoint = checkpointId ? getResourceByKey(db, "session_checkpoint", checkpointId) : undefined;
  const runId = checkpoint?.runId ?? sessionRunId(db, input.sessionId);
  if (!runId) return rejectedCommand(input.commandId, "Select an existing session checkpoint before changing session lineage.");
  const resource = upsertRuntimeResource(db, {
    resourceType,
    resourceKey: input.commandId,
    runId,
    taskId: checkpoint?.taskId,
    sessionId: input.sessionId,
    scope: "session",
    status,
    title: `${resourceType} ${status}`,
    payload: resourceType === "session_operation"
      ? {
        operationId: input.commandId,
        sessionId: input.sessionId,
        checkpointId,
        reason: input.payload.reason ?? "",
        type: "rewind",
        baseCheckpointId: checkpointId ?? "",
        host: "pi",
        status: "queued",
        fallbackUsed: false,
      }
      : { sessionId: input.sessionId, checkpointId, reason: input.payload.reason ?? "" },
  });
  const event = appendHistoryEvent(db, {
    runId,
    taskId: checkpoint?.taskId,
    sessionId: input.sessionId,
    eventType,
    actorType: input.actor.type,
    payload: { commandId: input.commandId, checkpointId, reason: input.payload.reason ?? "" },
  });
  return { commandId: input.commandId, accepted: true, status: "applied", affectedRunId: runId, affectedTaskId: checkpoint?.taskId, resourceRefs: [resource.id], eventRefs: [String(event.sequence)], nextSuggestedActions: ["Inspect session lineage graph."] };
}

function recordMemoryDecision(db: SouthstarDb, input: MemoryCommand, status: string, eventType: string): SouthstarCommandResult {
  const memory = getResourceByKey(db, "memory_item", input.memoryId);
  if (!memory) return rejectedCommand(input.commandId, "Select an existing memory item before deciding injection policy.");
  const resource = upsertRuntimeResource(db, {
    resourceType: "memory_decision",
    resourceKey: `${input.memoryId}:${input.commandId}`,
    runId: memory.runId ?? undefined,
    scope: memory.scope,
    status,
    title: `Memory ${status}`,
    payload: { memoryId: input.memoryId, reason: input.payload.reason ?? "", decision: status },
  });
  const event = appendHistoryEvent(db, {
    runId: memory.runId ?? "memory-global",
    eventType,
    actorType: input.actor.type,
    payload: { commandId: input.commandId, memoryId: input.memoryId, reason: input.payload.reason ?? "" },
  });
  return { commandId: input.commandId, accepted: true, status: "applied", affectedRunId: memory.runId ?? undefined, resourceRefs: [resource.id], eventRefs: [String(event.sequence)], nextSuggestedActions: ["Future ContextPackets will honor this memory decision."] };
}

function sessionRunId(db: SouthstarDb, sessionId: string): string | undefined {
  const row = db.prepare("select run_id from runtime_resources where session_id = ? or resource_key = ? order by created_at desc limit 1").get(sessionId, sessionId) as { run_id: string | null } | undefined;
  return row?.run_id ?? undefined;
}
