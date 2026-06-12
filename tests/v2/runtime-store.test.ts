import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun, getWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { appendHistoryEvent, listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import {
  applyWorkflowExpansion,
  approveMemoryDelta,
  listResources,
  proposeMemoryDelta,
  requestWorkflowRevision,
  retrieveApprovedMemory,
  validateWorkflowRevision,
} from "../../src/v2/stores/resource-store.ts";

test("appends workflow history with per-run sequence numbers", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());

  const first = appendHistoryEvent(db, {
    runId: "run-1",
    eventType: "run.created",
    actorType: "orchestrator",
    payload: { status: "running" },
  });
  const second = appendHistoryEvent(db, {
    runId: "run-1",
    eventType: "manifest.validated",
    actorType: "validator",
    payload: { ok: true },
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(listHistoryForRun(db, "run-1").map((event) => event.eventType), [
    "run.created",
    "manifest.validated",
  ]);
});

test("approved memory deltas become reusable memory snapshots", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());

  const delta = proposeMemoryDelta(db, "run-1", { preference: "minimal changes" });
  assert.deepEqual(retrieveApprovedMemory(db, "software", 10).items, []);

  const approved = approveMemoryDelta(db, delta.id);
  const snapshot = retrieveApprovedMemory(db, "software", 10);

  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].id, approved.memoryItemId);
  assert.deepEqual(snapshot.items[0].body, { preference: "minimal changes" });
});

test("applies workflow expansion in one durable projection update", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());

  requestWorkflowRevision(db, {
    runId: "run-1",
    revisionId: "rev-1",
    reason: "add verification",
    patch: { addTasks: ["task-verify"] },
    idempotencyKey: "rev-1",
  });
  validateWorkflowRevision(db, {
    runId: "run-1",
    revisionId: "rev-1",
    validationResult: { ok: true },
    manifestFingerprint: "abc123",
  });
  applyWorkflowExpansion(db, {
    runId: "run-1",
    revisionId: "rev-1",
    workflowManifestJson: JSON.stringify({ revision: "rev-1" }),
    createdTasks: [{ id: "task-row-1", taskKey: "task-verify", dependsOn: ["task-implement"] }],
  });

  assert.equal(getWorkflowRun(db, "run-1")?.workflowManifestJson, JSON.stringify({ revision: "rev-1" }));
  assert.equal(listResources(db, { resourceType: "workflow_revision", status: "applied" }).length, 1);
  assert.equal(
    listHistoryForRun(db, "run-1").some((event) => event.eventType === "workflow.expanded"),
    true,
  );
  const task = db.prepare("select task_key, depends_on_json from workflow_tasks where id = ?").get("task-row-1") as {
    task_key: string;
    depends_on_json: string;
  };
  assert.equal(task.task_key, "task-verify");
  assert.equal(task.depends_on_json, JSON.stringify(["task-implement"]));
});

function minimalRun() {
  return {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({ scope: "software" }),
    metricsJson: JSON.stringify({}),
  };
}
