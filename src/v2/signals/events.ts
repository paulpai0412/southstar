import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";

export const RUNTIME_EVENT_TYPES = [
  "run.created",
  "session.entry",
  "task.started",
  "progress.commentary",
  "steering.received",
  "voice.command_received",
  "artifact.created",
  "evaluator.completed",
  "repair.requested",
  "checkpoint.created",
  "subagent.completed",
  "run.completed",
] as const;

export type RuntimeEventType = typeof RUNTIME_EVENT_TYPES[number];

export type RuntimeEventInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  eventType: RuntimeEventType;
  actorType: string;
  payload: unknown;
};

export function appendRuntimeEvent(db: SouthstarDb, input: RuntimeEventInput): { id: string; sequence: number; createdAt: string } {
  return appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: input.eventType,
    actorType: input.actorType,
    payload: input.payload,
  });
}
