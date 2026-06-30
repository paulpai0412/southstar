import assert from "node:assert/strict";
import test from "node:test";
import { readRunEventsSince } from "../../src/v2/server/sse.ts";
import { appendHistoryEventPg, createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
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
