import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import { createRecoveryDecisionApplier } from "../../src/v2/exceptions/recovery-decision-applier.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("requeue-hand-execution applies queue timeout recovery and is idempotent", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-apply-requeue";
    const taskId = "task-a";
    const sessionId = "session-a";
    const attemptId = "attempt-1";
    const handExecutionId = `hand-execution:${runId}:${taskId}:${attemptId}`;
    const now = "2026-06-21T12:00:00.000Z";

    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "apply queue timeout recovery",
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
      status: "queued",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: sessionId,
    });
    await upsertRuntimeResourcePg(db, {
      id: handExecutionId,
      resourceType: "hand_execution",
      resourceKey: handExecutionId,
      runId,
      taskId,
      sessionId,
      scope: "hand",
      status: "queued",
      title: "Hand execution task-a",
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId,
        providerId: "tork",
        runId,
        taskId,
        sessionId,
        attemptId,
        brainBindingId: "brain-binding-a",
        handBindingId: "hand-binding-a",
        externalJobId: "job-queued",
        status: "queued",
        queuedAt: "2026-06-21T11:50:00.000Z",
        queueTimeoutSeconds: 300,
        heartbeatTimeoutSeconds: 300,
      },
      summary: { providerId: "tork", attemptId },
      metrics: {},
    });

    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId,
      attemptId,
      handExecutionId,
      source: "tork-observer",
      kind: "tork_queue_timeout",
      severity: "recoverable",
      observedAt: "2026-06-21T11:59:00.000Z",
      evidenceRefs: [handExecutionId],
      providerEvidence: { externalJobId: "job-queued" },
    });
    const decision = await controller.decide(await controller.classify(exception));

    const applier = createRecoveryDecisionApplier({ db });
    const first = await applier.applyDecision({ decisionResourceKey: decision.resourceKey, now });
    const second = await applier.applyDecision({ decisionResourceKey: decision.resourceKey, now });

    assert.equal(first.status, "applied");
    assert.equal(second.status, "applied");
    assert.equal(second.executionResourceKey, first.executionResourceKey);

    const hand = await getResourceByKeyPg(db, "hand_execution", handExecutionId);
    assert.equal(hand?.status, "lost");
    assert.equal((hand?.payload as { status?: string }).status, "lost");

    const task = await db.one<{ status: string; completed_at: Date | null }>(
      "select status, completed_at from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.completed_at, null);

    const appliedDecision = await getResourceByKeyPg(db, "recovery_decision", decision.resourceKey);
    assert.equal(appliedDecision?.status, "applied");
    const resolvedException = await getResourceByKeyPg(db, "runtime_exception", exception.resourceKey);
    assert.equal(resolvedException?.status, "resolved");

    const recoveryExecutions = await listResourcesPg(db, { resourceType: "recovery_execution" });
    assert.equal(recoveryExecutions.filter((resource) => resource.runId === runId).length, 1);
    const recoveryExecution = recoveryExecutions.find((resource) => resource.runId === runId);
    assert.equal(recoveryExecution?.status, "succeeded");
    assert.deepEqual(
      (recoveryExecution?.payload as { stateChanges: Array<{ toStatus?: string }> }).stateChanges.map((change) => change.toStatus),
      ["lost", "pending", "applied", "resolved"],
    );

    const historyTypes = (await listHistoryForRunPg(db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.includes("recovery_execution.started"), true);
    assert.equal(historyTypes.includes("recovery_execution.succeeded"), true);
    assert.equal(historyTypes.includes("runtime_exception.resolved"), true);
  } finally {
    await db.close();
  }
});
