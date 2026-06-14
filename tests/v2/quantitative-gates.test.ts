import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { assertPhase1QuantitativeGates } from "../../src/v2/quality/phase1-gates.ts";

test("phase 1 quantitative gates verify durable evidence", () => {
  const db = seedPassingPhase1GateDb();

  const result = assertPhase1QuantitativeGates(db, {
    runId: "run-1",
    plannerMs: 1000,
    validationMs: 100,
    torkSubmitMs: 100,
    e2eMs: 1000,
    uiVisibilityMs: 100,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("phase 1 quantitative gates warn but pass when only full-suite wall clock exceeds target", () => {
  const db = seedPassingPhase1GateDb();

  const result = assertPhase1QuantitativeGates(db, {
    runId: "run-1",
    plannerMs: 1000,
    validationMs: 100,
    torkSubmitMs: 100,
    e2eMs: 21 * 60 * 1000,
    uiVisibilityMs: 100,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.match(result.warnings.join("\n"), /real E2E completion/);
});

test("phase 1 quantitative gates fail closed when evidence is missing", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });

  const result = assertPhase1QuantitativeGates(db, {
    runId: "run-1",
    plannerMs: 121_000,
    validationMs: 3000,
    torkSubmitMs: 11_000,
    e2eMs: 16 * 60 * 1000,
    uiVisibilityMs: 4000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.length > 5, true);
});

function seedPassingPhase1GateDb() {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-1",
    status: "passed",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      tasks: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({ aggregate: { tokens: 100, costMicrosUsd: 200, toolCalls: 3, retryCount: 1 } }),
  });
  for (const [index, id] of ["a", "b", "c", "d"].entries()) {
    createWorkflowTask(db, {
      id,
      runId: "run-1",
      taskKey: id,
      status: "completed",
      sortOrder: index,
      dependsOn: index === 0 ? [] : ["a"],
      metrics: { aggregate: { tokens: 10, costMicrosUsd: 20, toolCalls: 1, retryCount: 0 } },
    });
  }
  for (const eventType of [
    "session.entry",
    "subagent.completed",
    "subagent.completed",
    "evaluator.completed",
    "repair.requested",
    "workflow.expanded",
    "task.created",
    "memory.item_approved",
    "steering.received",
    "progress.commentary",
    "progress.commentary",
    "progress.commentary",
  ]) {
    appendHistoryEvent(db, {
      runId: "run-1",
      eventType,
      actorType: "test",
      payload: eventType === "evaluator.completed" ? { ok: true } : {},
    });
  }
  upsertRuntimeResource(db, {
    resourceType: "workflow_revision",
    resourceKey: "rev-1",
    runId: "run-1",
    scope: "workflow",
    status: "applied",
    title: "Revision",
    payload: {},
  });
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-1",
    runId: "run-1",
    scope: "software",
    status: "approved",
    title: "Memory",
    payload: {},
  });
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-1",
    runId: "run-1",
    scope: "task",
    status: "accepted",
    title: "Artifact",
    payload: {},
  });
  return db;
}
