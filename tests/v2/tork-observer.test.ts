import test from "node:test";
import assert from "node:assert/strict";
import { observeTorkHandExecutionExceptionsPg } from "../../src/v2/executor/tork-observer.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("tork observer records queue timeout and requeue decision for expired queued hand execution", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunAndTask(db, "run-tork-observer-queue", "task-a", {
      runStatus: "scheduling",
      taskStatus: "queued",
    });
    await seedHandExecution(db, {
      runId: "run-tork-observer-queue",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "queued",
      queuedAt: "2026-06-21T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      heartbeatTimeoutSeconds: 30,
      externalJobId: "job-queue-timeout",
    });
    await seedHandExecution(db, {
      runId: "run-tork-observer-queue",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-2",
      status: "queued",
      queuedAt: "2026-06-21T10:01:00.000Z",
      queueTimeoutSeconds: 60,
      heartbeatTimeoutSeconds: 30,
      externalJobId: "job-queue-active",
    });

    const result = await observeTorkHandExecutionExceptionsPg(db, { now: "2026-06-21T10:01:30.000Z" });

    assert.deepEqual(result.observedKinds, ["tork_queue_timeout"]);
    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-tork-observer-queue");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "tork_queue_timeout");
    assert.equal(exceptions[0]?.payload.severity, "recoverable");
    assert.equal(exceptions[0]?.payload.observedAt, "2026-06-21T10:01:30.000Z");
    assert.deepEqual(exceptions[0]?.payload.evidenceRefs, ["hand-execution:run-tork-observer-queue:task-a:attempt-1"]);
    assert.deepEqual(exceptions[0]?.payload.providerEvidence, {
      externalJobId: "job-queue-timeout",
      status: "queued",
    });
    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-tork-observer-queue");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.path, "requeue-hand-execution");
    assert.equal(decisions[0]?.payload.exceptionId, exceptions[0]?.payload.exceptionId);
  } finally {
    await db.close();
  }
});

test("tork observer records running hang and reprovision decision for expired running hand execution", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunAndTask(db, "run-tork-observer-running", "task-a");
    await seedHandExecution(db, {
      runId: "run-tork-observer-running",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "running",
      queuedAt: "2026-06-21T10:00:00.000Z",
      startedAt: "2026-06-21T10:00:20.000Z",
      lastHeartbeatAt: "2026-06-21T10:00:30.000Z",
      queueTimeoutSeconds: 60,
      heartbeatTimeoutSeconds: 30,
      externalJobId: "job-running-hang",
    });
    await seedHandExecution(db, {
      runId: "run-tork-observer-running",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-2",
      status: "running",
      queuedAt: "2026-06-21T10:00:40.000Z",
      startedAt: "2026-06-21T10:00:50.000Z",
      lastHeartbeatAt: "2026-06-21T10:01:00.000Z",
      queueTimeoutSeconds: 60,
      heartbeatTimeoutSeconds: 30,
      externalJobId: "job-running-active",
    });

    const result = await observeTorkHandExecutionExceptionsPg(db, { now: "2026-06-21T10:01:20.000Z" });

    assert.deepEqual(result.observedKinds, ["tork_running_hang"]);
    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-tork-observer-running");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "tork_running_hang");
    assert.deepEqual(exceptions[0]?.payload.evidenceRefs, ["hand-execution:run-tork-observer-running:task-a:attempt-1"]);
    assert.deepEqual(exceptions[0]?.payload.providerEvidence, {
      externalJobId: "job-running-hang",
      status: "running",
    });
    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-tork-observer-running");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.path, "reprovision-hand");
    assert.equal(decisions[0]?.payload.operatorApprovalRequired, false);
  } finally {
    await db.close();
  }
});

test("tork observer relies on exception and decision idempotency across repeated observations", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunAndTask(db, "run-tork-observer-idempotent", "task-a");
    await seedHandExecution(db, {
      runId: "run-tork-observer-idempotent",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "queued",
      queuedAt: "2026-06-21T09:58:00.000Z",
      queueTimeoutSeconds: 60,
      heartbeatTimeoutSeconds: 30,
      externalJobId: "job-idempotent",
    });

    await observeTorkHandExecutionExceptionsPg(db, { now: "2026-06-21T10:00:00.000Z" });
    await observeTorkHandExecutionExceptionsPg(db, { now: "2026-06-21T10:01:00.000Z" });

    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-tork-observer-idempotent");
    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-tork-observer-idempotent");
    assert.equal(exceptions.length, 1);
    assert.equal(decisions.length, 1);
    assert.equal(exceptions[0]?.payload.observedAt, "2026-06-21T10:00:00.000Z");
  } finally {
    await db.close();
  }
});

async function seedRunAndTask(
  db: SouthstarDb,
  runId: string,
  taskId: string,
  input: { runStatus?: string; taskStatus?: string } = {},
): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: input.runStatus ?? "running",
    domain: "software",
    goalPrompt: "observe tork hand execution",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: input.taskStatus ?? "running",
    sortOrder: 0,
    dependsOn: [],
  });
}

async function seedHandExecution(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    status: "queued" | "running";
    queuedAt: string;
    startedAt?: string;
    lastHeartbeatAt?: string;
    queueTimeoutSeconds: number;
    heartbeatTimeoutSeconds: number;
    externalJobId: string;
  },
): Promise<void> {
  const handExecutionId = `hand-execution:${input.runId}:${input.taskId}:${input.attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "hand",
    status: input.status,
    title: `Hand execution ${input.taskId}`,
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      providerId: "tork",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      brainBindingId: `brain-binding-${input.runId}-${input.taskId}`,
      handBindingId: `hand-binding-${input.runId}-${input.taskId}`,
      externalJobId: input.externalJobId,
      status: input.status,
      queuedAt: input.queuedAt,
      queueTimeoutSeconds: input.queueTimeoutSeconds,
      heartbeatTimeoutSeconds: input.heartbeatTimeoutSeconds,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.lastHeartbeatAt ? { lastHeartbeatAt: input.lastHeartbeatAt } : {}),
    },
    summary: { providerId: "tork", attemptId: input.attemptId },
    metrics: {},
  });
}
