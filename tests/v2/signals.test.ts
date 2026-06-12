import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { appendRuntimeEvent, RUNTIME_EVENT_TYPES } from "../../src/v2/signals/events.ts";

test("defines required runtime event types", () => {
  assert.deepEqual(RUNTIME_EVENT_TYPES, [
    "run.created",
    "session.entry",
    "task.started",
    "progress.commentary",
    "steering.received",
    "artifact.created",
    "evaluator.completed",
    "repair.requested",
    "checkpoint.created",
    "subagent.completed",
    "run.completed",
  ]);
});

test("appends runtime events into workflow history", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());

  appendRuntimeEvent(db, {
    runId: "run-1",
    eventType: "task.started",
    actorType: "orchestrator",
    payload: { taskId: "task-1" },
  });

  const [event] = listHistoryForRun(db, "run-1");
  assert.equal(event.eventType, "task.started");
  assert.deepEqual(event.payload, { taskId: "task-1" });
});

function minimalRun() {
  return {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
