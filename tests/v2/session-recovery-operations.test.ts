import test from "node:test";
import assert from "node:assert/strict";
import { applySessionRecoveryOperationPg } from "../../src/v2/session-recovery/session-operations.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  listResourcesPg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("reset-session releases failed task with durable reset evidence and stable new root session", async () => {
  const db = await createTestPostgresDb();
  try {
    await createSessionRecoveryFixture(db);

    const result = await applySessionRecoveryOperationPg(db, {
      operationId: "session-op-reset-1",
      runId: "run-session-ops",
      taskId: "implement",
      path: "reset-session",
      approved: true,
      checkpointId: "checkpoint-base",
      reason: "reset after context assembly drift",
      now: "2026-06-22T08:00:00.000Z",
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.newRootSessionId, "root-run-session-ops-implement-reset-session-621dc3176c");

    const task = await db.one<{ status: string; completed_at: Date | null; root_session_id: string | null }>(
      "select status, completed_at, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      ["run-session-ops", "implement"],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.completed_at, null);
    assert.equal(task.root_session_id, result.newRootSessionId);

    const reset = await getResourceByKeyPg(db, "session_reset", "session_reset:session-op-reset-1");
    assert.equal(reset?.status, "succeeded");
    assert.equal((reset?.payload as { checkpointId?: string }).checkpointId, "checkpoint-base");
    assert.equal((reset?.payload as { previousRootSessionId?: string }).previousRootSessionId, "root-run-session-ops-implement-old");
    assert.equal((reset?.payload as { newRootSessionId?: string }).newRootSessionId, result.newRootSessionId);

    const history = await listHistoryForRunPg(db, "run-session-ops");
    const resetEvents = history.filter((event) => event.eventType === "session.reset");
    assert.equal(resetEvents.length, 1);
    assert.equal(resetEvents[0]?.sessionId, result.newRootSessionId);
  } finally {
    await db.close();
  }
});

test("rollback-session waits for approval without rollback marker or task mutation", async () => {
  const db = await createTestPostgresDb();
  try {
    await createSessionRecoveryFixture(db);

    const result = await applySessionRecoveryOperationPg(db, {
      operationId: "session-op-rollback-waiting",
      runId: "run-session-ops",
      taskId: "implement",
      path: "rollback-session",
      approved: false,
      checkpointId: "checkpoint-base",
      workspaceSnapshotRef: "workspace_snapshot:base",
      reason: "rollback needs operator approval",
      now: "2026-06-22T08:01:00.000Z",
    });

    assert.equal(result.status, "waiting_operator_approval");

    const task = await db.one<{ status: string; completed_at: Date | null; root_session_id: string | null }>(
      "select status, completed_at, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      ["run-session-ops", "implement"],
    );
    assert.equal(task.status, "failed");
    assert.ok(task.completed_at);
    assert.equal(task.root_session_id, "root-run-session-ops-implement-old");

    const markers = await listResourcesPg(db, { resourceType: "rollback_marker" });
    assert.equal(markers.length, 0);
  } finally {
    await db.close();
  }
});

test("fork-session releases failed task with durable fork evidence", async () => {
  const db = await createTestPostgresDb();
  try {
    await createSessionRecoveryFixture(db);

    const result = await applySessionRecoveryOperationPg(db, {
      operationId: "session-op-fork-1",
      runId: "run-session-ops",
      taskId: "implement",
      path: "fork-session",
      approved: true,
      checkpointId: "checkpoint-base",
      reason: "fork from stable checkpoint",
      now: "2026-06-22T08:02:00.000Z",
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.newRootSessionId ?? "", /^root-run-session-ops-implement-fork-session-/);

    const task = await db.one<{ status: string; completed_at: Date | null; root_session_id: string | null }>(
      "select status, completed_at, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      ["run-session-ops", "implement"],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.completed_at, null);
    assert.equal(task.root_session_id, result.newRootSessionId);

    const fork = await getResourceByKeyPg(db, "session_fork", "session_fork:session-op-fork-1");
    assert.equal(fork?.status, "succeeded");
    assert.equal((fork?.payload as { checkpointId?: string }).checkpointId, "checkpoint-base");

    const history = await listHistoryForRunPg(db, "run-session-ops");
    assert.equal(history.filter((event) => event.eventType === "session.fork").length, 1);
  } finally {
    await db.close();
  }
});

test("rollback-session requires workspace snapshot evidence and records rollback marker when approved", async () => {
  const db = await createTestPostgresDb();
  try {
    await createSessionRecoveryFixture(db);

    await assert.rejects(
      () => applySessionRecoveryOperationPg(db, {
        operationId: "session-op-rollback-missing-snapshot",
        runId: "run-session-ops",
        taskId: "implement",
        path: "rollback-session",
        approved: true,
        checkpointId: "checkpoint-base",
        reason: "rollback without snapshot evidence",
        now: "2026-06-22T08:02:00.000Z",
      }),
      /rollback-session requires workspaceSnapshotRef/,
    );

    const result = await applySessionRecoveryOperationPg(db, {
      operationId: "session-op-rollback-approved",
      runId: "run-session-ops",
      taskId: "implement",
      path: "rollback-session",
      approved: true,
      checkpointId: "checkpoint-base",
      workspaceSnapshotRef: "workspace_snapshot:base",
      invalidatedSourceRefs: ["artifact_ref:stale-result"],
      reason: "rollback to known good workspace",
      now: "2026-06-22T08:03:00.000Z",
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.newRootSessionId, "root-run-session-ops-implement-rollback-session-7ac9303815");

    const marker = await getResourceByKeyPg(db, "rollback_marker", "rollback_marker:session-op-rollback-approved");
    assert.equal(marker?.status, "recorded");
    assert.deepEqual(marker?.payload, {
      schemaVersion: "southstar.session_recovery.rollback_marker.v1",
      markerId: "rollback-marker-7ac9303815937bd3",
      operationId: "session-op-rollback-approved",
      runId: "run-session-ops",
      taskId: "implement",
      checkpointId: "checkpoint-base",
      workspaceSnapshotRef: "workspace_snapshot:base",
      invalidatedSourceRefs: ["artifact_ref:stale-result"],
      reason: "rollback to known good workspace",
      createdAt: "2026-06-22T08:03:00.000Z",
    });

    const task = await db.one<{ status: string; completed_at: Date | null; root_session_id: string | null }>(
      "select status, completed_at, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      ["run-session-ops", "implement"],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.completed_at, null);
    assert.equal(task.root_session_id, result.newRootSessionId);

    const rollback = await getResourceByKeyPg(db, "session_rollback", "session_rollback:session-op-rollback-approved");
    assert.equal(rollback?.status, "succeeded");
    assert.equal((rollback?.payload as { rollbackMarkerRef?: string }).rollbackMarkerRef, "rollback_marker:session-op-rollback-approved");

    const history = await listHistoryForRunPg(db, "run-session-ops");
    const rollbackEvents = history.filter((event) => event.eventType === "session.rollback");
    assert.equal(rollbackEvents.length, 1);
    assert.equal(rollbackEvents[0]?.sessionId, result.newRootSessionId);
    assert.deepEqual((rollbackEvents[0]?.payload as { rollbackMarkerRef?: string; invalidatedSourceRefs?: string[] }), {
      operationId: "session-op-rollback-approved",
      path: "rollback-session",
      runId: "run-session-ops",
      taskId: "implement",
      checkpointId: "checkpoint-base",
      previousRootSessionId: "root-run-session-ops-implement-old",
      newRootSessionId: result.newRootSessionId,
      workspaceSnapshotRef: "workspace_snapshot:base",
      rollbackMarkerRef: "rollback_marker:session-op-rollback-approved",
      invalidatedSourceRefs: ["artifact_ref:stale-result"],
      reason: "rollback to known good workspace",
      appliedAt: "2026-06-22T08:03:00.000Z",
    });
  } finally {
    await db.close();
  }
});

test("stale unapproved rollback replay does not downgrade succeeded rollback operation", async () => {
  const db = await createTestPostgresDb();
  try {
    await createSessionRecoveryFixture(db);

    const approved = await applySessionRecoveryOperationPg(db, {
      operationId: "session-op-rollback-replay",
      runId: "run-session-ops",
      taskId: "implement",
      path: "rollback-session",
      approved: true,
      checkpointId: "checkpoint-base",
      workspaceSnapshotRef: "workspace_snapshot:base",
      invalidatedSourceRefs: ["artifact_ref:stale-result"],
      reason: "rollback to known good workspace",
      now: "2026-06-22T08:04:00.000Z",
    });
    assert.equal(approved.status, "succeeded");

    const replay = await applySessionRecoveryOperationPg(db, {
      operationId: "session-op-rollback-replay",
      runId: "run-session-ops",
      taskId: "implement",
      path: "rollback-session",
      approved: false,
      checkpointId: "checkpoint-base",
      workspaceSnapshotRef: "workspace_snapshot:base",
      reason: "stale approval read",
      now: "2026-06-22T08:05:00.000Z",
    });

    assert.equal(replay.status, "succeeded");
    assert.equal(replay.newRootSessionId, approved.newRootSessionId);

    const rollback = await getResourceByKeyPg(db, "session_rollback", "session_rollback:session-op-rollback-replay");
    assert.equal(rollback?.status, "succeeded");
    assert.equal((rollback?.payload as { reason?: string }).reason, "rollback to known good workspace");

    const markers = await listResourcesPg(db, { resourceType: "rollback_marker" });
    assert.equal(markers.length, 1);
    const history = await listHistoryForRunPg(db, "run-session-ops");
    assert.equal(history.filter((event) => event.eventType === "session.rollback").length, 1);
  } finally {
    await db.close();
  }
});

async function createSessionRecoveryFixture(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<void> {
  await createWorkflowRunPg(db, {
    id: "run-session-ops",
    status: "running",
    domain: "software",
    goalPrompt: "recover failed session",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: "implement",
    runId: "run-session-ops",
    taskKey: "implement",
    status: "failed",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "root-run-session-ops-implement-old",
  });
  await db.query(
    "update southstar.workflow_tasks set completed_at = $1, updated_at = now() where run_id = $2 and id = $3",
    ["2026-06-22T07:59:00.000Z", "run-session-ops", "implement"],
  );
}
