import type { SouthstarDb } from "../stores/sqlite.ts";
import type { ServerSentRunEvent } from "./types.ts";

export function readRunEventsSince(db: SouthstarDb, input: { runId: string; afterSequence: number }): ServerSentRunEvent[] {
  const rows = db.prepare(`
    select id, sequence, event_type, payload_json, created_at
    from workflow_history
    where run_id = ? and sequence > ?
    order by sequence
  `).all(input.runId, input.afterSequence) as Array<{
    id: string;
    sequence: number;
    event_type: string;
    payload_json: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  }));
}

export function toSseFrame(event: ServerSentRunEvent): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.eventType}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}
