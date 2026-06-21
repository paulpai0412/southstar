import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  completeRecoveryExecutionPg,
  startRecoveryExecutionPg,
} from "../../src/v2/exceptions/recovery-executions.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("recovery execution store records idempotent started and succeeded evidence", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-recovery-execution-store",
      status: "running",
      domain: "software",
      goalPrompt: "apply recovery decision",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId: "run-recovery-execution-store",
      taskKey: "task-a",
      status: "queued",
      sortOrder: 0,
      dependsOn: [],
    });

    const started = await startRecoveryExecutionPg(db, {
      decisionId: "decision-a",
      exceptionId: "exception-a",
      runId: "run-recovery-execution-store",
      taskId: "task-a",
      path: "requeue-hand-execution",
      now: "2026-06-21T11:00:00.000Z",
    });
    const duplicate = await startRecoveryExecutionPg(db, {
      decisionId: "decision-a",
      exceptionId: "exception-a",
      runId: "run-recovery-execution-store",
      taskId: "task-a",
      path: "requeue-hand-execution",
      now: "2026-06-21T11:00:30.000Z",
    });

    assert.equal(duplicate.executionId, started.executionId);
    assert.equal(duplicate.resourceKey, started.resourceKey);

    await assert.rejects(
      startRecoveryExecutionPg(db, {
        decisionId: "decision-a",
        exceptionId: "exception-b",
        runId: "run-recovery-execution-store",
        taskId: "task-a",
        path: "requeue-hand-execution",
        now: "2026-06-21T11:00:45.000Z",
      }),
      /recovery execution recovery_execution:decision-a:attempt-1 conflicts with requested start input/,
    );

    const completed = await completeRecoveryExecutionPg(db, {
      runId: "run-recovery-execution-store",
      executionResourceKey: started.resourceKey,
      status: "succeeded",
      completedAt: "2026-06-21T11:01:00.000Z",
      stateChanges: [
        {
          resourceType: "hand_execution",
          resourceKey: "hand-execution:run-recovery-execution-store:task-a:attempt-1",
          fromStatus: "queued",
          toStatus: "lost",
          reason: "queue timeout requeue",
        },
      ],
      providerActions: [
        {
          providerId: "tork",
          action: "cancel",
          status: "skipped",
          evidenceRef: "hand-execution:run-recovery-execution-store:task-a:attempt-1",
        },
      ],
    });

    assert.equal(completed.status, "succeeded");
    assert.equal(completed.payload.status, "succeeded");
    assert.equal(completed.payload.stateChanges.length, 1);
    assert.equal(completed.payload.providerActions.length, 1);

    const duplicateComplete = await completeRecoveryExecutionPg(db, {
      runId: "run-recovery-execution-store",
      executionResourceKey: started.resourceKey,
      status: "failed",
      completedAt: "2026-06-21T11:02:00.000Z",
      stateChanges: [],
      providerActions: [],
    });

    assert.deepEqual(duplicateComplete, completed);

    await createWorkflowRunPg(db, {
      id: "run-recovery-execution-other",
      status: "running",
      domain: "software",
      goalPrompt: "apply recovery decision elsewhere",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await assert.rejects(
      completeRecoveryExecutionPg(db, {
        runId: "run-recovery-execution-other",
        executionResourceKey: started.resourceKey,
        status: "failed",
        completedAt: "2026-06-21T11:03:00.000Z",
        stateChanges: [],
        providerActions: [],
      }),
      /recovery execution recovery_execution:decision-a:attempt-1 does not belong to run run-recovery-execution-other/,
    );

    const resources = await listResourcesPg(db, { resourceType: "recovery_execution" });
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.status, "succeeded");
    assert.equal(resources[0]?.payload.schemaVersion, "southstar.runtime.recovery_execution.v1");

    const history = await listHistoryForRunPg(db, "run-recovery-execution-store");
    assert.deepEqual(history.map((event) => event.eventType), [
      "recovery_execution.started",
      "recovery_execution.succeeded",
    ]);
  } finally {
    await db.close();
  }
});
