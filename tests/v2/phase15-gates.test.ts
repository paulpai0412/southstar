import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertPhase15QuantitativeGates } from "../../src/v2/quality/phase15-gates.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";

test("phase 1.5 gates pass with durable SQLite evidence", () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-phase15-gates-")), "db.sqlite3"));
  createWorkflowRun(db, {
    id: "run-phase15",
    status: "passed",
    domain: "software",
    goalPrompt: "Fixture repo: /tmp/repo",
    workflowManifestJson: JSON.stringify({
      tasks: [{ id: "planner" }, { id: "implementer" }, { id: "root-validator" }, { id: "summary" }],
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: JSON.stringify({ aggregate: { tokens: 10, costUsd: 0, toolCalls: 1, retryCount: 0 } }),
  });
  for (const [index, id] of ["planner", "implementer", "root-validator", "summary"].entries()) {
    createWorkflowTask(db, {
      id,
      runId: "run-phase15",
      taskKey: id,
      status: "completed",
      sortOrder: index,
      dependsOn: [],
      rootSessionId: `root-${id}`,
      snapshot: {},
    });
  }
  for (const eventType of [
    "executor.submitted",
    "progress.commentary",
    "evaluator.completed",
    "session.entry",
    "subagent.completed",
    "subagent.completed",
    "voice.command_received",
    "approval.requested",
    "approval.decided",
  ]) {
    appendHistoryEvent(db, { runId: "run-phase15", eventType, actorType: "orchestrator", payload: {} });
  }
  for (const [resourceType, status] of [
    ["artifact", "accepted"],
    ["executor_binding", "queued"],
    ["skill_snapshot", "resolved"],
    ["approval", "approved"],
  ] as const) {
    upsertRuntimeResource(db, {
      id: `${resourceType}-1`,
      resourceType,
      resourceKey: `${resourceType}-1`,
      runId: "run-phase15",
      scope: "test",
      status,
      title: resourceType,
      payload: {},
    });
  }
  assert.deepEqual(assertPhase15QuantitativeGates(db, {
    runId: "run-phase15",
    serverStartMs: 100,
    plannerMs: 1_000,
    validationMs: 10,
    torkSubmitMs: 100,
    firstClientEventMs: 100,
    uiEventVisibilityMs: 100,
    modeToggleMs: 10,
    apiRunGoalCompletionMs: 1_000,
    cliRunGoalCompletionMs: 1_000,
    browserScenarioMs: 1_000,
    durableFolderFindings: [],
  }), { ok: true, failures: [] });
});

test("phase 1.5 gates fail closed when evidence is missing", () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-phase15-gates-missing-")), "db.sqlite3"));
  const result = assertPhase15QuantitativeGates(db, {
    runId: "missing",
    serverStartMs: 6_000,
    plannerMs: 121_000,
    validationMs: 3_000,
    torkSubmitMs: 11_000,
    firstClientEventMs: 11_000,
    uiEventVisibilityMs: 4_000,
    modeToggleMs: 800,
    apiRunGoalCompletionMs: 16 * 60 * 1_000,
    cliRunGoalCompletionMs: 16 * 60 * 1_000,
    browserScenarioMs: 21 * 60 * 1_000,
    durableFolderFindings: [".southstar/session"],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /workflow run not found|runtime server start|durable folder/);
});
