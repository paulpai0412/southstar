import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyExecutorTimeouts,
  isExecutorTerminalStatus,
  normalizeTorkStatus,
  validateExecutorBindingPayload,
  type ExecutorBindingPayload,
} from "../../src/v2/executor/observability-types.ts";

test("validates executor binding payload and preserves four-layer status fields", () => {
  const payload: ExecutorBindingPayload = {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    executorType: "tork",
    torkJobId: "job-1",
    southstarExecutorStatus: "submitted",
    submittedAt: "2026-06-15T00:00:00.000Z",
    queueTimeoutAt: "2026-06-15T00:02:00.000Z",
    hardTimeoutAt: "2026-06-15T00:10:00.000Z",
    reconcileGeneration: 0,
    idempotencyKey: "executor-binding:run-1:task-1:attempt-1",
  };

  assert.equal(validateExecutorBindingPayload(payload).ok, true);
  assert.equal(isExecutorTerminalStatus("completed"), true);
  assert.equal(isExecutorTerminalStatus("heartbeat-lost"), false);
});

test("normalizes Tork statuses without treating them as workflow completion", () => {
  assert.deepEqual(normalizeTorkStatus("RUNNING"), { raw: "RUNNING", category: "running-like" });
  assert.deepEqual(normalizeTorkStatus("COMPLETED"), { raw: "COMPLETED", category: "completed-like" });
  assert.deepEqual(normalizeTorkStatus("FAILED"), { raw: "FAILED", category: "failed-like" });
  assert.deepEqual(normalizeTorkStatus("PENDING"), { raw: "PENDING", category: "queued-like" });
});

test("classifies queue, heartbeat, and hard timeout separately", () => {
  const now = Date.parse("2026-06-15T00:05:00.000Z");
  const base: ExecutorBindingPayload = {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    executorType: "tork",
    torkJobId: "job-1",
    southstarExecutorStatus: "queued",
    submittedAt: "2026-06-15T00:00:00.000Z",
    queueTimeoutAt: "2026-06-15T00:01:00.000Z",
    hardTimeoutAt: "2026-06-15T00:30:00.000Z",
    reconcileGeneration: 0,
    idempotencyKey: "executor-binding:run-1:task-1:attempt-1",
  };
  assert.deepEqual(classifyExecutorTimeouts(base, now), ["queue-timeout"]);

  assert.deepEqual(classifyExecutorTimeouts({
    ...base,
    southstarExecutorStatus: "running",
    torkObservedStatus: "RUNNING",
    lastHeartbeatAt: "2026-06-15T00:00:30.000Z",
    heartbeatTimeoutAt: "2026-06-15T00:01:30.000Z",
  }, now), ["heartbeat-lost"]);

  assert.deepEqual(classifyExecutorTimeouts({
    ...base,
    southstarExecutorStatus: "running",
    queueTimeoutAt: "2026-06-15T00:20:00.000Z",
    hardTimeoutAt: "2026-06-15T00:04:00.000Z",
  }, now), ["hard-timeout"]);
});
