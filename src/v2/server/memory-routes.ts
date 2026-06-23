import {
  approveMemoryDeltaPg,
  invalidateRunLocalMemoryPg,
  listRunMemoryDeltasPg,
  rejectMemoryDeltaPg,
  searchMemoryForContextPg,
} from "../memory/postgres-memory-service.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

const DEFAULT_MEMORY_SEARCH_CANDIDATES = 10;
const MAX_MEMORY_SEARCH_CANDIDATES = 50;

export async function handleMemoryRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  const deltasMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/memory-deltas$/);
  if (request.method === "GET" && deltasMatch) {
    const runId = decodeURIComponent(deltasMatch[1]!);
    return json("memory-deltas", { runId, memoryDeltas: await listRunMemoryDeltasPg(context.db, runId) });
  }

  const approveMatch = url.pathname.match(/^\/api\/v2\/memory-deltas\/([^/]+)\/approve$/);
  if (request.method === "POST" && approveMatch) {
    const body = await readBody(request);
    return json("memory-delta-approve", await approveMemoryDeltaPg(context.db, {
      deltaId: decodeURIComponent(approveMatch[1]!),
      approvedBy: requiredString(body.approvedBy, "approvedBy"),
      reason: requiredString(body.reason, "reason"),
    }));
  }

  const rejectMatch = url.pathname.match(/^\/api\/v2\/memory-deltas\/([^/]+)\/reject$/);
  if (request.method === "POST" && rejectMatch) {
    const body = await readBody(request);
    return json("memory-delta-reject", await rejectMemoryDeltaPg(context.db, {
      deltaId: decodeURIComponent(rejectMatch[1]!),
      rejectedBy: requiredString(body.rejectedBy, "rejectedBy"),
      reason: requiredString(body.reason, "reason"),
    }));
  }

  const invalidateMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/memory\/invalidate$/);
  if (request.method === "POST" && invalidateMatch) {
    const body = await readBody(request);
    return json("memory-invalidate", await invalidateRunLocalMemoryPg(context.db, {
      runId: decodeURIComponent(invalidateMatch[1]!),
      sourceRefs: requiredStringArray(body.sourceRefs, "sourceRefs"),
      reason: requiredString(body.reason, "reason"),
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/v2/memory/search") {
    const runId = requiredQuery(url, "runId");
    const candidates = await searchMemoryForContextPg(context.db, {
      runId,
      query: requiredQuery(url, "query"),
      scopes: requiredQueryList(url, "scopes"),
      allowedKinds: requiredQueryList(url, "allowedKinds"),
      maxCandidates: optionalSafeInteger(url.searchParams.get("maxCandidates"), "maxCandidates", {
        min: 1,
        max: MAX_MEMORY_SEARCH_CANDIDATES,
        fallback: DEFAULT_MEMORY_SEARCH_CANDIDATES,
      }),
    });
    return json("memory-search", { runId, candidates });
  }

  return undefined;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json();
  if (!isRecord(body)) throw new Error("request body must be an object");
  return body;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${field} must be a non-empty array of strings`);
  }
  return value;
}

function requiredQuery(url: URL, field: string): string {
  const value = url.searchParams.get(field);
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function requiredQueryList(url: URL, field: string): string[] {
  const items = requiredQuery(url, field).split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`${field} is required`);
  return items;
}

function optionalSafeInteger(value: string | null, field: string, input: { min: number; max: number; fallback: number }): number {
  if (value === null || value.length === 0) return input.fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${field} must be a safe integer between ${input.min} and ${input.max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < input.min || parsed > input.max) {
    throw new Error(`${field} must be a safe integer between ${input.min} and ${input.max}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
