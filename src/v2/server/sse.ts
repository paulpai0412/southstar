import type { SouthstarDb } from "../db/postgres.ts";

export type RuntimeEventFrame = {
  sequence: number;
  eventType: string;
  taskId?: string;
  payload: unknown;
  createdAt: string;
};

export async function readRunEventsSince(db: SouthstarDb, input: { runId: string; afterSequence?: number }): Promise<RuntimeEventFrame[]> {
  const rows = await db.query<{ sequence: number; event_type: string; task_id: string | null; payload_json: unknown; created_at: Date | string }>(
    `select sequence, event_type, task_id, payload_json, created_at
     from southstar.workflow_history
     where run_id = $1 and sequence > $2
     order by sequence`,
    [input.runId, input.afterSequence ?? 0],
  );
  return rows.rows.map((row) => ({
    sequence: row.sequence,
    eventType: row.event_type,
    taskId: row.task_id ?? undefined,
    payload: row.payload_json,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

export function toSseFrame(event: RuntimeEventFrame): string {
  return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}
