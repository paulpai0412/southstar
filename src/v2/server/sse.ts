import type { SouthstarDb } from "../db/postgres.ts";

export const TERMINAL_RUNTIME_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export type RuntimeEventFrame = {
  sequence: number;
  eventType: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  actorType: string;
  payload: unknown;
  createdAt: string;
};

export async function readRunEventsSince(db: SouthstarDb, input: {
  runId: string;
  afterSequence?: number;
  taskId?: string;
  includeRunEvents?: boolean;
}): Promise<RuntimeEventFrame[]> {
  const includeRunEvents = input.includeRunEvents !== false;
  const rows = await db.query<{
    sequence: number;
    event_type: string;
    run_id: string;
    task_id: string | null;
    session_id: string | null;
    actor_type: string;
    payload_json: unknown;
    created_at: Date | string;
  }>(
    `select sequence, event_type, run_id, task_id, session_id, actor_type, payload_json, created_at
     from southstar.workflow_history
     where run_id = $1
       and sequence > $2
       and (
         $3::text is null
         or task_id = $3
         or ($4::boolean and task_id is null)
       )
     order by sequence`,
    [input.runId, input.afterSequence ?? 0, input.taskId ?? null, includeRunEvents],
  );
  return rows.rows.map((row) => ({
    sequence: row.sequence,
    eventType: row.event_type,
    runId: row.run_id,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    actorType: row.actor_type,
    payload: row.payload_json,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

export function toSseFrame(event: RuntimeEventFrame): string {
  return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function toSseHeartbeatFrame(createdAt = new Date().toISOString()): string {
  return `event: heartbeat\ndata: ${createdAt}\n\n`;
}

export function parseRuntimeEventSequence(value: string | null | undefined): number {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}
