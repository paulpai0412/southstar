import test from "node:test";
import assert from "node:assert/strict";
import {
  listHistoryForRunPg,
  listResourcesPg,
  createWorkflowRunPg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  listUnresolvedRuntimeExceptionsPg,
  recordRuntimeExceptionPg,
  resolveRuntimeExceptionPg,
} from "../../src/v2/exceptions/postgres-runtime-exceptions.ts";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runtime exception store records idempotent exception resources and history", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-exception-store",
      status: "running",
      domain: "software",
      goalPrompt: "harden runtime",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const first = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-store",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-store:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      status: "observed",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["hand-execution:run-exception-store:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-a", queueAgeSeconds: 121 },
    });
    const duplicate = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-store",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-store:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      status: "observed",
      observedAt: "2026-06-21T10:00:30.000Z",
      evidenceRefs: ["hand-execution:run-exception-store:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-a", queueAgeSeconds: 151 },
    });

    assert.equal(duplicate.exceptionId, first.exceptionId);
    assert.equal(duplicate.resourceKey, first.resourceKey);
    const resources = await listResourcesPg(db, { resourceType: "runtime_exception" });
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.status, "observed");
    assert.equal(resources[0]?.payload.schemaVersion, "southstar.runtime.exception.v1");
    assert.equal(resources[0]?.payload.status, "observed");
    assert.equal(resources[0]?.payload.kind, "tork_queue_timeout");
    assert.equal(resources[0]?.payload.severity, "recoverable");
    assert.equal(resources[0]?.payload.observedAt, "2026-06-21T10:00:00.000Z");
    assert.deepEqual(resources[0]?.payload.providerEvidence, { externalJobId: "job-a", queueAgeSeconds: 121 });

    const unresolved = await listUnresolvedRuntimeExceptionsPg(db, { runId: "run-exception-store" });
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]?.resourceKey, first.resourceKey);

    await resolveRuntimeExceptionPg(db, {
      runId: "run-exception-store",
      resourceKey: first.resourceKey,
      resolvedAt: "2026-06-21T10:02:00.000Z",
      reason: "replacement attempt queued",
    });
    await resolveRuntimeExceptionPg(db, {
      runId: "run-exception-store",
      resourceKey: first.resourceKey,
      resolvedAt: "2026-06-21T10:03:00.000Z",
      reason: "operator closed duplicate",
    });

    const afterResolve = await listUnresolvedRuntimeExceptionsPg(db, { runId: "run-exception-store" });
    assert.equal(afterResolve.length, 0);
    const resolvedResources = await listResourcesPg(db, { resourceType: "runtime_exception" });
    assert.equal(resolvedResources[0]?.status, "resolved");
    assert.equal(resolvedResources[0]?.payload.status, "resolved");
    assert.equal(resolvedResources[0]?.payload.resolvedAt, "2026-06-21T10:02:00.000Z");
    assert.equal(resolvedResources[0]?.payload.resolvedReason, "replacement attempt queued");
    const history = await listHistoryForRunPg(db, "run-exception-store");
    assert.deepEqual(history.map((event) => event.eventType), [
      "runtime_exception.observed",
      "runtime_exception.resolved",
    ]);
    assert.deepEqual(history.map((event) => event.actorType), ["orchestrator", "orchestrator"]);
  } finally {
    await db.close();
  }
});

test("runtime exception resolve is idempotent and preserves first resolution metadata", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-exception-resolve-idempotent"));
    const exception = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-resolve-idempotent",
      taskId: "task-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-resolve-idempotent:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_running_hang",
      severity: "recoverable",
      observedAt: "2026-06-21T11:00:00.000Z",
      evidenceRefs: ["hand-execution:run-exception-resolve-idempotent:task-a:attempt-1"],
    });

    await resolveRuntimeExceptionPg(db, {
      runId: "run-exception-resolve-idempotent",
      resourceKey: exception.resourceKey,
      resolvedAt: "2026-06-21T11:02:00.000Z",
      reason: "replacement hand execution accepted",
    });
    await resolveRuntimeExceptionPg(db, {
      runId: "run-exception-resolve-idempotent",
      resourceKey: exception.resourceKey,
      resolvedAt: "2026-06-21T11:04:00.000Z",
      reason: "late duplicate resolution",
    });

    const resources = await listResourcesPg(db, { resourceType: "runtime_exception" });
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.payload.resolvedAt, "2026-06-21T11:02:00.000Z");
    assert.equal(resources[0]?.payload.resolvedReason, "replacement hand execution accepted");
    const history = await listHistoryForRunPg(db, "run-exception-resolve-idempotent");
    assert.deepEqual(history.map((event) => event.eventType), [
      "runtime_exception.observed",
      "runtime_exception.resolved",
    ]);
  } finally {
    await db.close();
  }
});

test("runtime exception resolve locks workflow run before exception resource", async () => {
  const queries: string[] = [];
  const stopAfterExceptionLock = new Error("stop after exception lock");
  const db: SouthstarDb = {
    async query(sql) {
      queries.push(normalizeSql(sql));
      return { rows: [], rowCount: 0 };
    },
    async one() {
      throw new Error("unexpected one query");
    },
    async maybeOne(sql) {
      const normalized = normalizeSql(sql);
      queries.push(normalized);
      if (
        normalized.includes("from southstar.runtime_resources") &&
        normalized.includes("for update")
      ) {
        throw stopAfterExceptionLock;
      }
      return null;
    },
    async tx(fn) {
      return await fn(this);
    },
    async close() {},
  };

  await assert.rejects(
    () => resolveRuntimeExceptionPg(db, {
      runId: "run-exception-lock-order",
      resourceKey: "runtime_exception:run-exception-lock-order:hand:abc123",
      resolvedAt: "2026-06-21T11:05:00.000Z",
      reason: "operator resolved",
    }),
    stopAfterExceptionLock,
  );

  assert.equal(queries[0], "select id from southstar.workflow_runs where id = $1 for update");
  assert.equal(
    queries[1]?.includes("from southstar.runtime_resources") &&
      queries[1]?.includes("for update"),
    true,
  );
});

test("runtime exception idempotency key includes hand binding identity", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-exception-hand-binding"));
    const first = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-hand-binding",
      taskId: "task-a",
      attemptId: "attempt-1",
      handBindingId: "hand-binding-a",
      source: "tork-observer",
      kind: "provider_unreachable",
      severity: "recoverable",
      observedAt: "2026-06-21T12:00:00.000Z",
      evidenceRefs: ["hand-binding-a"],
    });
    const duplicate = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-hand-binding",
      taskId: "task-a",
      attemptId: "attempt-1",
      handBindingId: "hand-binding-a",
      source: "tork-observer",
      kind: "provider_unreachable",
      severity: "recoverable",
      observedAt: "2026-06-21T12:00:30.000Z",
      evidenceRefs: ["hand-binding-a"],
    });
    const secondHand = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-hand-binding",
      taskId: "task-a",
      attemptId: "attempt-1",
      handBindingId: "hand-binding-b",
      source: "tork-observer",
      kind: "provider_unreachable",
      severity: "recoverable",
      observedAt: "2026-06-21T12:01:00.000Z",
      evidenceRefs: ["hand-binding-b"],
    });

    assert.equal(duplicate.exceptionId, first.exceptionId);
    assert.notEqual(secondHand.exceptionId, first.exceptionId);
    const resources = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-exception-hand-binding");
    assert.equal(resources.length, 2);
  } finally {
    await db.close();
  }
});

test("runtime exception idempotency key includes brain binding identity", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-exception-brain-binding"));
    const first = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-brain-binding",
      taskId: "task-a",
      attemptId: "attempt-1",
      brainBindingId: "brain-binding-a",
      source: "scheduler",
      kind: "brain_wake_failed",
      severity: "recoverable",
      observedAt: "2026-06-21T12:30:00.000Z",
      evidenceRefs: ["brain-binding-a"],
    });
    const duplicate = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-brain-binding",
      taskId: "task-a",
      attemptId: "attempt-1",
      brainBindingId: "brain-binding-a",
      source: "scheduler",
      kind: "brain_wake_failed",
      severity: "recoverable",
      observedAt: "2026-06-21T12:30:30.000Z",
      evidenceRefs: ["brain-binding-a"],
    });
    const secondBrain = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-brain-binding",
      taskId: "task-a",
      attemptId: "attempt-1",
      brainBindingId: "brain-binding-b",
      source: "scheduler",
      kind: "brain_wake_failed",
      severity: "recoverable",
      observedAt: "2026-06-21T12:31:00.000Z",
      evidenceRefs: ["brain-binding-b"],
    });

    assert.equal(duplicate.exceptionId, first.exceptionId);
    assert.notEqual(secondBrain.exceptionId, first.exceptionId);
    const resources = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-exception-brain-binding");
    assert.equal(resources.length, 2);
  } finally {
    await db.close();
  }
});

test("runtime exception unresolved listing is run-scoped and excludes resolved resources", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-exception-list-a"));
    await createWorkflowRunPg(db, minimalRun("run-exception-list-b"));
    await recordRuntimeExceptionPg(db, {
      runId: "run-exception-list-a",
      taskId: "task-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-list-a:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T13:00:00.000Z",
      evidenceRefs: ["hand-execution:run-exception-list-a:task-a:attempt-1"],
    });
    const resolved = await recordRuntimeExceptionPg(db, {
      runId: "run-exception-list-b",
      taskId: "task-b",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-list-b:task-b:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T13:01:00.000Z",
      evidenceRefs: ["hand-execution:run-exception-list-b:task-b:attempt-1"],
    });
    await resolveRuntimeExceptionPg(db, {
      runId: "run-exception-list-b",
      resourceKey: resolved.resourceKey,
      resolvedAt: "2026-06-21T13:02:00.000Z",
      reason: "run b replacement queued",
    });

    const runA = await listUnresolvedRuntimeExceptionsPg(db, { runId: "run-exception-list-a" });
    const runB = await listUnresolvedRuntimeExceptionsPg(db, { runId: "run-exception-list-b" });
    assert.deepEqual(runA.map((exception) => exception.runId), ["run-exception-list-a"]);
    assert.equal(runB.length, 0);
  } finally {
    await db.close();
  }
});

test("runtime exception controller maps queue timeout to requeue-hand-execution decision", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-exception-controller",
      status: "running",
      domain: "software",
      goalPrompt: "recover queue timeout",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const controller = createRuntimeExceptionController({ db });

    const exception = await controller.observe({
      runId: "run-exception-controller",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-controller:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["hand-execution:run-exception-controller:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-timeout" },
    });
    const classification = await controller.classify(exception);
    const decision = await controller.decide(classification);

    assert.equal(classification.recoveryPath, "requeue-hand-execution");
    assert.equal(decision.payload.path, "requeue-hand-execution");
    assert.equal(decision.payload.exceptionId, exception.exceptionId);
    assert.equal(decision.payload.operatorApprovalRequired, false);
    assert.equal(decision.status, "recorded");
  } finally {
    await db.close();
  }
});

test("runtime exception controller requires operator approval for rollback decisions", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-exception-rollback",
      status: "running",
      domain: "software",
      goalPrompt: "recover hang",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: "run-exception-rollback",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-rollback:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_running_hang",
      severity: "recoverable",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["workspace-snapshot:dirty"],
      providerEvidence: { workspaceUnsafe: true },
    });
    const decision = await controller.decide(await controller.classify(exception));

    assert.equal(decision.payload.path, "rollback-workspace");
    assert.equal(decision.payload.operatorApprovalRequired, true);
  } finally {
    await db.close();
  }
});

test("runtime exception controller decision is idempotent for the same exception and path", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-exception-decision-idempotent"));
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId: "run-exception-decision-idempotent",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      handExecutionId: "hand-execution:run-exception-decision-idempotent:task-a:attempt-1",
      source: "tork-observer",
      kind: "tork_terminal_without_callback",
      severity: "recoverable",
      observedAt: "2026-06-21T10:00:00.000Z",
      evidenceRefs: ["hand-execution:run-exception-decision-idempotent:task-a:attempt-1"],
      providerEvidence: { externalJobId: "job-terminal" },
    });
    const classification = await controller.classify(exception);

    const first = await controller.decide(classification);
    const second = await controller.decide(classification);

    assert.equal(second.decisionId, first.decisionId);
    assert.equal(second.resourceKey, first.resourceKey);
    const history = await listHistoryForRunPg(db, "run-exception-decision-idempotent");
    assert.equal(
      history.filter((event) => event.eventType === "runtime_exception.recovery_decided").length,
      1,
    );
  } finally {
    await db.close();
  }
});

function minimalRun(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "harden runtime",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
