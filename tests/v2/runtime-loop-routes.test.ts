import test from "node:test";
import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createRuntimeLoopRegistry } from "../../src/v2/server/runtime-loop-registry.ts";
import type { RuntimeServerContext } from "../../src/v2/server/runtime-context.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runtime loop routes expose health and run manual ticks", async () => {
  const db = await createTestPostgresDb();
  try {
    let tickCount = 0;
    const registry = createRuntimeLoopRegistry();
    registry.register({
      id: "runnable-task-scheduler",
      intervalMs: 5_000,
      runOnce: async () => {
        tickCount += 1;
        return { processed: 3 };
      },
    });

    const context = createContext(db, { runtimeLoopRegistry: registry, manualRuntimeLoopControls: true });

    const health = await call<{ database: { ok: boolean }; managedRuntime: { configured: boolean }; torkObservation: { configured: boolean }; loops: { configured: number } }>(
      context,
      "GET",
      "/api/v2/runtime/health",
    );
    assert.equal(health.kind, "runtime-health");
    assert.equal(health.result.database.ok, true);
    assert.equal(health.result.managedRuntime.configured, false);
    assert.equal(health.result.torkObservation.configured, false);
    assert.equal(health.result.loops.configured, 1);

    const tick = await call<{ loopId: string; status: string; result: { processed: number } }>(
      context,
      "POST",
      "/api/v2/runtime/loops/runnable-task-scheduler/tick",
    );
    assert.equal(tick.kind, "runtime-loop-tick");
    assert.equal(tick.result.loopId, "runnable-task-scheduler");
    assert.equal(tick.result.status, "succeeded");
    assert.equal(tick.result.result.processed, 3);
    assert.equal(tickCount, 1);

    const loops = await call<{ loops: Array<{ id: string; lastStatus?: string; lastResult?: unknown }> }>(
      context,
      "GET",
      "/api/v2/runtime/loops",
    );
    assert.equal(loops.kind, "runtime-loops");
    assert.deepEqual(loops.result.loops.map((loop) => loop.id), ["runnable-task-scheduler"]);
    assert.equal(loops.result.loops[0]?.lastStatus, "succeeded");

    const wake = await call<{ results: Array<{ loopId: string; status: string }> }>(context, "POST", "/api/v2/runtime/wake");
    assert.deepEqual(wake.result.results, [{ loopId: "runnable-task-scheduler", status: "succeeded", result: { processed: 3 } }]);
    assert.equal(tickCount, 2);

    const unknown = await handleRuntimeRoute(context, request("POST", "/api/v2/runtime/loops/not-a-loop/tick"));
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /unknown runtime loop id: not-a-loop/);

    const disabled = await handleRuntimeRoute(
      createContext(db, { runtimeLoopRegistry: registry }),
      request("POST", "/api/v2/runtime/loops/runnable-task-scheduler/tick"),
    );
    assert.equal(disabled.status, 400);
    assert.match(await disabled.text(), /manual runtime loop controls are disabled/);
  } finally {
    await db.close();
  }
});

test("runtime loop registry coalesces concurrent ticks and records background snapshots", async () => {
  const db = await createTestPostgresDb();
  try {
    let releaseTick: ((value: { processed: number }) => void) | undefined;
    let tickCount = 0;
    const registry = createRuntimeLoopRegistry();
    registry.register({
      id: "recovery-controller",
      intervalMs: 1_000,
      runOnce: async () => {
        tickCount += 1;
        return await new Promise((resolve) => {
          releaseTick = resolve;
        });
      },
    });
    const context = createContext(db, { runtimeLoopRegistry: registry, manualRuntimeLoopControls: true });
    const first = handleRuntimeRoute(context, request("POST", "/api/v2/runtime/loops/recovery-controller/tick"));
    const second = handleRuntimeRoute(context, request("POST", "/api/v2/runtime/loops/recovery-controller/tick"));
    await waitFor(() => tickCount === 1);
    assert.equal(tickCount, 1);
    releaseTick?.({ processed: 1 });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const firstEnvelope = await firstResponse.json() as { ok: true; result: { status: string; result: { processed: number } } };
    const secondEnvelope = await secondResponse.json() as { ok: true; result: { status: string; result: { processed: number } } };
    assert.equal(firstEnvelope.result.status, "succeeded");
    assert.deepEqual(secondEnvelope.result, firstEnvelope.result);

    const loops = await call<{ loops: Array<{ id: string; lastStatus?: string; running?: boolean }> }>(
      context,
      "GET",
      "/api/v2/runtime/loops",
    );
    assert.equal(loops.result.loops[0]?.lastStatus, "succeeded");
    assert.equal(loops.result.loops[0]?.running, false);
  } finally {
    await db.close();
  }
});

test("runtime health returns unhealthy database DTO with 503", async () => {
  const db = await createTestPostgresDb();
  await db.close();
  const response = await handleRuntimeRoute(createContext(db), request("GET", "/api/v2/runtime/health"));
  assert.equal(response.status, 503);
  const envelope = await response.json() as { ok: true; result: { database: { ok: boolean; error?: string } } };
  assert.equal(envelope.result.database.ok, false);
  assert.equal(typeof envelope.result.database.error, "string");
});

test("runtime server registers default reconcile loop in runtime loop registry", async () => {
  const db = await createTestPostgresDb();
  const registry = createRuntimeLoopRegistry();
  const server = await createSouthstarRuntimeServer({
    ...createContext(db, {
      runtimeLoopRegistry: registry,
      torkObservationClient: {
        capabilities: () => ({ supportsJobLogs: false }),
        getJob: async (jobId: string) => ({ id: jobId, status: "queued" }),
        getJobLogs: async () => "",
        cancelJob: async () => undefined,
      },
    }),
    reconcileIntervalMs: 60_000,
  });
  try {
    await waitFor(() => registry.list()[0]?.lastStatus === "succeeded");
    const loops = await call<{ loops: Array<{ id: string; intervalMs: number }> }>(
      createContext(db, { runtimeLoopRegistry: registry }),
      "GET",
      "/api/v2/runtime/loops",
    );
    assert.deepEqual(loops.result.loops.map((loop) => loop.id), ["executor-reconciler"]);
    assert.equal(loops.result.loops[0]?.intervalMs, 60_000);
    assert.equal(registry.list()[0]?.lastStatus, "succeeded");
  } finally {
    await server.close();
    await db.close();
  }
});

function createContext(db: RuntimeServerContext["db"], overrides: Partial<RuntimeServerContext> = {}): RuntimeServerContext {
  return {
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
    ...overrides,
  };
}

async function call<T>(
  context: RuntimeServerContext,
  method: string,
  path: string,
): Promise<{ ok: true; kind: string; result: T }> {
  const response = await handleRuntimeRoute(context, request(method, path));
  const envelope = await response.json() as { ok: true; kind: string; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

function request(method: string, path: string): Request {
  return new Request(`http://127.0.0.1${path}`, { method });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
