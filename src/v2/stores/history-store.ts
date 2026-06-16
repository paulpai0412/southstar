import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "./sqlite.ts";

export type AppendHistoryInput = {
  runId: string;
  taskId?: string;
  eventType: string;
  actorType: string;
  sessionId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
  payload: unknown;
};

export type WorkflowHistoryEvent = {
  id: string;
  runId: string;
  taskId: string | null;
  sequence: number;
  eventType: string;
  actorType: string;
  sessionId: string | null;
  idempotencyKey: string | null;
  payload: unknown;
  createdAt: string;
};

export function appendHistoryEvent(db: SouthstarDb, input: AppendHistoryInput): { id: string; sequence: number; createdAt: string } {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const sequence = (db.prepare("select coalesce(max(sequence), 0) + 1 as next from workflow_history where run_id = ?")
      .get(input.runId) as { next: number }).next;
    try {
      db.prepare(`
        insert into workflow_history (
          id, run_id, task_id, sequence, event_type, actor_type, session_id,
          idempotency_key, correlation_id, causation_id, payload_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.runId,
        input.taskId ?? null,
        sequence,
        input.eventType,
        input.actorType,
        input.sessionId ?? null,
        input.idempotencyKey ?? null,
        input.correlationId ?? null,
        input.causationId ?? null,
        JSON.stringify(input.payload),
        now,
      );
      return { id, sequence, createdAt: now };
    } catch (error) {
      if (!isWorkflowSequenceConflict(error) || attempt === 2) throw error;
    }
  }

  throw new Error("appendHistoryEvent exhausted sequence retry attempts");
}

export function listHistoryForRun(db: SouthstarDb, runId: string): WorkflowHistoryEvent[] {
  return (db.prepare("select * from workflow_history where run_id = ? order by sequence").all(runId) as WorkflowHistoryRow[])
    .map(mapHistoryEvent);
}

export function listHistoryForTask(db: SouthstarDb, taskId: string): WorkflowHistoryEvent[] {
  return (db.prepare("select * from workflow_history where task_id = ? order by sequence").all(taskId) as WorkflowHistoryRow[])
    .map(mapHistoryEvent);
}

export function listHistoryForSession(db: SouthstarDb, sessionId: string): WorkflowHistoryEvent[] {
  return (db.prepare("select * from workflow_history where session_id = ? order by sequence").all(sessionId) as WorkflowHistoryRow[])
    .map(mapHistoryEvent);
}

type WorkflowHistoryRow = {
  id: string;
  run_id: string;
  task_id: string | null;
  sequence: number;
  event_type: string;
  actor_type: string;
  session_id: string | null;
  idempotency_key: string | null;
  payload_json: string;
  created_at: string;
};

function isWorkflowSequenceConflict(error: unknown): boolean {
  const message = String((error as Error)?.message ?? "");
  return /unique constraint/i.test(message)
    && message.includes("workflow_history.run_id, workflow_history.sequence");
}

function mapHistoryEvent(row: WorkflowHistoryRow): WorkflowHistoryEvent {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    sequence: row.sequence,
    eventType: row.event_type,
    actorType: row.actor_type,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}
