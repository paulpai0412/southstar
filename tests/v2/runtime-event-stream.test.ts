import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createRuntimeEventStreamResponse } from "../../src/v2/server/runtime-event-stream.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { appendHistoryEventPg, createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb, type TestPostgresDb } from "./postgres-test-utils.ts";

type RuntimeEventFrame = {
  sequence: number;
  eventType: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  actorType: string;
  payload: unknown;
  createdAt: string;
};

test("runtime event stream replays durable history and stays open for appended events", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-runtime-event-stream");
    await appendHistoryEventPg(db, {
      runId: "run-runtime-event-stream",
      taskId: "task-a",
      sessionId: "session-a",
      eventType: "planner.started",
      actorType: "system",
      payload: { step: "initial" },
    });

    const polling = await readOk<RuntimeEventFrame[]>(
      await handleRuntimeRoute(context(db), request("GET", "/api/v2/runs/run-runtime-event-stream/events?after=0")),
    );
    assert.equal(polling.result.length, 1);
    assertFrame(polling.result[0]!, {
      sequence: 1,
      eventType: "planner.started",
      runId: "run-runtime-event-stream",
      taskId: "task-a",
      sessionId: "session-a",
      actorType: "system",
    });

    const response = await handleRuntimeRoute(
      context(db),
      request("GET", "/api/v2/runs/run-runtime-event-stream/events/stream?closeOnTerminal=false", undefined, {
        "last-event-id": "1",
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.ok(response.body, "stream response must have a body");

    const reader = response.body.getReader();
    const closedEarly = await Promise.race([
      reader.closed.then(() => true),
      sleep(75).then(() => false),
    ]);
    assert.equal(closedEarly, false, "stream must stay open when no new events are available");

    await appendHistoryEventPg(db, {
      runId: "run-runtime-event-stream",
      taskId: "task-a",
      sessionId: "session-a",
      eventType: "progress.commentary",
      actorType: "hand",
      payload: { message: "live event" },
    });

    const liveFrame = await readNextEventFrame(reader);
    assertFrame(liveFrame, {
      sequence: 2,
      eventType: "progress.commentary",
      runId: "run-runtime-event-stream",
      taskId: "task-a",
      sessionId: "session-a",
      actorType: "hand",
    });
    assert.deepEqual(liveFrame.payload, { message: "live event" });

    await reader.cancel();
    await response.body.cancel().catch(() => undefined);
  } finally {
    await db.close();
  }
});

test("runtime event stream honors Last-Event-ID before after query and polling rejects unsafe after values", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-runtime-event-reconnect");
    await appendHistoryEventPg(db, { runId: "run-runtime-event-reconnect", eventType: "planner.started", actorType: "system", payload: { index: 1 } });
    await appendHistoryEventPg(db, { runId: "run-runtime-event-reconnect", eventType: "progress.commentary", actorType: "hand", payload: { index: 2 } });
    await appendHistoryEventPg(db, { runId: "run-runtime-event-reconnect", eventType: "artifact.created", actorType: "hand", payload: { index: 3 } });

    const invalidPolling = await readOk<RuntimeEventFrame[]>(
      await handleRuntimeRoute(context(db), request("GET", "/api/v2/runs/run-runtime-event-reconnect/events?after=1.5")),
    );
    assert.deepEqual(invalidPolling.result.map((event) => event.sequence), [1, 2, 3]);

    const response = await handleRuntimeRoute(
      context(db),
      request("GET", "/api/v2/runs/run-runtime-event-reconnect/events/stream?after=0&closeOnTerminal=false&pollMs=10&heartbeatMs=1000", undefined, {
        "last-event-id": "2",
      }),
    );
    assert.ok(response.body, "stream response must have a body");
    const reader = response.body.getReader();
    try {
      const frame = await readNextSseEvent(reader);
      assert.equal(frame.event, "artifact.created");
      assertFrame(frame.data as RuntimeEventFrame, {
        sequence: 3,
        eventType: "artifact.created",
        runId: "run-runtime-event-reconnect",
        actorType: "hand",
      });
    } finally {
      await reader.cancel();
    }
  } finally {
    await db.close();
  }
});

test("runtime event stream emits heartbeat event frames using pollMs and heartbeatMs", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-runtime-event-heartbeat");
    const response = await handleRuntimeRoute(
      context(db),
      request("GET", "/api/v2/runs/run-runtime-event-heartbeat/events/stream?closeOnTerminal=false&pollMs=10&heartbeatMs=35"),
    );
    assert.ok(response.body, "stream response must have a body");
    const reader = response.body.getReader();
    try {
      await sleep(15);
      const frame = await readNextSseEvent(reader, { timeoutMs: 1000, skipEvents: new Set(["planner.started", "progress.commentary"]) });
      assert.equal(frame.event, "heartbeat");
      assert.equal(typeof frame.data, "string");
      assert.match(frame.data as string, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await reader.cancel();
    }
  } finally {
    await db.close();
  }
});

test("runtime event stream closes after terminal history on reconnect unless closeOnTerminal is false", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-runtime-event-terminal", "completed");
    await appendHistoryEventPg(db, { runId: "run-runtime-event-terminal", eventType: "progress.commentary", actorType: "hand", payload: { index: 1 } });
    await appendHistoryEventPg(db, { runId: "run-runtime-event-terminal", eventType: "run.completed", actorType: "system", payload: { terminal: true } });

    const closingResponse = await handleRuntimeRoute(
      context(db),
      request("GET", "/api/v2/runs/run-runtime-event-terminal/events/stream?after=2&pollMs=10&heartbeatMs=50"),
    );
    assert.ok(closingResponse.body, "stream response must have a body");
    const closingReader = closingResponse.body.getReader();
    const closingRead = await Promise.race([
      closingReader.read(),
      sleep(1000).then(() => undefined),
    ]);
    assert.notEqual(closingRead, undefined, "terminal reconnect should close after an empty poll");
    assert.equal(closingRead!.done, true);

    const openResponse = await handleRuntimeRoute(
      context(db),
      request("GET", "/api/v2/runs/run-runtime-event-terminal/events/stream?after=2&closeOnTerminal=false&pollMs=10&heartbeatMs=35"),
    );
    assert.ok(openResponse.body, "stream response must have a body");
    const openReader = openResponse.body.getReader();
    try {
      const stayedOpen = await Promise.race([
        openReader.closed.then(() => false),
        sleep(80).then(() => true),
      ]);
      assert.equal(stayedOpen, true);
      const heartbeat = await readNextSseEvent(openReader);
      assert.equal(heartbeat.event, "heartbeat");
    } finally {
      await openReader.cancel();
    }
  } finally {
    await db.close();
  }
});

test("runtime event stream abort during in-flight read does not enqueue into a closed stream", async () => {
  let releaseQuery: ((rows: unknown[]) => void) | undefined;
  const db = {
    async query() {
      return await new Promise<{ rows: unknown[] }>((resolve) => {
        releaseQuery = (rows) => resolve({ rows });
      });
    },
    async maybeOne() {
      return { status: "running" };
    },
  } as unknown as SouthstarDb;
  const abortController = new AbortController();
  const response = createRuntimeEventStreamResponse(context(db), new Request(
    "http://127.0.0.1/api/v2/runs/run-abort/events/stream?pollMs=10&heartbeatMs=20",
    { signal: abortController.signal },
  ), new URL("http://127.0.0.1/api/v2/runs/run-abort/events/stream?pollMs=10&heartbeatMs=20"), "run-abort");
  assert.ok(response.body, "stream response must have a body");
  const reader = response.body.getReader();

  abortController.abort();
  releaseQuery?.([]);
  const closed = await Promise.race([
    reader.closed.then(() => true, () => false),
    sleep(1000).then(() => false),
  ]);
  assert.equal(closed, true);
});

test("runtime event stream closes immediately when request is already aborted", async () => {
  let queryCalls = 0;
  const db = {
    async query() {
      queryCalls += 1;
      return { rows: [] };
    },
    async maybeOne() {
      return { status: "running" };
    },
  } as unknown as SouthstarDb;
  const abortController = new AbortController();
  abortController.abort();

  const response = createRuntimeEventStreamResponse(context(db), new Request(
    "http://127.0.0.1/api/v2/runs/run-aborted/events/stream?pollMs=10&heartbeatMs=20",
    { signal: abortController.signal },
  ), new URL("http://127.0.0.1/api/v2/runs/run-aborted/events/stream?pollMs=10&heartbeatMs=20"), "run-aborted");

  assert.ok(response.body, "stream response must have a body");
  const reader = response.body.getReader();
  const read = await Promise.race([
    reader.read(),
    sleep(1000).then(() => undefined),
  ]);
  assert.notEqual(read, undefined);
  assert.equal(read!.done, true);
  assert.equal(queryCalls, 0);
});

function context(db: SouthstarDb) {
  return {
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
  };
}

async function seedRun(db: TestPostgresDb, runId: string, status = "running"): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status,
    domain: "software",
    goalPrompt: "runtime event stream",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
}

function request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readOk<T>(response: Response): Promise<{ ok: true; kind: string; result: T }> {
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: true; kind: string; result: T };
  assert.equal(body.ok, true);
  return body;
}

async function readNextEventFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<RuntimeEventFrame> {
  const frame = await readNextSseEvent(reader);
  return frame.data as RuntimeEventFrame;
}

type SseEvent = {
  id?: string;
  event: string;
  data: unknown;
};

async function readNextSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: { timeoutMs?: number; skipEvents?: Set<string> } = {},
): Promise<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + (options.timeoutMs ?? 2000);
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      sleep(remainingMs).then(() => undefined),
    ]);
    if (chunk === undefined) break;
    assert.equal(chunk.done, false, "stream closed before the next durable event arrived");
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseFirstSseEvent(buffer);
    if (parsed && !options.skipEvents?.has(parsed.event)) return parsed;
    if (parsed) buffer = buffer.slice(buffer.indexOf("\n\n") + 2);
  }
  throw new Error(`timed out waiting for event frame; buffered=${JSON.stringify(buffer)}`);
}

function parseFirstSseEvent(buffer: string): SseEvent | undefined {
  const eventEnd = buffer.indexOf("\n\n");
  if (eventEnd === -1) return undefined;
  const block = buffer.slice(0, eventEnd);
  const idLine = block.split("\n").find((line) => line.startsWith("id: "));
  const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
  const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return undefined;
  const rawData = dataLine.slice("data: ".length);
  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
    data = rawData;
  }
  return {
    id: idLine?.slice("id: ".length),
    event: eventLine?.slice("event: ".length) ?? "message",
    data,
  };
}

function assertFrame(actual: RuntimeEventFrame, expected: Omit<RuntimeEventFrame, "payload" | "createdAt">): void {
  assert.equal(actual.sequence, expected.sequence);
  assert.equal(actual.eventType, expected.eventType);
  assert.equal(actual.runId, expected.runId);
  assert.equal(actual.taskId, expected.taskId);
  assert.equal(actual.sessionId, expected.sessionId);
  assert.equal(actual.actorType, expected.actorType);
  assert.equal(typeof actual.createdAt, "string");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
