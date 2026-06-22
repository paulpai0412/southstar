import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E as createPostgresRealHarness } from "../postgres-real-harness.ts";
import { observeTorkHandExecutionExceptionsPg } from "../../../src/v2/executor/tork-observer.ts";
import { createRecoveryDecisionApplier } from "../../../src/v2/exceptions/recovery-decision-applier.ts";
import { getResourceByKeyPg, listHistoryForRunPg, listResourcesPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  canonicalHandExecutionId,
  seedHandExecution,
  seedHardeningRunTask,
} from "../runtime-hardening-fixtures.ts";

test("21 recovery decision apply requeue releases queued task and resolves exception", async () => {
  const harness = await createPostgresRealHarness();
  const runId = "real-recovery-apply-requeue";
  const taskId = "task-a";
  const attemptId = "attempt-1";
  const handExecutionId = canonicalHandExecutionId(runId, taskId, attemptId);
  const now = "2026-06-21T12:00:00.000Z";
  try {
    await seedHardeningRunTask(harness.db, { runId, taskId, runStatus: "running", taskStatus: "running" });
    await seedHandExecution(harness.db, {
      runId,
      taskId,
      attemptId,
      status: "queued",
      queuedAt: "2026-06-21T11:58:00.000Z",
      externalJobId: "job-queued-apply-requeue",
      queueTimeoutSeconds: 30,
    });

    const observed = await observeTorkHandExecutionExceptionsPg(harness.db, { now });
    assert.deepEqual(observed.observedKinds, ["tork_queue_timeout"]);

    const decision = (await listResourcesPg(harness.db, { resourceType: "recovery_decision" }))[0];
    assert.equal(decision?.status, "recorded");
    assert.equal(decision.payload.path, "requeue-hand-execution");

    const result = await createRecoveryDecisionApplier({ db: harness.db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: "2026-06-21T12:01:00.000Z",
    });

    assert.equal(result.status, "applied");
    const task = await harness.db.one<{ status: string; completed_at: Date | null }>(
      "select status, completed_at from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.completed_at, null);

    const hand = await getResourceByKeyPg(harness.db, "hand_execution", handExecutionId);
    assert.equal(hand?.status, "lost");
    assert.equal(hand?.payload.status, "lost");
    assert.equal(hand?.payload.lostReason, "requeue-hand-execution");

    const exception = (await listResourcesPg(harness.db, { resourceType: "runtime_exception" }))[0];
    assert.equal(exception?.status, "resolved");
    assert.equal(exception.payload.resolvedReason, "requeue-hand-execution applied");

    const appliedDecision = await getResourceByKeyPg(harness.db, "recovery_decision", decision.resourceKey);
    assert.equal(appliedDecision?.status, "applied");
    assert.equal(appliedDecision?.payload.appliedAt, "2026-06-21T12:01:00.000Z");

    const execution = await getResourceByKeyPg(harness.db, "recovery_execution", result.executionResourceKey ?? "");
    assert.equal(execution?.status, "succeeded");
    const executionPayload = execution?.payload as {
      stateChanges: Array<{ resourceType: string; toStatus?: string; reason: string }>;
      providerActions: Array<{ providerId?: string; action?: string; status?: string; evidenceRef?: string }>;
    };
    assert.deepEqual(executionPayload.stateChanges.map((change) => [change.resourceType, change.toStatus, change.reason]), [
      ["hand_execution", "lost", "requeue-hand-execution"],
      ["workflow_task", "pending", "requeue-hand-execution"],
      ["recovery_decision", "applied", "requeue-hand-execution applied"],
      ["runtime_exception", "resolved", "requeue-hand-execution applied"],
    ]);
    assert.deepEqual(executionPayload.providerActions, [{
      providerId: "tork",
      action: "cancel",
      status: "skipped",
      evidenceRef: handExecutionId,
    }]);

    const historyTypes = (await listHistoryForRunPg(harness.db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.includes("runtime_exception.resolved"), true);
    assert.equal(historyTypes.includes("recovery_execution.succeeded"), true);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_decision.applied").length, 1);
  } finally {
    await harness.close();
  }
});
