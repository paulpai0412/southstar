import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDeltaPg, writeRunLocalMemoryPg } from "../../src/v2/memory/postgres-memory-service.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg, listHistoryForRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("memory routes approve, reject, list, invalidate, and search memory with UI-safe DTOs", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-memory-api",
      status: "running",
      domain: "software",
      goalPrompt: "memory routes",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await writeRunLocalMemoryPg(db, {
      runId: "run-memory-api",
      taskId: "task-a",
      sessionId: "session-a",
      scope: "run:run-memory-api",
      kind: "implementation_preference",
      text: "Prefer minimal API changes.",
      tags: ["api"],
      sourceRefs: ["artifact:a"],
    });
    const approveDelta = await createMemoryDeltaPg(db, {
      runId: "run-memory-api",
      taskId: "task-a",
      sessionId: "session-a",
      scope: "software",
      kind: "implementation_preference",
      text: "Prefer deterministic command ids.",
      tags: ["deterministic"],
      sourceRefs: ["artifact:b"],
    });
    const rejectDelta = await createMemoryDeltaPg(db, {
      runId: "run-memory-api",
      taskId: "task-b",
      sessionId: "session-b",
      scope: "software",
      kind: "implementation_preference",
      text: "Reject noisy memory.",
      tags: ["noise"],
      sourceRefs: ["artifact:c"],
    });
    await upsertRuntimeResourcePg(db, {
      id: "memory-delta-primary-id",
      resourceType: "memory_delta",
      resourceKey: "memory-delta-resource-key",
      runId: "run-memory-api",
      taskId: "task-c",
      sessionId: "session-c",
      scope: "software",
      status: "pending_approval",
      title: "implementation_preference",
      payload: {
        lifecycle: "pending_approval",
        kind: "implementation_preference",
        text: "Prefer primary ids for memory decisions.",
        tags: ["identity"],
        sourceRefs: ["artifact:d"],
        confidence: 1,
        successScore: 0,
        sourceRunId: "run-memory-api",
        sourceTaskId: "task-c",
        sourceSessionId: "session-c",
      },
    });

    const approved = await call<{ deltaId: string; memoryItemId: string }>("POST", `/api/v2/memory-deltas/${encodeURIComponent(approveDelta.id)}/approve`, {
      approvedBy: "operator-a",
      reason: "useful across runs",
    });
    assert.equal(approved.kind, "memory-delta-approve");
    assert.equal(approved.result.deltaId, approveDelta.id);
    assert.equal(typeof approved.result.memoryItemId, "string");
    const approvedPayload = await db.one<{ status: string; payload_json: { lifecycle?: string; approvedMemoryItemId?: string } }>(
      "select status, payload_json from southstar.runtime_resources where id = $1 and resource_type = 'memory_delta'",
      [approveDelta.id],
    );
    assert.equal(approvedPayload.status, "approved");
    assert.equal(approvedPayload.payload_json.lifecycle, "approved");
    assert.equal(approvedPayload.payload_json.approvedMemoryItemId, approved.result.memoryItemId);

    const rejected = await call<{ deltaId: string; status: string }>("POST", `/api/v2/memory-deltas/${encodeURIComponent(rejectDelta.id)}/reject`, {
      rejectedBy: "operator-a",
      reason: "too noisy",
    });
    assert.equal(rejected.kind, "memory-delta-reject");
    assert.equal(rejected.result.deltaId, rejectDelta.id);
    assert.equal(rejected.result.status, "rejected");

    const listed = await call<{
      runId: string;
      memoryDeltas: Array<{
        id: string;
        resourceKey: string;
        taskId?: string;
        sessionId?: string;
        status: string;
        scope: string;
        kind: string;
        text: string;
        tags: string[];
        sourceRefs: string[];
        payload?: unknown;
        providerPayload?: unknown;
      }>;
    }>("GET", "/api/v2/runs/run-memory-api/memory-deltas");
    assert.equal(listed.kind, "memory-deltas");
    assert.equal(listed.result.runId, "run-memory-api");
    assert.equal(listed.result.memoryDeltas.some((item) => item.id === approveDelta.id && item.status === "approved"), true);
    assert.equal(listed.result.memoryDeltas.some((item) => item.id === rejectDelta.id && item.status === "rejected"), true);
    assert.equal(listed.result.memoryDeltas.some((item) => item.id === "memory-delta-primary-id" && item.resourceKey === "memory-delta-resource-key"), true);
    assert.equal(listed.result.memoryDeltas.every((item) => item.payload === undefined && item.providerPayload === undefined), true);
    assert.deepEqual(listed.result.memoryDeltas.find((item) => item.id === approveDelta.id)?.sourceRefs, ["artifact:b"]);

    const invalidated = await call<{ invalidatedIds: string[] }>("POST", "/api/v2/runs/run-memory-api/memory/invalidate", {
      sourceRefs: ["artifact:a"],
      reason: "source superseded",
    });
    assert.equal(invalidated.kind, "memory-invalidate");
    assert.equal(invalidated.result.invalidatedIds.length, 1);

    const searched = await call<{ runId: string; candidates: Array<{ text: string; kind: string; sourceRefs: string[]; score: number }> }>(
      "GET",
      "/api/v2/memory/search?runId=run-memory-api&query=deterministic&scopes=software&allowedKinds=implementation_preference&maxCandidates=5",
    );
    assert.equal(searched.kind, "memory-search");
    assert.equal(searched.result.runId, "run-memory-api");
    assert.equal(searched.result.candidates.some((item) => item.kind === "implementation_preference" && /deterministic/.test(item.text)), true);

    const invalidSearch = await route("GET", "/api/v2/memory/search?runId=run-memory-api&query=x&scopes=software&allowedKinds=implementation_preference&maxCandidates=100000");
    assert.equal(invalidSearch.status, 400);
    assert.match(await invalidSearch.text(), /maxCandidates must be a safe integer between 1 and 50/);

    const missingRejectReason = await route("POST", `/api/v2/memory-deltas/${encodeURIComponent(rejectDelta.id)}/reject`, { rejectedBy: "operator-a" });
    assert.equal(missingRejectReason.status, 400);
    assert.match(await missingRejectReason.text(), /reason is required/);

    const events = await listHistoryForRunPg(db, "run-memory-api");
    assert.equal(events.some((event) => event.eventType === "memory.delta_approved"), true);
    assert.equal(events.some((event) => event.eventType === "memory.delta_rejected"), true);
    assert.equal(events.some((event) => event.eventType === "memory.run_local_invalidated"), true);

    async function call<T>(method: string, path: string, body?: unknown): Promise<{ ok: true; kind: string; result: T }> {
      const envelope = await readEnvelope<T>(await route(method, path, body));
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }

    async function route(method: string, path: string, body?: unknown): Promise<Response> {
      return await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      }, new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
    }
  } finally {
    await db.close();
  }
});

test("runtime server client exposes memory decision API URLs", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, kind: "test", result: {} }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = createRuntimeServerClient({ baseUrl: "http://127.0.0.1/" });
    await client.listMemoryDeltas("run/a");
    await client.approveMemoryDelta({ deltaId: "delta/a", approvedBy: "operator-a", reason: "useful" });
    await client.rejectMemoryDelta({ deltaId: "delta/b", rejectedBy: "operator-a", reason: "noisy" });
    await client.invalidateRunMemory({ runId: "run/a", sourceRefs: ["artifact:a"], reason: "superseded" });
    await client.searchMemory({ runId: "run/a", query: "deterministic ids", scopes: ["software", "run:run/a"], allowedKinds: ["implementation_preference"], maxCandidates: 7 });

    assert.deepEqual(calls, [
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/memory-deltas", body: undefined },
      { url: "http://127.0.0.1/api/v2/memory-deltas/delta%2Fa/approve", body: { approvedBy: "operator-a", reason: "useful" } },
      { url: "http://127.0.0.1/api/v2/memory-deltas/delta%2Fb/reject", body: { rejectedBy: "operator-a", reason: "noisy" } },
      { url: "http://127.0.0.1/api/v2/runs/run%2Fa/memory/invalidate", body: { sourceRefs: ["artifact:a"], reason: "superseded" } },
      { url: "http://127.0.0.1/api/v2/memory/search?runId=run%2Fa&query=deterministic+ids&scopes=software%2Crun%3Arun%2Fa&allowedKinds=implementation_preference&maxCandidates=7", body: undefined },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function readEnvelope<T>(response: Response): Promise<{ ok: true; kind: string; result: T } | { ok: false; error: string }> {
  return await response.json() as { ok: true; kind: string; result: T } | { ok: false; error: string };
}
