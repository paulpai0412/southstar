import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { appendHistoryEventPg, createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("session routes expose filtered events, checkpoints, and lineage without mutating runtime fate", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-session-api",
      status: "running",
      domain: "software",
      goalPrompt: "inspect sessions",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId: "run-session-api",
      taskKey: "implement",
      status: "running",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-a",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "session",
      resourceKey: "session-a",
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      scope: "session",
      status: "active",
      payload: { parentSessionId: null },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "session_fork",
      resourceKey: "session-fork-a",
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      scope: "session",
      status: "created",
      payload: { parentSessionId: "session-root", childSessionId: "session-a" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "rollback_marker",
      resourceKey: "rollback_marker:session-api",
      runId: "run-session-api",
      taskId: "task-a",
      scope: "recovery",
      status: "recorded",
      title: "rollback marker",
      payload: { markerRef: "rollback_marker:session-api", secretProviderState: "do-not-expose" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "session_rollback",
      resourceKey: "session-rollback-a",
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-recovered",
      scope: "session",
      status: "applied",
      payload: {
        previousRootSessionId: "session-a",
        newRootSessionId: "session-recovered",
        rollbackMarkerRef: "rollback_marker:session-api",
        checkpointId: "checkpoint-row-a",
      },
    });

    const store = createPostgresSessionStore(db);
    await store.emitEvent({
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      eventType: "session.created",
      actorType: "orchestrator",
      payload: { reason: "test" },
    });
    const anchor = await store.emitEvent({
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      eventType: "artifact.created",
      actorType: "hand",
      correlationId: "corr-a",
      payload: { artifactRefs: ["artifact-a"] },
    });
    await store.emitEvent({
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      eventType: "artifact.accepted",
      actorType: "evaluator",
      correlationId: "corr-a",
      payload: { artifactRefs: ["artifact-a"] },
    });
    await store.emitEvent({
      runId: "run-session-api",
      taskId: "task-b",
      sessionId: "session-a",
      eventType: "artifact.rejected",
      actorType: "evaluator",
      correlationId: "corr-b",
      payload: { artifactRefs: ["artifact-b"] },
    });
    await appendHistoryEventPg(db, {
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      eventType: "progress.commentary",
      actorType: "subagent",
      correlationId: "corr-a",
      payload: { message: "real workflow event" },
    });
    const checkpoint = await store.createCheckpoint({
      id: "checkpoint-row-a",
      runId: "run-session-api",
      taskId: "task-a",
      sessionId: "session-a",
      resourceKey: "checkpoint-a",
      checkpointType: "task-start",
      summary: "Task start checkpoint",
      eventRange: { fromSequence: anchor.sequence, toSequence: anchor.sequence },
      refs: { eventIds: [anchor.id] },
    });

    const events = await call<{ sessionId: string; events: Array<{ id: string; sequence: number; eventType: string; taskId?: string; correlationId?: string; payload: unknown; createdAt: string }> }>(
      `/api/v2/sessions/session-a/events?afterSequence=0&limit=10&eventTypes=artifact.created,artifact.accepted&taskId=task-a&correlationId=corr-a&artifactRef=artifact-a`,
    );
    assert.equal(events.kind, "session-events");
    assert.equal(events.result.sessionId, "session-a");
    assert.deepEqual(events.result.events.map((event) => event.eventType), ["artifact.created", "artifact.accepted"]);
    assert.equal(events.result.events.every((event) => event.taskId === "task-a" && event.correlationId === "corr-a"), true);
    assert.equal(events.result.events.every((event) => event.id.length > 0 && Number.isSafeInteger(event.sequence) && event.createdAt.length > 0), true);

    const realWorkflowEvents = await call<{ events: Array<{ eventType: string; actorType: string; payload: unknown }> }>(
      "/api/v2/sessions/session-a/events?eventTypes=progress.commentary",
    );
    assert.deepEqual(realWorkflowEvents.result.events.map((event) => [event.eventType, event.actorType]), [["progress.commentary", "subagent"]]);

    const around = await call<{ events: Array<{ eventType: string }> }>(
      `/api/v2/sessions/session-a/events?aroundEventId=${encodeURIComponent(anchor.id)}&windowBefore=1&windowAfter=1`,
    );
    assert.deepEqual(around.result.events.map((event) => event.eventType), ["session.created", "artifact.created", "artifact.accepted"]);

    const checkpoints = await call<{ sessionId: string; checkpoints: Array<{ id: string; resourceKey: string; runId?: string; taskId?: string; status: string; summary: string }> }>(
      "/api/v2/sessions/session-a/checkpoints",
    );
    assert.equal(checkpoints.kind, "session-checkpoints");
    assert.deepEqual(checkpoints.result.checkpoints.map((item) => item.id), [checkpoint.id]);
    assert.deepEqual(checkpoints.result.checkpoints.map((item) => item.resourceKey), ["checkpoint-a"]);
    assert.equal(checkpoints.result.checkpoints[0]?.summary, "Task start checkpoint");
    assert.equal(checkpoints.result.checkpoints[0]?.runId, "run-session-api");
    assert.equal(checkpoints.result.checkpoints[0]?.taskId, "task-a");
    assert.equal(checkpoints.result.checkpoints[0]?.status, "created");

    const checkpointDetail = await call<{ checkpoint: { id: string; sessionId: string; checkpointType: string } }>(
      `/api/v2/sessions/session-a/checkpoints/${encodeURIComponent(checkpoint.id)}`,
    );
    assert.equal(checkpointDetail.kind, "session-checkpoint");
    assert.equal(checkpointDetail.result.checkpoint.id, checkpoint.id);
    assert.equal(checkpointDetail.result.checkpoint.sessionId, "session-a");

    const guardedDetail = await handleRuntimeRoute(context(), request("GET", `/api/v2/sessions/other-session/checkpoints/${encodeURIComponent(checkpoint.id)}`));
    assert.equal(guardedDetail.status, 400);
    assert.match(await guardedDetail.text(), /checkpoint not found/);

    const invalidQuery = await handleRuntimeRoute(context(), request("GET", "/api/v2/sessions/session-a/events?limit=0"));
    assert.equal(invalidQuery.status, 400);
    assert.match(await invalidQuery.text(), /limit must be a safe integer between 1 and 500/);

    const lineage = await call<{ sessionId: string; runIds: string[]; resources: Array<{ resourceType: string; resourceKey: string; links: Record<string, unknown>; payload?: unknown }> }>(
      "/api/v2/sessions/session-a/lineage",
    );
    assert.equal(lineage.kind, "session-lineage");
    assert.equal(lineage.result.sessionId, "session-a");
    assert.deepEqual(lineage.result.runIds, ["run-session-api"]);
    assert.deepEqual(lineage.result.resources.map((item) => item.resourceType).sort(), ["rollback_marker", "session", "session_checkpoint", "session_fork", "session_rollback"]);
    assert.equal(lineage.result.resources.some((item) => item.resourceKey === "rollback_marker:session-api"), true);
    assert.equal(lineage.result.resources.some((item) => item.resourceKey === "session-rollback-a" && item.links.previousRootSessionId === "session-a"), true);
    assert.equal(lineage.result.resources.some((item) => JSON.stringify(item).includes("do-not-expose")), false);
    assert.equal(await runStatus("run-session-api"), "running");

    async function call<T>(path: string): Promise<{ ok: true; kind: string; result: T }> {
      return await readOk<T>(await handleRuntimeRoute(context(), request("GET", path)));
    }

    async function runStatus(runId: string): Promise<string | undefined> {
      const row = await db.maybeOne<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
      return row?.status;
    }

    function context() {
      return {
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
      };
    }
  } finally {
    await db.close();
  }
});

test("runtime server client exposes session timeline and checkpoint APIs", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, kind: "test", result: {} }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = createRuntimeServerClient({ baseUrl: "http://127.0.0.1/" });
    await client.getSessionEvents({
      sessionId: "session/a",
      afterSequence: 1,
      beforeSequence: 10,
      limit: 20,
      eventTypes: ["artifact.created", "artifact.accepted"],
      taskId: "task-a",
      correlationId: "corr-a",
      artifactRef: "artifact-a",
      aroundEventId: "event/a",
      windowBefore: 2,
      windowAfter: 3,
    });
    await client.getSessionCheckpoints("session/a");
    await client.getSessionCheckpoint({ sessionId: "session/a", checkpointId: "checkpoint/a" });
    await client.getSessionLineage("session/a");

    assert.deepEqual(calls, [
      "http://127.0.0.1/api/v2/sessions/session%2Fa/events?afterSequence=1&beforeSequence=10&limit=20&eventTypes=artifact.created%2Cartifact.accepted&taskId=task-a&correlationId=corr-a&artifactRef=artifact-a&aroundEventId=event%2Fa&windowBefore=2&windowAfter=3",
      "http://127.0.0.1/api/v2/sessions/session%2Fa/checkpoints",
      "http://127.0.0.1/api/v2/sessions/session%2Fa/checkpoints/checkpoint%2Fa",
      "http://127.0.0.1/api/v2/sessions/session%2Fa/lineage",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function request(method: string, path: string): Request {
  return new Request(`http://127.0.0.1${path}`, { method });
}

async function readOk<T>(response: Response): Promise<{ ok: true; kind: string; result: T }> {
  const envelope = await response.json() as { ok: true; kind: string; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}
