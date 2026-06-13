import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type {
  MemoryCandidate,
  MemoryProvider,
  MemorySearchRequest,
  MemoryWriteRequest,
  MemoryWriteResult,
} from "./provider.ts";

export function createSqliteMemoryProvider(db: SouthstarDb): MemoryProvider {
  return {
    add(input: MemoryWriteRequest): MemoryWriteResult {
      const id = `mem-${randomUUID()}`;
      upsertRuntimeResource(db, {
        id,
        resourceType: "memory_item",
        resourceKey: id,
        runId: input.sourceRunId,
        scope: input.scope,
        status: "approved",
        title: input.kind,
        payload: input,
      });
      return { id };
    },

    search(input: MemorySearchRequest): MemoryCandidate[] {
      const scopes = [...new Set(input.scopes)];
      const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = scopes.flatMap((scope) => listResources(db, {
        resourceType: "memory_item",
        scope,
        status: "approved",
      }));
      return rows
        .map((row, index): MemoryCandidate => {
          const payload = asRecord(row.payload);
          const text = memoryText(payload, row.payload);
          const confidence = numberValue(payload.confidence, 0.6);
          const successScore = numberValue(payload.successScore, 0.5);
          const lexical = terms.filter((term) => text.toLowerCase().includes(term)).length;
          const recency = rows.length === 0 ? 0 : (index + 1) / rows.length;
          return {
            id: row.id,
            scope: row.scope,
            kind: stringValue(payload.kind, "artifact_summary"),
            text,
            score: lexical + confidence + successScore + recency,
            confidence,
            successScore,
            tokenEstimate: estimateTokens(text),
            sourceRef: row.resourceKey,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, input.maxCandidates));
    },
  };
}

function memoryText(payload: Record<string, unknown>, original: unknown): string {
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.preference === "string") return payload.preference;
  if (typeof payload.summary === "string") return payload.summary;
  return JSON.stringify(original);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
