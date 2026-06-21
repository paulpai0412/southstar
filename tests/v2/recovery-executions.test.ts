import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
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

    assert.deepEqual(duplicateComplete, completed);

    await assert.rejects(
      completeRecoveryExecutionPg(db, {
        runId: "run-recovery-execution-store",
        executionResourceKey: started.resourceKey,
        status: "failed",
        completedAt: "2026-06-21T11:02:00.000Z",
        stateChanges: [],
        providerActions: [],
      }),
      /already completed with a different result/,
    );

    await assert.rejects(
      completeRecoveryExecutionPg(db, {
        runId: "run-recovery-execution-store",
        executionResourceKey: started.resourceKey,
        status: "succeeded",
        completedAt: "2026-06-21T11:01:00.000Z",
        stateChanges: [
          {
            resourceType: "hand_execution",
            resourceKey: "hand-execution:run-recovery-execution-store:task-a:attempt-1",
            fromStatus: "queued",
            toStatus: "failed",
            reason: "different terminal state",
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
      }),
      /already completed with a different result/,
    );

    await assert.rejects(
      completeRecoveryExecutionPg(db, {
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
            status: "completed",
            evidenceRef: "hand-execution:run-recovery-execution-store:task-a:attempt-1",
          },
        ],
      }),
      /already completed with a different result/,
    );

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

test("recovery execution store rejects malformed canonical status rows", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-recovery-execution-malformed",
      status: "running",
      domain: "software",
      goalPrompt: "complete malformed recovery execution",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId: "run-recovery-execution-malformed",
      taskKey: "task-a",
      status: "queued",
      sortOrder: 0,
      dependsOn: [],
    });

    await upsertRuntimeResourcePg(db, {
      id: "recovery-execution-malformed",
      resourceType: "recovery_execution",
      resourceKey: "recovery_execution:decision-malformed:attempt-1",
      runId: "run-recovery-execution-malformed",
      taskId: "task-a",
      scope: "recovery",
      status: "submitted",
      title: "Malformed recovery execution",
      payload: {
        schemaVersion: "southstar.runtime.recovery_execution.v1",
        executionId: "recovery-execution-malformed",
        decisionId: "decision-malformed",
        exceptionId: "exception-malformed",
        runId: "run-recovery-execution-malformed",
        taskId: "task-a",
        path: "retry-same-task-new-attempt",
        status: "submitted",
        stateChanges: [],
        providerActions: [],
        createdAt: "2026-06-21T11:00:00.000Z",
      },
      summary: {},
    });

    await assert.rejects(
      completeRecoveryExecutionPg(db, {
        runId: "run-recovery-execution-malformed",
        executionResourceKey: "recovery_execution:decision-malformed:attempt-1",
        status: "failed",
        completedAt: "2026-06-21T11:01:00.000Z",
        stateChanges: [],
        providerActions: [],
      }),
      /recovery execution not found/,
    );
  } finally {
    await db.close();
  }
});

test("complete recovery execution rejects invalid provider action status on first completion", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-recovery-execution-invalid-provider-status",
      status: "running",
      domain: "software",
      goalPrompt: "reject invalid recovery execution provider status",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const started = await startRecoveryExecutionPg(db, {
      decisionId: "decision-invalid-provider-status",
      exceptionId: "exception-invalid-provider-status",
      runId: "run-recovery-execution-invalid-provider-status",
      path: "requeue-hand-execution",
      now: "2026-06-21T11:00:00.000Z",
    });

    await assert.rejects(
      completeRecoveryExecutionPg(db, {
        runId: "run-recovery-execution-invalid-provider-status",
        executionResourceKey: started.resourceKey,
        status: "succeeded",
        completedAt: "2026-06-21T11:01:00.000Z",
        stateChanges: [],
        providerActions: [
          {
            providerId: "tork",
            action: "cancel",
            status: "completed" as any,
          },
        ],
      }),
      /invalid recovery execution provider action/,
    );
  } finally {
    await db.close();
  }
});

test("complete recovery execution rejects invalid provider action name on first completion", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-recovery-execution-invalid-provider-action",
      status: "running",
      domain: "software",
      goalPrompt: "reject invalid recovery execution provider action",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const started = await startRecoveryExecutionPg(db, {
      decisionId: "decision-invalid-provider-action",
      exceptionId: "exception-invalid-provider-action",
      runId: "run-recovery-execution-invalid-provider-action",
      path: "requeue-hand-execution",
      now: "2026-06-21T11:00:00.000Z",
    });

    await assert.rejects(
      completeRecoveryExecutionPg(db, {
        runId: "run-recovery-execution-invalid-provider-action",
        executionResourceKey: started.resourceKey,
        status: "succeeded",
        completedAt: "2026-06-21T11:01:00.000Z",
        stateChanges: [],
        providerActions: [
          {
            providerId: "tork",
            action: "submit" as any,
            status: "requested",
          },
        ],
      }),
      /invalid recovery execution provider action/,
    );
  } finally {
    await db.close();
  }
});

test("complete recovery execution rejects started as a terminal status at runtime", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-recovery-execution-started-terminal",
      status: "running",
      domain: "software",
      goalPrompt: "reject invalid terminal recovery execution status",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const started = await startRecoveryExecutionPg(db, {
      decisionId: "decision-started-terminal",
      exceptionId: "exception-started-terminal",
      runId: "run-recovery-execution-started-terminal",
      path: "none-observe-only",
      now: "2026-06-21T11:00:00.000Z",
    });

    await assert.rejects(
      completeRecoveryExecutionPg(db, {
        runId: "run-recovery-execution-started-terminal",
        executionResourceKey: started.resourceKey,
        status: "started" as any,
        completedAt: "2026-06-21T11:01:00.000Z",
        stateChanges: [],
        providerActions: [],
      }),
      /terminal recovery execution status/,
    );
  } finally {
    await db.close();
  }
});

test("start recovery execution rejects task ids that do not belong to the run", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-recovery-execution-missing-task",
      status: "running",
      domain: "software",
      goalPrompt: "reject recovery execution task from outside run",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    await assert.rejects(
      startRecoveryExecutionPg(db, {
        decisionId: "decision-missing-task",
        exceptionId: "exception-missing-task",
        runId: "run-recovery-execution-missing-task",
        taskId: "missing-task",
        path: "requeue-hand-execution",
        now: "2026-06-21T11:00:00.000Z",
      }),
      /workflow task missing-task does not belong to run run-recovery-execution-missing-task/,
    );
  } finally {
    await db.close();
  }
});
