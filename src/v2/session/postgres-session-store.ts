import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { assertManagedAgentSessionEventType } from "../meta-harness/taxonomy.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { CheckpointInput, EventSliceQuery, SessionCheckpoint, SessionEvent, SessionStore } from "./types.ts";

type WorkflowHistoryRow = {
  id: string;
  run_id: string;
  task_id: string | null;
  sequence: number;
  event_type: string;
  actor_type: string;
  session_id: string | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  payload_json: unknown;
};

type RuntimeResourceRow = {
  id: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  payload_json: unknown;
  metrics_json: unknown;
  created_at: Date | string;
};

const SESSION_ACTOR_TYPES = ["operator", "orchestrator", "brain", "hand", "evaluator", "tool-proxy"] as const;

export function createPostgresSessionStore(db: SouthstarDb): SessionStore {
  return {
    async emitEvent(event) {
      const appended = await appendHistoryEventPg(db, {
        runId: event.runId,
        taskId: event.taskId,
        eventType: event.eventType,
        actorType: event.actorType,
        sessionId: event.sessionId,
        idempotencyKey: event.idempotencyKey,
        correlationId: event.correlationId,
        causationId: event.causationId,
        payload: event.payload,
      });
      return {
        id: appended.id,
        sessionId: event.sessionId,
        runId: event.runId,
        sequence: appended.sequence,
      };
    },

    async getEvents(sessionId, query) {
      const anchorRange = query.aroundEventId
        ? await eventWindowForAnchor(db, sessionId, query)
        : null;
      if (query.aroundEventId && !anchorRange) return [];

      const filters: string[] = ["session_id = $1"];
      const params: unknown[] = [sessionId];
      addOptionalNumberFilter(filters, params, "sequence >", query.afterSequence);
      addOptionalNumberFilter(filters, params, "sequence <", query.beforeSequence);
      if (anchorRange) {
        addOptionalNumberFilter(filters, params, "sequence >=", anchorRange.fromSequence);
        addOptionalNumberFilter(filters, params, "sequence <=", anchorRange.toSequence);
      }
      if (query.eventTypes?.length) {
        params.push(query.eventTypes);
        filters.push(`event_type = any($${params.length}::text[])`);
      }
      if (query.taskId) {
        params.push(query.taskId);
        filters.push(`task_id = $${params.length}`);
      }
      if (query.correlationId) {
        params.push(query.correlationId);
        filters.push(`correlation_id = $${params.length}`);
      }
      if (query.artifactRef) {
        params.push(query.artifactRef);
        filters.push(artifactRefPredicate(params.length));
      }

      const limit = query.limit && query.limit > 0 ? query.limit : undefined;
      if (limit) params.push(limit);
      const rows = await db.query<WorkflowHistoryRow>(
        `select id, run_id, task_id, sequence, event_type, actor_type, session_id,
                idempotency_key, correlation_id, causation_id, payload_json
           from southstar.workflow_history
          where ${filters.join(" and ")}
          order by sequence
          ${limit ? `limit $${params.length}` : ""}`,
        params,
      );
      return rows.rows.map(mapSessionEvent);
    },

    async createCheckpoint(input) {
      return await db.tx(async (tx) => {
        const resourceKey = input.resourceKey ?? input.id ?? randomUUID();
        const existing = await loadCheckpointRow(tx, resourceKey);
        const id = existing?.id ?? input.id ?? resourceKey;
        const payload = {
          id,
          resourceKey,
          checkpointType: input.checkpointType,
          summary: input.summary,
          eventRange: input.eventRange,
          refs: input.refs,
        };
        await upsertRuntimeResourcePg(tx, {
          id,
          resourceType: "session_checkpoint",
          resourceKey,
          runId: input.runId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          scope: "session",
          status: "created",
          title: input.summary,
          payload,
          metrics: input.metrics,
        });
        const row = await loadCheckpointRow(tx, id);
        if (!row) throw new Error(`failed to load session checkpoint after create: ${id}`);
        const checkpoint = mapCheckpoint(row);
        await appendIdempotentCheckpointHistoryEvent(tx, {
          runId: input.runId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          idempotencyKey: `checkpoint:${resourceKey}`,
          payload: {
            checkpointId: checkpoint.id,
            checkpointResourceKey: resourceKey,
            checkpointType: checkpoint.checkpointType,
            eventRange: checkpoint.eventRange,
            refs: checkpoint.refs,
          },
        });
        return checkpoint;
      });
    },

    async getCheckpoint(checkpointId) {
      const row = await loadCheckpointRow(db, checkpointId);
      return row ? mapCheckpoint(row) : null;
    },
  };
}

function artifactRefPredicate(paramIndex: number): string {
  return `(
    payload_json @> jsonb_build_object('artifactRef', $${paramIndex}::text)
    or payload_json @> jsonb_build_object('artifactRefs', jsonb_build_array($${paramIndex}::text))
    or payload_json @> jsonb_build_object('artifact', jsonb_build_object('ref', $${paramIndex}::text))
    or payload_json @> jsonb_build_object('artifact', jsonb_build_object('id', $${paramIndex}::text))
    or exists (
      select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(payload_json->'artifacts') = 'array' then payload_json->'artifacts'
            else '[]'::jsonb
          end
        ) elem
       where elem @> jsonb_build_object('ref', $${paramIndex}::text)
          or elem @> jsonb_build_object('id', $${paramIndex}::text)
    )
  )`;
}

async function appendIdempotentCheckpointHistoryEvent(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId?: string;
    sessionId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<{ id: string; sequence: number; createdAt: string }> {
  const existing = await db.maybeOne<{ id: string; sequence: number; created_at: Date | string }>(
    "select id, sequence, created_at from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, input.idempotencyKey],
  );
  if (existing) return { id: existing.id, sequence: existing.sequence, createdAt: dateString(existing.created_at) };

  await db.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
  const next = await db.one<{ next_sequence: number }>(
    "select coalesce(max(sequence), 0) + 1 as next_sequence from southstar.workflow_history where run_id = $1",
    [input.runId],
  );
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.query(
    `insert into southstar.workflow_history (
      id, run_id, task_id, sequence, event_type, actor_type, session_id,
      idempotency_key, correlation_id, causation_id, payload_json, created_at
    ) values ($1, $2, $3, $4, 'checkpoint.created', 'orchestrator', $5, $6, null, null, $7::jsonb, $8)
    on conflict do nothing`,
    [
      id,
      input.runId,
      input.taskId ?? null,
      next.next_sequence,
      input.sessionId,
      input.idempotencyKey,
      JSON.stringify(input.payload),
      createdAt,
    ],
  );
  const row = await db.one<{ id: string; sequence: number; created_at: Date | string }>(
    "select id, sequence, created_at from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, input.idempotencyKey],
  );
  return { id: row.id, sequence: row.sequence, createdAt: dateString(row.created_at) };
}

async function eventWindowForAnchor(
  db: SouthstarDb,
  sessionId: string,
  query: EventSliceQuery,
): Promise<{ fromSequence: number; toSequence: number } | null> {
  const anchor = await db.maybeOne<{ sequence: number }>(
    "select sequence from southstar.workflow_history where session_id = $1 and id = $2",
    [sessionId, query.aroundEventId],
  );
  if (!anchor) return null;
  return {
    fromSequence: anchor.sequence - (query.windowBefore ?? 0),
    toSequence: anchor.sequence + (query.windowAfter ?? 0),
  };
}

function addOptionalNumberFilter(filters: string[], params: unknown[], expression: string, value: number | undefined): void {
  if (value === undefined) return;
  params.push(value);
  filters.push(`${expression} $${params.length}`);
}

async function loadCheckpointRow(db: SouthstarDb, checkpointId: string): Promise<RuntimeResourceRow | null> {
  return await db.maybeOne<RuntimeResourceRow>(
    `select id, resource_key, run_id, task_id, session_id, payload_json, metrics_json, created_at
       from southstar.runtime_resources
      where resource_type = 'session_checkpoint'
        and (id = $1 or resource_key = $1)`,
    [checkpointId],
  );
}

function mapSessionEvent(row: WorkflowHistoryRow): SessionEvent {
  if (!row.session_id) {
    throw new Error(`workflow history event ${row.id} is missing session_id`);
  }
  return {
    eventType: assertManagedAgentSessionEventType(row.event_type),
    actorType: assertSessionActorType(row.actor_type, row.id),
    runId: row.run_id,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id,
    correlationId: row.correlation_id ?? undefined,
    causationId: row.causation_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    payload: asRecord(row.payload_json, `workflow history event ${row.id} payload_json`),
  };
}

function mapCheckpoint(row: RuntimeResourceRow): SessionCheckpoint {
  const payload = asRecord(row.payload_json, `session checkpoint ${row.id} payload_json`);
  return {
    id: stringField(payload, "id", row.id),
    runId: row.run_id ?? stringField(payload, "runId"),
    taskId: row.task_id ?? optionalStringField(payload, "taskId"),
    sessionId: row.session_id ?? stringField(payload, "sessionId"),
    checkpointType: checkpointTypeField(payload, "checkpointType"),
    summary: stringField(payload, "summary"),
    eventRange: eventRangeField(payload.eventRange, row.id),
    refs: refsField(payload.refs, row.id),
    metrics: asRecord(row.metrics_json, `session checkpoint ${row.id} metrics_json`),
    createdAt: dateString(row.created_at),
  };
}

function assertSessionActorType(value: string, eventId: string): SessionEvent["actorType"] {
  if (SESSION_ACTOR_TYPES.includes(value as SessionEvent["actorType"])) {
    return value as SessionEvent["actorType"];
  }
  throw new Error(`workflow history event ${eventId} has unsupported managed session actor_type: ${value}`);
}

function checkpointTypeField(payload: Record<string, unknown>, key: string): SessionCheckpoint["checkpointType"] {
  const value = stringField(payload, key);
  if (value === "task-start" || value === "artifact-accepted" || value === "before-recovery" || value === "operator") {
    return value;
  }
  throw new Error(`session checkpoint has unsupported checkpointType: ${value}`);
}

function eventRangeField(value: unknown, checkpointId: string): SessionCheckpoint["eventRange"] {
  const record = asRecord(value, `session checkpoint ${checkpointId} eventRange`);
  if (typeof record.fromSequence !== "number" || typeof record.toSequence !== "number") {
    throw new Error(`session checkpoint ${checkpointId} has invalid eventRange`);
  }
  return { fromSequence: record.fromSequence, toSequence: record.toSequence };
}

function refsField(value: unknown, checkpointId: string): Record<string, string[]> {
  const record = asRecord(value, `session checkpoint ${checkpointId} refs`);
  const refs: Record<string, string[]> = {};
  for (const [key, refValue] of Object.entries(record)) {
    if (!Array.isArray(refValue) || !refValue.every((item) => typeof item === "string")) {
      throw new Error(`session checkpoint ${checkpointId} has invalid refs.${key}`);
    }
    refs[key] = refValue;
  }
  return refs;
}

function stringField(record: Record<string, unknown>, key: string, fallback?: string): string {
  const value = record[key] ?? fallback;
  if (typeof value !== "string" || value.length === 0) throw new Error(`expected string field: ${key}`);
  return value;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`expected optional string field: ${key}`);
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} must be an object`);
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
