import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventOncePg } from "../stores/postgres-runtime-store.ts";
import { createMemoryDeltaPg, writeRunLocalMemoryPg } from "./postgres-memory-service.ts";

export type CallbackMemoryWritebackInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  ok: boolean;
  artifact: unknown;
  artifactRefId: string;
  artifactResourceId: string;
};

export type CallbackMemoryWritebackResult = {
  artifactRefId: string;
  artifactResourceId: string;
  memoryItemIds: string[];
  memoryDeltaIds: string[];
};

type NormalizedCandidate = {
  scope: string;
  kind: string;
  text: string;
  tags: string[];
  sourceRefs: string[];
  confidence: number;
  successScore: number;
};

export async function writeCallbackMemoryPg(db: SouthstarDb, input: CallbackMemoryWritebackInput): Promise<CallbackMemoryWritebackResult> {
  const idempotencyKey = writebackIdempotencyKey(input.artifactRefId);
  const existing = await existingWritebackResultPg(db, input.runId, idempotencyKey);
  if (existing) return existing;

  const artifact = objectPayload(input.artifact);
  const sourceRefs = [input.artifactRefId];
  const memoryItemIds: string[] = [];
  const memoryDeltaIds: string[] = [];
  const summary = nonEmptyString(artifact.summary);

  if (summary) {
    const runLocal = await writeRunLocalMemoryPg(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: `run:${input.runId}`,
      kind: input.ok ? "artifact_summary" : "failure_summary",
      text: summary,
      tags: [input.ok ? "accepted-artifact" : "rejected-artifact"],
      sourceRefs,
      confidence: 1,
      successScore: input.ok ? 1 : 0,
    });
    memoryItemIds.push(runLocal.id);
  }

  for (const candidate of normalizedMemoryCandidates(artifact.memoryCandidates, sourceRefs)) {
    const delta = await createMemoryDeltaPg(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: candidate.scope,
      kind: candidate.kind,
      text: candidate.text,
      tags: candidate.tags,
      sourceRefs: candidate.sourceRefs,
      confidence: candidate.confidence,
      successScore: candidate.successScore,
    });
    memoryDeltaIds.push(delta.id);
  }

  const result = {
    artifactRefId: input.artifactRefId,
    artifactResourceId: input.artifactResourceId,
    memoryItemIds,
    memoryDeltaIds,
  };
  if (memoryItemIds.length > 0 || memoryDeltaIds.length > 0) {
    await appendWritebackRecordedOncePg(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      idempotencyKey,
      payload: result,
    });
  }
  return result;
}

function normalizedMemoryCandidates(value: unknown, requiredSourceRefs: string[]): NormalizedCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): NormalizedCandidate[] => {
    const record = objectPayload(candidate);
    const text = nonEmptyString(record.text);
    if (!text) return [];
    return [{
      scope: nonEmptyString(record.scope) ?? "general",
      kind: nonEmptyString(record.kind) ?? "workflow_learning",
      text,
      tags: stringArray(record.tags),
      sourceRefs: uniqueStrings([...requiredSourceRefs, ...stringArray(record.sourceRefs)]),
      confidence: finiteNumber(record.confidence) ?? 0.5,
      successScore: finiteNumber(record.successScore) ?? 0.5,
    }];
  });
}

async function existingWritebackResultPg(db: SouthstarDb, runId: string, idempotencyKey: string): Promise<CallbackMemoryWritebackResult | null> {
  const existing = await db.maybeOne<{ payload_json: unknown }>(
    "select payload_json from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [runId, idempotencyKey],
  );
  if (!existing) return null;
  const payload = objectPayload(existing.payload_json);
  return {
    artifactRefId: nonEmptyString(payload.artifactRefId) ?? "",
    artifactResourceId: nonEmptyString(payload.artifactResourceId) ?? "",
    memoryItemIds: stringArray(payload.memoryItemIds),
    memoryDeltaIds: stringArray(payload.memoryDeltaIds),
  };
}

async function appendWritebackRecordedOncePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    idempotencyKey: string;
    payload: CallbackMemoryWritebackResult;
  },
): Promise<void> {
  await appendHistoryEventOncePg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "memory.writeback_recorded",
    actorType: "memory-service",
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  });
}

function writebackIdempotencyKey(artifactRefId: string): string {
  return `${artifactRefId}:memory-writeback-recorded`;
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
