import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { ContextMemoryCandidate, ContextMemorySearchInput } from "./provider.ts";

type MemoryLifecycle = "run-local" | "pending_approval" | "approved";

export type WriteRunLocalMemoryInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  scope: string;
  kind: string;
  text: string;
  tags?: string[];
  sourceRefs?: string[];
  confidence?: number;
  successScore?: number;
};

export type CreateMemoryDeltaInput = WriteRunLocalMemoryInput;

export type ApproveMemoryDeltaInput = {
  deltaId: string;
  approvedBy: string;
  reason: string;
};

export type InvalidateRunLocalMemoryInput = {
  runId: string;
  sourceRefs: string[];
  reason: string;
};

type MemoryPayload = {
  lifecycle: MemoryLifecycle;
  kind: string;
  text: string;
  tags: string[];
  sourceRefs: string[];
  confidence: number;
  successScore: number;
  sourceRunId?: string;
  sourceTaskId?: string;
  sourceSessionId?: string;
  approvedBy?: string;
  approvedAt?: string;
  approvalReason?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
};

type MemoryResourceRow = {
  id: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  scope: string;
  status: string;
  payload_json: unknown;
  created_at: Date | string;
};

export async function writeRunLocalMemoryPg(db: SouthstarDb, input: WriteRunLocalMemoryInput): Promise<{ id: string }> {
  const payload = memoryPayload(input, "run-local");
  const id = memoryResourceId("run-local", input.runId, input.scope, input.kind, input.text, payload.sourceRefs);
  const result = await upsertRuntimeResourcePg(db, {
    id,
    resourceType: "memory_item",
    resourceKey: id,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: input.scope,
    status: "active",
    title: input.kind,
    payload,
    summary: { text: input.text, tags: payload.tags, sourceRefs: payload.sourceRefs },
    metrics: { confidence: payload.confidence, successScore: payload.successScore },
  });
  await appendMemoryHistory(db, input.runId, input.taskId, input.sessionId, "memory.run_local_written", id, payload);
  return result;
}

export async function createMemoryDeltaPg(db: SouthstarDb, input: CreateMemoryDeltaInput): Promise<{ id: string }> {
  const payload = memoryPayload(input, "pending_approval");
  const id = memoryResourceId("delta", input.runId, input.scope, input.kind, input.text, payload.sourceRefs);
  const result = await upsertRuntimeResourcePg(db, {
    id,
    resourceType: "memory_delta",
    resourceKey: id,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: input.scope,
    status: "pending_approval",
    title: input.kind,
    payload,
    summary: { text: input.text, tags: payload.tags, sourceRefs: payload.sourceRefs },
    metrics: { confidence: payload.confidence, successScore: payload.successScore },
  });
  await appendMemoryHistory(db, input.runId, input.taskId, input.sessionId, "memory.delta_created", id, payload);
  return result;
}

export async function approveMemoryDeltaPg(db: SouthstarDb, input: ApproveMemoryDeltaInput): Promise<{ deltaId: string; memoryItemId: string }> {
  return await db.tx(async (tx) => {
    const delta = await tx.maybeOne<MemoryResourceRow>(
      "select * from southstar.runtime_resources where resource_type = 'memory_delta' and id = $1 for update",
      [input.deltaId],
    );
    if (!delta) throw new Error(`memory delta not found: ${input.deltaId}`);
    if (delta.status !== "pending_approval" && delta.status !== "approved") throw new Error(`memory delta is not approvable: ${delta.status}`);

    const deltaPayload = parseMemoryPayload(delta.payload_json);
    if (delta.status === "approved") {
      const approvedMemoryItemId = stringValue(objectPayload(delta.payload_json).approvedMemoryItemId)
        ?? memoryResourceId("approved", delta.scope, deltaPayload.kind, deltaPayload.text, deltaPayload.sourceRefs);
      return { deltaId: input.deltaId, memoryItemId: approvedMemoryItemId };
    }

    const now = new Date().toISOString();
    const approvedPayload: MemoryPayload = {
      ...deltaPayload,
      lifecycle: "approved",
      sourceRunId: deltaPayload.sourceRunId ?? delta.run_id ?? undefined,
      sourceTaskId: deltaPayload.sourceTaskId ?? delta.task_id ?? undefined,
      sourceSessionId: deltaPayload.sourceSessionId ?? delta.session_id ?? undefined,
      approvedBy: input.approvedBy,
      approvedAt: now,
      approvalReason: input.reason,
    };
    const memoryItemId = memoryResourceId("approved", delta.scope, approvedPayload.kind, approvedPayload.text, approvedPayload.sourceRefs);

    await upsertRuntimeResourcePg(tx, {
      id: memoryItemId,
      resourceType: "memory_item",
      resourceKey: memoryItemId,
      runId: delta.run_id ?? undefined,
      taskId: delta.task_id ?? undefined,
      sessionId: delta.session_id ?? undefined,
      scope: delta.scope,
      status: "approved",
      title: approvedPayload.kind,
      payload: approvedPayload,
      summary: { text: approvedPayload.text, tags: approvedPayload.tags, sourceRefs: approvedPayload.sourceRefs },
      metrics: { confidence: approvedPayload.confidence, successScore: approvedPayload.successScore },
    });

    await tx.query(
      `update southstar.runtime_resources
       set status = 'approved',
           payload_json = $1::jsonb,
           updated_at = now()
       where id = $2 and resource_type = 'memory_delta'`,
      [JSON.stringify({ ...deltaPayload, approvedMemoryItemId: memoryItemId, approvedBy: input.approvedBy, approvedAt: now, approvalReason: input.reason }), input.deltaId],
    );
    await appendMemoryHistory(tx, delta.run_id ?? "global", delta.task_id ?? undefined, delta.session_id ?? undefined, "memory.delta_approved", input.deltaId, {
      memoryItemId,
      approvedBy: input.approvedBy,
      reason: input.reason,
    });
    return { deltaId: input.deltaId, memoryItemId };
  });
}

export async function invalidateRunLocalMemoryPg(db: SouthstarDb, input: InvalidateRunLocalMemoryInput): Promise<{ invalidatedIds: string[] }> {
  if (input.sourceRefs.length === 0) return { invalidatedIds: [] };
  return await db.tx(async (tx) => {
    const rows = (
      await tx.query<MemoryResourceRow>(
        `select * from southstar.runtime_resources
         where resource_type = 'memory_item'
           and run_id = $1
           and status = 'active'
         order by created_at, resource_key
         for update`,
        [input.runId],
      )
    ).rows.filter((row) => {
      const payload = parseMemoryPayload(row.payload_json);
      return payload.lifecycle === "run-local" && payload.sourceRefs.some((sourceRef) => input.sourceRefs.includes(sourceRef));
    });

    const now = new Date().toISOString();
    for (const row of rows) {
      const payload = parseMemoryPayload(row.payload_json);
      await tx.query(
        `update southstar.runtime_resources
         set status = 'invalidated',
             payload_json = $1::jsonb,
             updated_at = now()
         where id = $2 and resource_type = 'memory_item'`,
        [JSON.stringify({ ...payload, invalidatedAt: now, invalidationReason: input.reason }), row.id],
      );
      await appendMemoryHistory(tx, input.runId, row.task_id ?? undefined, row.session_id ?? undefined, "memory.run_local_invalidated", row.id, {
        sourceRefs: input.sourceRefs,
        reason: input.reason,
      });
    }
    return { invalidatedIds: rows.map((row) => row.id) };
  });
}

export async function searchMemoryForContextPg(db: SouthstarDb, input: ContextMemorySearchInput): Promise<ContextMemoryCandidate[]> {
  if (input.scopes.length === 0 || input.allowedKinds.length === 0) return [];
  const rows = (
    await db.query<MemoryResourceRow>(
      `select * from southstar.runtime_resources
       where resource_type = 'memory_item'
         and scope = any($1::text[])
         and (
           (status = 'active' and run_id = $2)
           or status = 'approved'
         )
       order by created_at, resource_key`,
      [input.scopes, input.runId],
    )
  ).rows;
  const allowedKinds = new Set(input.allowedKinds);
  return rows
    .map((row) => toCandidate(row, input.query))
    .filter((candidate): candidate is ContextMemoryCandidate => Boolean(candidate) && allowedKinds.has(candidate.kind) && candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, input.maxCandidates));
}

function memoryPayload(input: WriteRunLocalMemoryInput, lifecycle: MemoryLifecycle): MemoryPayload {
  return {
    lifecycle,
    kind: input.kind,
    text: input.text,
    tags: [...(input.tags ?? [])],
    sourceRefs: [...(input.sourceRefs ?? [])],
    confidence: input.confidence ?? 1,
    successScore: input.successScore ?? 0,
    sourceRunId: input.runId,
    sourceTaskId: input.taskId,
    sourceSessionId: input.sessionId,
  };
}

async function appendMemoryHistory(
  db: SouthstarDb,
  runId: string,
  taskId: string | undefined,
  sessionId: string | undefined,
  eventType: string,
  resourceId: string,
  payload: unknown,
): Promise<void> {
  await appendHistoryEventPg(db, {
    runId,
    taskId,
    sessionId,
    eventType,
    actorType: "memory-service",
    idempotencyKey: `${eventType}:${resourceId}`,
    payload: { resourceId, ...objectPayload(payload) },
  });
}

function toCandidate(row: MemoryResourceRow, query: string): ContextMemoryCandidate | null {
  const payload = parseMemoryPayload(row.payload_json);
  if (payload.lifecycle === "run-local" && row.status !== "active") return null;
  if (payload.lifecycle === "approved" && row.status !== "approved") return null;
  const score = scoreMemory(query, payload);
  return {
    id: row.id,
    scope: row.scope,
    kind: payload.kind,
    text: payload.text,
    tags: payload.tags,
    sourceRefs: payload.sourceRefs,
    status: row.status === "approved" ? "approved" : "active",
    runId: row.run_id ?? undefined,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    score,
    confidence: payload.confidence,
    successScore: payload.successScore,
    tokenEstimate: Math.ceil(payload.text.length / 4),
    sourceRef: `memory_item:${row.id}`,
  };
}

function scoreMemory(query: string, payload: MemoryPayload): number {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return 0;
  const haystack = terms(`${payload.text} ${payload.tags.join(" ")}`);
  const matched = queryTerms.filter((term) => haystack.includes(term)).length;
  if (matched === 0) return 0;
  return matched / queryTerms.length + payload.confidence * 0.1 + payload.successScore * 0.05;
}

function terms(value: string): string[] {
  return Array.from(new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []));
}

function parseMemoryPayload(value: unknown): MemoryPayload {
  const payload = objectPayload(value);
  return {
    lifecycle: payload.lifecycle === "approved" ? "approved" : payload.lifecycle === "pending_approval" ? "pending_approval" : "run-local",
    kind: typeof payload.kind === "string" ? payload.kind : "memory",
    text: typeof payload.text === "string" ? payload.text : "",
    tags: stringArray(payload.tags),
    sourceRefs: stringArray(payload.sourceRefs),
    confidence: numberValue(payload.confidence, 1),
    successScore: numberValue(payload.successScore, 0),
    sourceRunId: stringValue(payload.sourceRunId),
    sourceTaskId: stringValue(payload.sourceTaskId),
    sourceSessionId: stringValue(payload.sourceSessionId),
    approvedBy: stringValue(payload.approvedBy),
    approvedAt: stringValue(payload.approvedAt),
    approvalReason: stringValue(payload.approvalReason),
    invalidatedAt: stringValue(payload.invalidatedAt),
    invalidationReason: stringValue(payload.invalidationReason),
  };
}

function memoryResourceId(...parts: unknown[]): string {
  return `memory-${sha256(parts).slice(0, 24)}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
