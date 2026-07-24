import { createPostgresSessionStore } from "../session/postgres-session-store.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

type WorkflowHistorySessionRow = {
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
  created_at: Date | string;
};

type RuntimeResourceSessionRow = {
  id: string;
  resource_type: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  scope: string;
  status: string;
  title: string | null;
  payload_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

const DEFAULT_SESSION_EVENT_LIMIT = 100;
const MAX_SESSION_EVENT_LIMIT = 500;
const MAX_SESSION_EVENT_WINDOW = 100;
const SESSION_LINEAGE_RESOURCE_TYPES = [
  "session",
  "session_checkpoint",
  "session_fork",
  "session_reset",
  "session_rollback",
  "rollback_marker",
] as const;
const LINEAGE_LINK_FIELDS = [
  "parentSessionId",
  "childSessionId",
  "previousRootSessionId",
  "newRootSessionId",
  "checkpointId",
  "rollbackMarkerRef",
  "markerRef",
] as const;

export async function handleSessionRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const eventsMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/events$/);
  if (request.method === "GET" && eventsMatch) {
    const sessionId = decodeURIComponent(eventsMatch[1]!);
    const events = await readSessionTimelineEvents(context, sessionId, url);
    return json("session-events", { sessionId, events });
  }

  const checkpointsMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/checkpoints$/);
  if (request.method === "GET" && checkpointsMatch) {
    const sessionId = decodeURIComponent(checkpointsMatch[1]!);
    const rows = await context.db.query<RuntimeResourceSessionRow>(
      `select id, resource_type, resource_key, run_id, task_id, session_id, scope, status, title,
              payload_json, created_at, updated_at
         from southstar.runtime_resources
        where resource_type = 'session_checkpoint'
          and session_id = $1
        order by created_at, resource_key`,
      [sessionId],
    );
    return json("session-checkpoints", {
      sessionId,
      checkpoints: rows.rows.map(checkpointSummary),
    });
  }

  const checkpointMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/checkpoints\/([^/]+)$/);
  if (request.method === "GET" && checkpointMatch) {
    const sessionId = decodeURIComponent(checkpointMatch[1]!);
    const checkpointId = decodeURIComponent(checkpointMatch[2]!);
    const checkpoint = await createPostgresSessionStore(context.db).getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.sessionId !== sessionId) throw new Error(`checkpoint not found: ${checkpointId}`);
    return json("session-checkpoint", { sessionId, checkpoint });
  }

  const lineageMatch = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/lineage$/);
  if (request.method === "GET" && lineageMatch) {
    const sessionId = decodeURIComponent(lineageMatch[1]!);
    const rows = await context.db.query<RuntimeResourceSessionRow>(
      `with linked as (
         select payload_json->>'rollbackMarkerRef' as resource_key
           from southstar.runtime_resources
          where resource_type = any($2::text[])
            and (
              session_id = $1
              or payload_json->>'parentSessionId' = $1
              or payload_json->>'childSessionId' = $1
              or payload_json->>'previousRootSessionId' = $1
              or payload_json->>'newRootSessionId' = $1
            )
         union
         select payload_json->>'checkpointId' as resource_key
           from southstar.runtime_resources
          where resource_type = any($2::text[])
            and (
              session_id = $1
              or payload_json->>'parentSessionId' = $1
              or payload_json->>'childSessionId' = $1
              or payload_json->>'previousRootSessionId' = $1
              or payload_json->>'newRootSessionId' = $1
            )
       )
       select id, resource_type, resource_key, run_id, task_id, session_id, scope, status, title,
              payload_json, created_at, updated_at
         from southstar.runtime_resources
        where resource_type = any($2::text[])
          and (
            session_id = $1
            or payload_json->>'parentSessionId' = $1
            or payload_json->>'childSessionId' = $1
            or payload_json->>'previousRootSessionId' = $1
            or payload_json->>'newRootSessionId' = $1
            or resource_key in (select resource_key from linked where resource_key is not null)
            or id in (select resource_key from linked where resource_key is not null)
          )
        order by created_at, resource_type, resource_key`,
      [sessionId, SESSION_LINEAGE_RESOURCE_TYPES],
    );
    return json("session-lineage", {
      sessionId,
      runIds: uniqueStrings(rows.rows.map((row) => row.run_id)),
      resources: rows.rows.map(lineageResource),
    });
  }

  return undefined;
}

async function readSessionTimelineEvents(context: RuntimeServerContext, sessionId: string, url: URL) {
  const aroundEventId = optionalString(url.searchParams.get("aroundEventId"));
  const windowBefore = parseOptionalSafeInteger(url.searchParams.get("windowBefore"), "windowBefore", { min: 0, max: MAX_SESSION_EVENT_WINDOW }) ?? 0;
  const windowAfter = parseOptionalSafeInteger(url.searchParams.get("windowAfter"), "windowAfter", { min: 0, max: MAX_SESSION_EVENT_WINDOW }) ?? 0;
  const anchorRange = aroundEventId ? await eventWindowForAnchor(context, sessionId, aroundEventId, windowBefore, windowAfter) : undefined;
  if (aroundEventId && !anchorRange) return [];

  const filters: string[] = ["session_id = $1"];
  const params: unknown[] = [sessionId];
  addOptionalNumberFilter(filters, params, "sequence >", parseOptionalSafeInteger(url.searchParams.get("afterSequence"), "afterSequence", { min: 0 }));
  addOptionalNumberFilter(filters, params, "sequence <", parseOptionalSafeInteger(url.searchParams.get("beforeSequence"), "beforeSequence", { min: 0 }));
  if (anchorRange) {
    addOptionalNumberFilter(filters, params, "sequence >=", anchorRange.fromSequence);
    addOptionalNumberFilter(filters, params, "sequence <=", anchorRange.toSequence);
  }
  const eventTypes = optionalStringList(url.searchParams.get("eventTypes"));
  if (eventTypes?.length) {
    params.push(eventTypes);
    filters.push(`event_type = any($${params.length}::text[])`);
  }
  const taskId = optionalString(url.searchParams.get("taskId"));
  if (taskId) {
    params.push(taskId);
    filters.push(`task_id = $${params.length}`);
  }
  const correlationId = optionalString(url.searchParams.get("correlationId"));
  if (correlationId) {
    params.push(correlationId);
    filters.push(`correlation_id = $${params.length}`);
  }
  const artifactRef = optionalString(url.searchParams.get("artifactRef"));
  if (artifactRef) {
    params.push(artifactRef);
    filters.push(artifactRefPredicate(params.length));
  }

  const limit = parseOptionalSafeInteger(url.searchParams.get("limit"), "limit", { min: 1, max: MAX_SESSION_EVENT_LIMIT }) ?? DEFAULT_SESSION_EVENT_LIMIT;
  params.push(limit);
  const rows = await context.db.query<WorkflowHistorySessionRow>(
    `select id, run_id, task_id, sequence, event_type, actor_type, session_id,
            idempotency_key, correlation_id, causation_id, payload_json, created_at
       from southstar.workflow_history
      where ${filters.join(" and ")}
      order by sequence
      limit $${params.length}`,
    params,
  );
  return rows.rows.map(sessionTimelineEvent);
}

async function eventWindowForAnchor(
  context: RuntimeServerContext,
  sessionId: string,
  aroundEventId: string,
  windowBefore: number,
  windowAfter: number,
): Promise<{ fromSequence: number; toSequence: number } | undefined> {
  const anchor = await context.db.maybeOne<{ sequence: number }>(
    "select sequence from southstar.workflow_history where session_id = $1 and id = $2",
    [sessionId, aroundEventId],
  );
  if (!anchor) return undefined;
  return {
    fromSequence: anchor.sequence - windowBefore,
    toSequence: anchor.sequence + windowAfter,
  };
}

function sessionTimelineEvent(row: WorkflowHistorySessionRow) {
  return {
    id: row.id,
    sequence: row.sequence,
    eventType: row.event_type,
    actorType: row.actor_type,
    runId: row.run_id,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    causationId: row.causation_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    payload: row.payload_json,
    createdAt: dateString(row.created_at),
  };
}

function checkpointSummary(row: RuntimeResourceSessionRow) {
  const payload = asRecord(row.payload_json);
  return {
    id: stringValue(payload.id) ?? row.id,
    resourceKey: row.resource_key,
    runId: row.run_id ?? stringValue(payload.runId),
    taskId: row.task_id ?? stringValue(payload.taskId),
    sessionId: row.session_id ?? stringValue(payload.sessionId),
    checkpointType: stringValue(payload.checkpointType),
    summary: stringValue(payload.summary) ?? row.title ?? "",
    eventRange: recordValue(payload.eventRange),
    refs: recordValue(payload.refs) ?? {},
    status: row.status,
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
  };
}

function lineageResource(row: RuntimeResourceSessionRow) {
  return {
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    runId: row.run_id ?? undefined,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    scope: row.scope,
    status: row.status,
    title: row.title ?? undefined,
    links: resourceLinks(row.payload_json),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
  };
}

function resourceLinks(payload: unknown): Record<string, string | string[]> {
  const record = asRecord(payload);
  const links: Record<string, string | string[]> = {};
  for (const field of LINEAGE_LINK_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) links[field] = value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) links[field] = value;
  }
  return links;
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

function addOptionalNumberFilter(filters: string[], params: unknown[], expression: string, value: number | undefined): void {
  if (value === undefined) return;
  params.push(value);
  filters.push(`${expression} $${params.length}`);
}

function parseOptionalSafeInteger(value: string | null, name: string, input: { min: number; max?: number }): number | undefined {
  if (value === null || value.length === 0) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(integerError(name, input));
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < input.min || (input.max !== undefined && parsed > input.max)) {
    throw new Error(integerError(name, input));
  }
  return parsed;
}

function integerError(name: string, input: { min: number; max?: number }): string {
  return input.max === undefined
    ? `${name} must be a safe integer greater than or equal to ${input.min}`
    : `${name} must be a safe integer between ${input.min} and ${input.max}`;
}

function optionalString(value: string | null): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function optionalStringList(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return recordValue(value) ?? {};
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
