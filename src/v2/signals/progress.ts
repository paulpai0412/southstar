import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendRuntimeEvent } from "./events.ts";

export type ProgressCommentaryInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  message: string;
};

export function recordProgressCommentary(db: SouthstarDb, input: ProgressCommentaryInput) {
  return appendRuntimeEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "progress.commentary",
    actorType: "agent",
    payload: { message: input.message },
  });
}
