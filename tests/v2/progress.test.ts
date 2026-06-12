import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { recordProgressCommentary } from "../../src/v2/signals/progress.ts";

test("records progress commentary as structured history event", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());
  createWorkflowTask(db, {
    id: "task-1",
    runId: "run-1",
    taskKey: "task-implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });

  recordProgressCommentary(db, {
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    message: "Implementer is running tests",
  });

  const [event] = listHistoryForRun(db, "run-1");
  assert.equal(event.eventType, "progress.commentary");
  assert.deepEqual(event.payload, { message: "Implementer is running tests" });
  assert.equal(event.sessionId, "session-1");
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
