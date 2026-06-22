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

test("24 provider unreachable apply failure records redacted action evidence and releases task", async () => {
  const harness = await createPostgresRealHarness();
  const runId = "real-provider-unreachable-apply-failure";
  const taskId = "task-a";
  const attemptId = "attempt-1";
  const handExecutionId = canonicalHandExecutionId(runId, taskId, attemptId);
  const concealedSecret = "secret=abc123";
  const concealedToken = "token=secret-value";
  try {
    await seedHardeningRunTask(harness.db, { runId, taskId, runStatus: "running", taskStatus: "running" });
    await seedHandExecution(harness.db, {
      runId,
      taskId,
      attemptId,
      status: "queued",
      queuedAt: "2026-06-21T14:58:00.000Z",
      externalJobId: "job-unreachable-cancel",
      queueTimeoutSeconds: 30,
    });

    const observed = await observeTorkHandExecutionExceptionsPg(harness.db, { now: "2026-06-21T15:00:00.000Z" });
    assert.deepEqual(observed.observedKinds, ["tork_queue_timeout"]);
    const decision = (await listResourcesPg(harness.db, { resourceType: "recovery_decision" }))[0];
    assert.equal(decision?.payload.path, "requeue-hand-execution");

    const result = await createRecoveryDecisionApplier({
      db: harness.db,
      providerActions: {
        async cancel() {
          throw new Error(`Tork cancel endpoint unreachable: ${concealedSecret} ${concealedToken}`);
        },
      },
    }).applyDecision({ decisionResourceKey: decision.resourceKey, now: "2026-06-21T15:01:00.000Z" });

    assert.equal(result.status, "applied");
    const task = await harness.db.one<{ status: string; completed_at: Date | null }>(
      "select status, completed_at from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.completed_at, null);
    assert.equal((await getResourceByKeyPg(harness.db, "hand_execution", handExecutionId))?.status, "lost");
    assert.equal((await getResourceByKeyPg(harness.db, "recovery_decision", decision.resourceKey))?.status, "applied");

    const execution = await getResourceByKeyPg(harness.db, "recovery_execution", result.executionResourceKey ?? "");
    assert.equal(execution?.status, "succeeded");
    const serializedPayload = JSON.stringify(execution?.payload);
    assert.equal(serializedPayload.includes(concealedSecret), false);
    assert.equal(serializedPayload.includes(concealedToken), false);
    assert.equal(serializedPayload.includes("[REDACTED]"), true);

    const executionPayload = execution?.payload as {
      providerActions: Array<{ action?: string; status?: string; errorExcerpt?: string; evidenceRef?: string }>;
      stateChanges: Array<{ resourceType: string; toStatus?: string }>;
    };
    const cancelAction = executionPayload.providerActions.find((action) => action.action === "cancel");
    assert.equal(cancelAction?.status, "failed");
    assert.equal(cancelAction?.evidenceRef, handExecutionId);
    assert.equal(cancelAction?.errorExcerpt?.includes(concealedSecret), false);
    assert.equal(cancelAction?.errorExcerpt?.includes(concealedToken), false);
    assert.equal(cancelAction?.errorExcerpt?.includes("[REDACTED]"), true);
    assert.deepEqual(executionPayload.stateChanges.map((change) => [change.resourceType, change.toStatus]), [
      ["hand_execution", "lost"],
      ["workflow_task", "pending"],
      ["recovery_decision", "applied"],
      ["runtime_exception", "resolved"],
    ]);

    const historyTypes = (await listHistoryForRunPg(harness.db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.includes("runtime_exception.resolved"), true);
    assert.equal(historyTypes.includes("recovery_execution.succeeded"), true);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_decision.applied").length, 1);
  } finally {
    await harness.close();
  }
});
