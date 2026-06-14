import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { assertDomainPackDynamicQuantitativeGates } from "../../src/v2/quality/domain-pack-dynamic-gates.ts";

test("domain-pack dynamic workflow gates verify durable loop-engineering evidence", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-dynamic",
    status: "passed",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({
      aggregate: { tokens: 100, costMicrosUsd: 200, toolCalls: 1, retryCount: 0, durationMs: 250 },
      resourceCount: 10,
    }),
  });
  for (const [index, id] of ["a", "b", "c", "d", "e"].entries()) {
    createWorkflowTask(db, {
      id,
      runId: "run-dynamic",
      taskKey: id,
      status: "completed",
      sortOrder: index,
      dependsOn: index === 0 ? [] : ["a"],
      metrics: { aggregate: { tokens: 10, costMicrosUsd: 0, toolCalls: 1, retryCount: 0, durationMs: 20 }, resourceCount: 1 },
    });
    appendHistoryEvent(db, {
      runId: "run-dynamic",
      taskId: id,
      eventType: "subagent.completed",
      actorType: "subagent",
      payload: { subagentIds: [`agent-${id}`] },
    });
    appendHistoryEvent(db, {
      runId: "run-dynamic",
      taskId: id,
      eventType: "evaluator.completed",
      actorType: "root-session",
      payload: { ok: true },
    });
    appendHistoryEvent(db, {
      runId: "run-dynamic",
      taskId: id,
      eventType: "progress.commentary",
      actorType: "subagent",
      payload: { message: `progress ${id}` },
    });
  }
  for (const [resourceType, minimum] of [
    ["workflow_generation_plan", 1],
    ["orchestration_snapshot", 1],
    ["context_packet", 5],
    ["memory_injection_trace", 5],
    ["session_node", 5],
    ["session_checkpoint", 5],
    ["workspace_snapshot", 1],
    ["evaluator_pipeline_result", 1],
    ["stop_condition_result", 1],
  ] as const) {
    for (let index = 0; index < minimum; index++) {
      upsertRuntimeResource(db, {
        resourceType,
        resourceKey: `${resourceType}-${index}`,
        runId: "run-dynamic",
        scope: "test",
        status: resourceType === "stop_condition_result" ? "passed" : "created",
        title: resourceType,
        payload: {},
      });
    }
  }

  assert.deepEqual(assertDomainPackDynamicQuantitativeGates(db, {
    runId: "run-dynamic",
    plannerMs: 1000,
    validationMs: 100,
    torkSubmitMs: 100,
    e2eMs: 1000,
  }), { ok: true, failures: [] });
});

test("domain-pack dynamic workflow gates require recovery only after evaluator failure", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-dynamic-recovery",
    status: "passed",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  for (const [index, id] of ["a", "b", "c", "d", "e"].entries()) {
    createWorkflowTask(db, {
      id,
      runId: "run-dynamic-recovery",
    taskKey: id,
    status: "completed",
    sortOrder: index,
    dependsOn: [],
    metrics: { aggregate: { tokens: 10, toolCalls: 1, durationMs: 20 } },
  });
  }
  for (const [resourceType, minimum] of [
    ["workflow_generation_plan", 1],
    ["orchestration_snapshot", 1],
    ["context_packet", 5],
    ["memory_injection_trace", 5],
    ["session_node", 5],
    ["session_checkpoint", 5],
    ["workspace_snapshot", 1],
    ["stop_condition_result", 1],
  ] as const) {
    for (let index = 0; index < minimum; index++) {
      upsertRuntimeResource(db, {
        resourceType,
        resourceKey: `${resourceType}-${index}`,
        runId: "run-dynamic-recovery",
        scope: "test",
        status: resourceType === "stop_condition_result" ? "passed" : "created",
        title: resourceType,
        payload: {},
      });
    }
  }
  upsertRuntimeResource(db, {
    resourceType: "evaluator_pipeline_result",
    resourceKey: "eval-failed",
    runId: "run-dynamic-recovery",
    scope: "test",
    status: "failed",
    title: "failed evaluator",
    payload: {},
  });

  const result = assertDomainPackDynamicQuantitativeGates(db, {
    runId: "run-dynamic-recovery",
    plannerMs: 1000,
    validationMs: 100,
    torkSubmitMs: 100,
    e2eMs: 1000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.includes("expected at least 1 recovery_decision, got 0"), true);
});

test("domain-pack dynamic workflow gates fail when quantitative runtime metrics are missing", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-dynamic-metrics",
    status: "passed",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  for (const [index, id] of ["a", "b", "c", "d", "e"].entries()) {
    createWorkflowTask(db, {
      id,
      runId: "run-dynamic-metrics",
      taskKey: id,
      status: "completed",
      sortOrder: index,
      dependsOn: [],
    });
  }
  for (const [resourceType, minimum] of [
    ["workflow_generation_plan", 1],
    ["orchestration_snapshot", 1],
    ["context_packet", 5],
    ["memory_injection_trace", 5],
    ["session_node", 5],
    ["session_checkpoint", 5],
    ["workspace_snapshot", 1],
    ["evaluator_pipeline_result", 1],
    ["stop_condition_result", 1],
  ] as const) {
    for (let index = 0; index < minimum; index++) {
      upsertRuntimeResource(db, {
        resourceType,
        resourceKey: `${resourceType}-${index}`,
        runId: "run-dynamic-metrics",
        scope: "test",
        status: resourceType === "stop_condition_result" ? "passed" : "created",
        title: resourceType,
        payload: {},
      });
    }
  }

  const result = assertDomainPackDynamicQuantitativeGates(db, {
    runId: "run-dynamic-metrics",
    plannerMs: 1000,
    validationMs: 100,
    torkSubmitMs: 100,
    e2eMs: 1000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.some((failure) => /subagent.completed/.test(failure)), true);
  assert.equal(result.failures.some((failure) => /evaluator.completed/.test(failure)), true);
  assert.equal(result.failures.some((failure) => /progress.commentary/.test(failure)), true);
  assert.equal(result.failures.some((failure) => /aggregate tokens/.test(failure)), true);
  assert.equal(result.failures.some((failure) => /task metrics/.test(failure)), true);
});

test("domain-pack dynamic workflow gates fail closed when loop evidence is missing", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-dynamic",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });

  const result = assertDomainPackDynamicQuantitativeGates(db, {
    runId: "run-dynamic",
    plannerMs: 61_000,
    validationMs: 6000,
    torkSubmitMs: 21_000,
    e2eMs: 21 * 60_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.length > 8, true);
});
