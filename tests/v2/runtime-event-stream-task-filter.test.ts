import assert from "node:assert/strict";
import test from "node:test";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createRuntimeEventStreamResponse } from "../../src/v2/server/runtime-event-stream.ts";
import { readRunEventsSince } from "../../src/v2/server/sse.ts";
import { appendHistoryEventPg, createWorkflowRunPg, updateWorkflowRunStatusPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("readRunEventsSince filters task events and preserves explicit includeRunEvents false", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-event-task-filter";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "runtime event task filter",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    await appendHistoryEventPg(db, {
      runId,
      eventType: "run.created",
      actorType: "orchestrator",
      payload: { run: true },
    });
    await appendHistoryEventPg(db, {
      runId,
      taskId: "task-a",
      eventType: "task.a",
      actorType: "hand",
      payload: { task: "a" },
    });
    await appendHistoryEventPg(db, {
      runId,
      taskId: "task-b",
      eventType: "task.b",
      actorType: "hand",
      payload: { task: "b" },
    });

    const taskOnly = await readRunEventsSince(db, {
      runId,
      taskId: "task-a",
      includeRunEvents: false,
    });
    assert.deepEqual(taskOnly.map((event) => event.eventType), ["task.a"]);

    const withRunEvents = await readRunEventsSince(db, {
      runId,
      taskId: "task-a",
    });
    assert.deepEqual(withRunEvents.map((event) => event.eventType), ["run.created", "task.a"]);
  } finally {
    await db.close();
  }
});

test("task-filtered stream closes on terminal run status even when run events are excluded", async () => {
  const db = await createTestPostgresDb();
  try {
    for (const terminalStatus of ["completed", "passed"] as const) {
      const runId = `run-event-task-filter-terminal-${terminalStatus}`;
      await createWorkflowRunPg(db, {
        id: runId,
        status: "running",
        domain: "software",
        goalPrompt: "runtime event task terminal filter",
        workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
        executionProjectionJson: JSON.stringify({}),
        snapshotJson: JSON.stringify({}),
        runtimeContextJson: JSON.stringify({}),
        metricsJson: JSON.stringify({}),
      });
      await appendHistoryEventPg(db, {
        runId,
        taskId: "task-a",
        eventType: "task.a",
        actorType: "hand",
        payload: { task: "a" },
      });
      await appendHistoryEventPg(db, {
        runId,
        eventType: "run.completed",
        actorType: "orchestrator",
        payload: { terminal: true },
      });
      await updateWorkflowRunStatusPg(db, runId, terminalStatus);

      const response = createRuntimeEventStreamResponse(
        context(db),
        new Request(`http://127.0.0.1/api/v2/runs/${runId}/events/stream?taskId=task-a&includeRunEvents=false&pollMs=10&heartbeatMs=1000`),
        new URL(`http://127.0.0.1/api/v2/runs/${runId}/events/stream?taskId=task-a&includeRunEvents=false&pollMs=10&heartbeatMs=1000`),
        runId,
      );
      assert.ok(response.body, "stream response must have a body");
      const reader = response.body.getReader();
      try {
        const frame = await readNextSseEvent(reader);
        assert.equal(frame.event, "task.a", terminalStatus);
        const closeRead = await Promise.race([
          reader.read(),
          sleep(1000).then(() => undefined),
        ]);
        assert.notEqual(closeRead, undefined, `task-filtered stream should close after ${terminalStatus} run status`);
        assert.equal(closeRead!.done, true, terminalStatus);
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }
  } finally {
    await db.close();
  }
});

function context(db: SouthstarDb) {
  return {
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
  };
}

type SseEvent = {
  id?: string;
  event: string;
  data: unknown;
};

async function readNextSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      sleep(Math.max(1, deadline - Date.now())).then(() => undefined),
    ]);
    if (chunk === undefined) break;
    assert.equal(chunk.done, false, "stream closed before the next durable event arrived");
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseFirstSseEvent(buffer);
    if (parsed) return parsed;
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
