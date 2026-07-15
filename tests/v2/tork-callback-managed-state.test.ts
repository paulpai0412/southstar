import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
import { createExecutorBindingPg, getExecutorBindingPg, updateExecutorBindingStatusPg } from "../../src/v2/executor/postgres-bindings.ts";
import { ingestTaskRunResultPg } from "../../src/v2/executor/postgres-tork-callback.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { createGitWorkspaceSnapshotProvider } from "../../src/v2/workspace/git-provider.ts";

test("callback completes current hand execution and writes accepted artifact_ref", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-callback-managed", taskId: "task-a", runStatus: "running", taskStatus: "running" });
    await seedExecutorBinding(db, { runId: "run-callback-managed", taskId: "task-a", attemptId: "attempt-1", status: "running" });
    await seedHandExecution(db, {
      runId: "run-callback-managed",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "running",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-a",
    });

    await ingestTaskRunResultPg(db, {
      runId: "run-callback-managed",
      taskId: "task-a",
      rootSessionId: "session-a",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "done" },
      metrics: { tokens: 12 },
      events: [],
      receivedAt: "2026-06-20T08:03:00.000Z",
    });

    const handExecution = await getHandExecution(db, "run-callback-managed", "task-a", "attempt-1");
    assert.equal(handExecution.status, "completed");
    const payload = asRecord(handExecution.payload);
    assert.equal(payload.schemaVersion, "southstar.runtime.hand_execution.v1");
    assert.equal(payload.handExecutionId, "hand-execution:run-callback-managed:task-a:attempt-1");
    assert.equal(payload.providerId, "tork");
    assert.equal(payload.runId, "run-callback-managed");
    assert.equal(payload.taskId, "task-a");
    assert.equal(payload.sessionId, "session-a");
    assert.equal(payload.attemptId, "attempt-1");
    assert.equal(payload.status, "completed");
    assert.equal(payload.terminalAt, "2026-06-20T08:03:00.000Z");
    assert.equal(payload.queuedAt, "2026-06-20T08:00:00.000Z");
    assert.equal(payload.brainBindingId, "brain-binding-run-callback-managed-task-a");
    assert.equal(payload.handBindingId, "hand-binding-run-callback-managed-task-a");
    assert.equal(payload.externalJobId, "job-a");
    assert.equal(payload.queueTimeoutSeconds, 120);
    assert.equal(payload.heartbeatTimeoutSeconds, 30);

    const artifactRefs = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
    assert.equal(artifactRefs.length, 1);
    assert.equal(artifactRefs[0]?.status, "accepted");
    const artifactPayload = asRecord(artifactRefs[0]?.payload);
    assert.equal(artifactPayload.handExecutionId, "hand-execution:run-callback-managed:task-a:attempt-1");
    assert.deepEqual(artifactPayload.producer, { actorType: "hand", providerId: "tork" });
    assert.equal((artifactPayload.sourceEventRefs as string[]).length, 1);
    assert.match(
      (artifactPayload.sourceEventRefs as string[])[0]!,
      /^hand-execution:run-callback-managed:task-a:attempt-1:callback:[a-f0-9]{64}$/,
    );

    const duplicate = await ingestTaskRunResultPg(db, {
      runId: "run-callback-managed",
      taskId: "task-a",
      rootSessionId: "session-a",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "done" },
      metrics: { tokens: 12 },
      events: [],
      receivedAt: "2026-06-20T08:03:30.000Z",
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.artifactRefId, artifactRefs[0]?.resourceKey);
    const afterDuplicateArtifactRefs = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
    assert.equal(afterDuplicateArtifactRefs.length, 1);
  });
});

test("callback failure marks hand_execution failed and writes rejected artifact_ref", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-callback-managed-fail", taskId: "task-a", runStatus: "running", taskStatus: "running" });
    await seedExecutorBinding(db, { runId: "run-callback-managed-fail", taskId: "task-a", attemptId: "attempt-1", status: "running" });
    await seedHandExecution(db, {
      runId: "run-callback-managed-fail",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "running",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-fail",
    });

    await ingestTaskRunResultPg(db, {
      runId: "run-callback-managed-fail",
      taskId: "task-a",
      rootSessionId: "session-a",
      ok: false,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "tests failed" },
      metrics: { tokens: 12 },
      events: [],
      receivedAt: "2026-06-20T08:04:00.000Z",
    });

    const handExecution = await getHandExecution(db, "run-callback-managed-fail", "task-a", "attempt-1");
    assert.equal(handExecution.status, "failed");
    const payload = asRecord(handExecution.payload);
    assert.equal(payload.status, "failed");
    assert.equal(payload.terminalAt, "2026-06-20T08:04:00.000Z");
    assert.equal(payload.externalJobId, "job-fail");

    const artifactRefs = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
    assert.equal(artifactRefs.length, 1);
    assert.equal(artifactRefs[0]?.status, "rejected");
    const artifactPayload = asRecord(artifactRefs[0]?.payload);
    assert.equal(artifactPayload.handExecutionId, "hand-execution:run-callback-managed-fail:task-a:attempt-1");
  });
});

test("callback preserves a conflicting worktree and blocks the task for operator handling", async () => {
  await withDb(async (db) => {
    const repo = mkdtempSync(join(tmpdir(), "southstar-callback-workspace-conflict-"));
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "southstar@example.local"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Southstar"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
    const provider = createGitWorkspaceSnapshotProvider();
    const snapshot = provider.snapshot({ repoRoot: repo, reason: "parallel task" });
    const fork = provider.fork({ repoRoot: repo, snapshotRef: snapshot, worktreeName: "callback-conflict" });
    writeFileSync(join(fork.worktreePath, "README.md"), "task\n");
    writeFileSync(join(repo, "README.md"), "base change\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base change"], { cwd: repo });

    try {
      await seedRunTask(db, {
        runId: "run-callback-workspace-conflict",
        taskId: "task-a",
        runStatus: "running",
        taskStatus: "running",
        runtimeContextJson: { workspaceMergeRetryLimit: 1 },
      });
      await seedExecutorBinding(db, { runId: "run-callback-workspace-conflict", taskId: "task-a", attemptId: "attempt-1", status: "running" });
      await seedHandExecution(db, {
        runId: "run-callback-workspace-conflict",
        taskId: "task-a",
        sessionId: "session-a",
        attemptId: "attempt-1",
        status: "running",
        queuedAt: "2026-06-20T08:00:00.000Z",
        externalJobId: "job-conflict",
      });
      await upsertRuntimeResourcePg(db, {
        id: "workspace-allocation-conflict",
        resourceType: "workspace_allocation",
        resourceKey: "workspace-allocation-conflict",
        runId: "run-callback-workspace-conflict",
        taskId: "task-a",
        sessionId: "session-a",
        scope: "workspace",
        status: "allocated",
        title: "Git worktree for task-a",
        payload: {
          schemaVersion: "southstar.workspace_allocation.v1",
          provider: "git_worktree",
          repoRoot: repo,
          worktreePath: fork.worktreePath,
          baseSnapshot: snapshot,
          allocatedAt: "2026-06-20T08:00:00.000Z",
        },
        summary: { provider: "git_worktree", repoRoot: repo, worktreePath: fork.worktreePath },
      });

      const result = await ingestTaskRunResultPg(db, {
        runId: "run-callback-workspace-conflict",
        taskId: "task-a",
        rootSessionId: "session-a",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", summary: "done" },
        metrics: {},
        events: [],
        receivedAt: "2026-06-20T08:03:00.000Z",
      });

      assert.equal(result.accepted, true);
      assert.equal(result.blocked, true);
      assert.equal(result.workspaceConflict?.resourceKey, "workspace-allocation-conflict");
      assert.equal(result.workspaceConflict?.worktreePath, fork.worktreePath);
      const task = await db.one<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1 and id = $2", ["run-callback-workspace-conflict", "task-a"]);
      assert.equal(task.status, "blocked");
      const allocation = await getResourceByKeyPg(db, "workspace_allocation", "workspace-allocation-conflict");
      assert.equal(allocation?.status, "merge_conflict");
      assert.equal(asRecord(allocation?.payload).worktreePreserved, true);
      assert.equal(asRecord(allocation?.payload).mergeRetryLimit, 1);
      assert.equal(asRecord(allocation?.payload).mergeAttempts, 2);
      const exception = await db.one<{ status: string; payload_json: unknown }>(
        "select status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'runtime_exception'",
        ["run-callback-workspace-conflict"],
      );
      assert.equal(exception.status, "observed");
      assert.equal(asRecord(exception.payload_json).kind, "workspace_merge_conflict");
      assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "base change\n");
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", fork.worktreePath], { cwd: repo });
    }
  });
});

test("heartbeat marks hand_execution running and advances task and run statuses", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-heartbeat-managed", taskId: "task-a", runStatus: "scheduling", taskStatus: "queued" });
    await seedExecutorBinding(db, { runId: "run-heartbeat-managed", taskId: "task-a", attemptId: "attempt-1", status: "queued" });
    await seedHandExecution(db, {
      runId: "run-heartbeat-managed",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "queued",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-heartbeat",
    });
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await post(server.url, "/api/v2/executor/heartbeat", {
        runId: "run-heartbeat-managed",
        taskId: "task-a",
        sessionId: "session-a",
        attemptId: "attempt-1",
        observedAt: "2026-06-20T08:01:00.000Z",
        heartbeatSeq: 7,
        phase: "running",
        message: "started",
      });

      assert.equal(response.result.status, "running");
      const binding = await getExecutorBindingPg(db, "executor-run-heartbeat-managed-task-a-attempt-1");
      assert.equal(binding?.status, "running");
      assert.equal(binding?.payload.lastHeartbeatAt, "2026-06-20T08:01:00.000Z");
      assert.equal(binding?.payload.heartbeatSeq, 7);

      const handExecution = await getHandExecution(db, "run-heartbeat-managed", "task-a", "attempt-1");
      assert.equal(handExecution.status, "running");
      const payload = asRecord(handExecution.payload);
      assert.equal(payload.status, "running");
      assert.equal(payload.startedAt, "2026-06-20T08:01:00.000Z");
      assert.equal(payload.lastHeartbeatAt, "2026-06-20T08:01:00.000Z");
      assert.equal(payload.heartbeatSeq, 7);
      assert.equal(payload.queuedAt, "2026-06-20T08:00:00.000Z");
      assert.equal(payload.externalJobId, "job-heartbeat");

      const task = await db.one<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1 and id = $2", ["run-heartbeat-managed", "task-a"]);
      assert.equal(task.status, "running");
      const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", ["run-heartbeat-managed"]);
      assert.equal(run.status, "running");
    } finally {
      await server.close();
    }
  });
});

test("heartbeat uses hand_execution as primary when no legacy executor_binding exists", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-heartbeat-native", taskId: "task-a", runStatus: "scheduling", taskStatus: "queued" });
    await seedHandExecution(db, {
      runId: "run-heartbeat-native",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "queued",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-native",
    });
    const server = await createTestServer(db);
    try {
      const response = await post(server.url, "/api/v2/executor/heartbeat", {
        runId: "run-heartbeat-native",
        taskId: "task-a",
        sessionId: "session-a",
        attemptId: "attempt-1",
        observedAt: "2026-06-20T08:01:00.000Z",
        heartbeatSeq: 1,
        phase: "running",
      });

      assert.equal(response.result.status, "running");
      assert.equal(await getExecutorBindingPg(db, "executor-run-heartbeat-native-task-a-attempt-1"), null);
      const handExecution = await getHandExecution(db, "run-heartbeat-native", "task-a", "attempt-1");
      assert.equal(handExecution.status, "running");
      assert.equal(asRecord(handExecution.payload).startedAt, "2026-06-20T08:01:00.000Z");
      const task = await db.one<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1 and id = $2", ["run-heartbeat-native", "task-a"]);
      assert.equal(task.status, "running");
      const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", ["run-heartbeat-native"]);
      assert.equal(run.status, "running");
    } finally {
      await server.close();
    }
  });
});

test("heartbeat falls back to legacy executor_binding when managed hand_execution is missing", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-heartbeat-missing-hand", taskId: "task-a", runStatus: "scheduling", taskStatus: "queued" });
    await seedExecutorBinding(db, { runId: "run-heartbeat-missing-hand", taskId: "task-a", attemptId: "attempt-1", status: "queued" });
    const server = await createTestServer(db);
    try {
      const response = await post(server.url, "/api/v2/executor/heartbeat", {
        runId: "run-heartbeat-missing-hand",
        taskId: "task-a",
        sessionId: "session-a",
        attemptId: "attempt-1",
        observedAt: "2026-06-20T08:01:00.000Z",
        heartbeatSeq: 1,
        phase: "running",
      });

      assert.equal(response.result.status, "running");
      const binding = await getExecutorBindingPg(db, "executor-run-heartbeat-missing-hand-task-a-attempt-1");
      assert.equal(binding?.status, "running");
      assert.equal(binding?.payload.lastHeartbeatAt, "2026-06-20T08:01:00.000Z");
      const handExecution = await getResourceByKeyPg(db, "hand_execution", "hand-execution:run-heartbeat-missing-hand:task-a:attempt-1");
      assert.equal(handExecution, null);
    } finally {
      await server.close();
    }
  });
});

test("heartbeat does not create partial hand_execution when no managed or legacy resource exists", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-heartbeat-missing-resource", taskId: "task-a", runStatus: "scheduling", taskStatus: "queued" });
    const server = await createTestServer(db);
    try {
      await assert.rejects(
        () => post(server.url, "/api/v2/executor/heartbeat", {
          runId: "run-heartbeat-missing-resource",
          taskId: "task-a",
          sessionId: "session-a",
          attemptId: "attempt-1",
          observedAt: "2026-06-20T08:01:00.000Z",
          heartbeatSeq: 1,
          phase: "running",
        }),
        /managed hand execution not found/,
      );
      const handExecution = await getResourceByKeyPg(db, "hand_execution", "hand-execution:run-heartbeat-missing-resource:task-a:attempt-1");
      assert.equal(handExecution, null);
    } finally {
      await server.close();
    }
  });
});

test("late heartbeat does not reopen completed hand_execution", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-heartbeat-terminal", taskId: "task-a", runStatus: "running", taskStatus: "running" });
    await seedHandExecution(db, {
      runId: "run-heartbeat-terminal",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "running",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-terminal",
    });
    await ingestTaskRunResultPg(db, {
      runId: "run-heartbeat-terminal",
      taskId: "task-a",
      rootSessionId: "session-a",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "done" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-20T08:03:00.000Z",
    });
    const server = await createTestServer(db);
    try {
      const response = await post(server.url, "/api/v2/executor/heartbeat", {
        runId: "run-heartbeat-terminal",
        taskId: "task-a",
        sessionId: "session-a",
        attemptId: "attempt-1",
        observedAt: "2026-06-20T08:04:00.000Z",
        heartbeatSeq: 9,
        phase: "running",
      });

      assert.equal(response.result.status, "completed");
      const handExecution = await getHandExecution(db, "run-heartbeat-terminal", "task-a", "attempt-1");
      assert.equal(handExecution.status, "completed");
      const payload = asRecord(handExecution.payload);
      assert.equal(payload.status, "completed");
      assert.equal(payload.terminalAt, "2026-06-20T08:03:00.000Z");
      assert.equal(payload.lastHeartbeatAt, undefined);
    } finally {
      await server.close();
    }
  });
});

test("late legacy heartbeat does not downgrade an executor binding completed by callback", async () => {
  await withDb(async (db) => {
    const runId = "run-callback-before-legacy-heartbeat";
    await seedRunTask(db, { runId, taskId: "task-a", runStatus: "running", taskStatus: "running" });
    await seedExecutorBinding(db, { runId, taskId: "task-a", attemptId: "attempt-1", status: "running" });
    await ingestTaskRunResultPg(db, {
      runId,
      taskId: "task-a",
      rootSessionId: "session-a",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "done" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-20T08:03:00.000Z",
    });

    const server = await createTestServer(db);
    try {
      const response = await post(server.url, "/api/v2/executor/heartbeat", {
        runId,
        taskId: "task-a",
        sessionId: "session-a",
        attemptId: "attempt-1",
        observedAt: "2026-06-20T08:04:00.000Z",
        heartbeatSeq: 9,
        phase: "running",
      });
      assert.equal(response.result.status, "completed");
      assert.equal((await getExecutorBindingPg(db, `executor-${runId}-task-a-attempt-1`))?.status, "completed");
    } finally {
      await server.close();
    }
  });
});

test("heartbeat and binding status updates preserve cancel_requested execution resources", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-heartbeat-cancel-requested", taskId: "task-a", runStatus: "cancelled", taskStatus: "running" });
    await seedExecutorBinding(db, { runId: "run-heartbeat-cancel-requested", taskId: "task-a", attemptId: "attempt-1", status: "running" });
    await seedHandExecution(db, {
      runId: "run-heartbeat-cancel-requested",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "running",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-cancel-requested",
    });
    await db.query(
      `update southstar.runtime_resources
          set status = 'cancel_requested',
              payload_json = case
                when resource_type = 'executor_binding' then
                  jsonb_set(jsonb_set(payload_json, '{status}', to_jsonb('cancel_requested'::text), true), '{southstarExecutorStatus}', to_jsonb('cancel_requested'::text), true)
                else jsonb_set(payload_json, '{status}', to_jsonb('cancel_requested'::text), true)
              end,
              summary_json = jsonb_set(summary_json, '{status}', to_jsonb('cancel_requested'::text), true)
        where run_id = $1
          and resource_type in ('hand_execution', 'executor_binding')`,
      ["run-heartbeat-cancel-requested"],
    );

    const directBindingUpdate = await updateExecutorBindingStatusPg(db, {
      bindingId: "executor-run-heartbeat-cancel-requested-task-a-attempt-1",
      status: "running",
      eventType: "executor.reconcile_completed",
      payloadPatch: {
        lastHeartbeatAt: "2026-06-20T08:01:00.000Z",
        heartbeatSeq: 99,
        runnerPhase: "subagent-running",
      },
    });
    assert.equal(directBindingUpdate.status, "cancel_requested");
    assert.equal(directBindingUpdate.payload.southstarExecutorStatus, "cancel_requested");

    const server = await createTestServer(db);
    try {
      const response = await post(server.url, "/api/v2/executor/heartbeat", {
        runId: "run-heartbeat-cancel-requested",
        taskId: "task-a",
        sessionId: "session-a",
        attemptId: "attempt-1",
        observedAt: "2026-06-20T08:02:00.000Z",
        heartbeatSeq: 100,
        phase: "running",
      });
      assert.equal(response.result.status, "cancel_requested");
    } finally {
      await server.close();
    }

    const handExecution = await getHandExecution(db, "run-heartbeat-cancel-requested", "task-a", "attempt-1");
    assert.equal(handExecution.status, "cancel_requested");
    assert.equal(asRecord(handExecution.payload).status, "cancel_requested");
    assert.equal(asRecord(handExecution.summary).status, "cancel_requested");
    assert.equal(asRecord(handExecution.payload).lastHeartbeatAt, undefined);

    const binding = await getExecutorBindingPg(db, "executor-run-heartbeat-cancel-requested-task-a-attempt-1");
    assert.equal(binding?.status, "cancel_requested");
    assert.equal(binding?.payload.southstarExecutorStatus, "cancel_requested");
    const bindingResource = await getResourceByKeyPg(db, "executor_binding", "executor-run-heartbeat-cancel-requested-task-a-attempt-1");
    assert.ok(bindingResource);
    assert.equal(asRecord(bindingResource.payload).status, "cancel_requested");
    assert.equal(asRecord(bindingResource.payload).southstarExecutorStatus, "cancel_requested");
    assert.equal(asRecord(bindingResource.summary).status, "cancel_requested");
  });
});

test("heartbeat preserves first startedAt and advances lastHeartbeatAt", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-heartbeat-started-at", taskId: "task-a", runStatus: "scheduling", taskStatus: "queued" });
    await seedHandExecution(db, {
      runId: "run-heartbeat-started-at",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "queued",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-started-at",
    });
    const server = await createTestServer(db);
    try {
      await post(server.url, "/api/v2/executor/heartbeat", {
        runId: "run-heartbeat-started-at",
        taskId: "task-a",
        sessionId: "session-a",
        attemptId: "attempt-1",
        observedAt: "2026-06-20T08:01:00.000Z",
        heartbeatSeq: 1,
        phase: "running",
      });
      await post(server.url, "/api/v2/executor/heartbeat", {
        runId: "run-heartbeat-started-at",
        taskId: "task-a",
        sessionId: "session-a",
        attemptId: "attempt-1",
        observedAt: "2026-06-20T08:02:00.000Z",
        heartbeatSeq: 2,
        phase: "running",
      });

      const handExecution = await getHandExecution(db, "run-heartbeat-started-at", "task-a", "attempt-1");
      const payload = asRecord(handExecution.payload);
      assert.equal(payload.startedAt, "2026-06-20T08:01:00.000Z");
      assert.equal(payload.lastHeartbeatAt, "2026-06-20T08:02:00.000Z");
      assert.equal(payload.heartbeatSeq, 2);
    } finally {
      await server.close();
    }
  });
});

test("ignored stale and terminal callbacks do not mutate current hand_execution", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-callback-ignore-managed", taskId: "task-a", runStatus: "running", taskStatus: "running", sessionId: "session-2" });
    await seedExecutorBinding(db, { runId: "run-callback-ignore-managed", taskId: "task-a", attemptId: "attempt-1", status: "running", torkJobId: "job-1" });
    await seedExecutorBinding(db, { runId: "run-callback-ignore-managed", taskId: "task-a", attemptId: "attempt-2", status: "running", torkJobId: "job-2" });
    await seedHandExecution(db, {
      runId: "run-callback-ignore-managed",
      taskId: "task-a",
      sessionId: "session-1",
      attemptId: "attempt-1",
      status: "queued",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-1",
    });
    await seedHandExecution(db, {
      runId: "run-callback-ignore-managed",
      taskId: "task-a",
      sessionId: "session-2",
      attemptId: "attempt-2",
      status: "running",
      queuedAt: "2026-06-20T08:01:00.000Z",
      externalJobId: "job-2",
    });

    const stale = await ingestTaskRunResultPg(db, {
      runId: "run-callback-ignore-managed",
      taskId: "task-a",
      rootSessionId: "session-1",
      ok: false,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "late stale" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-20T08:05:00.000Z",
    });

    assert.equal(stale.accepted, false);
    const staleHandExecution = await getHandExecution(db, "run-callback-ignore-managed", "task-a", "attempt-1");
    assert.equal(staleHandExecution.status, "queued");
    assert.equal(asRecord(staleHandExecution.payload).terminalAt, undefined);

    await ingestTaskRunResultPg(db, {
      runId: "run-callback-ignore-managed",
      taskId: "task-a",
      rootSessionId: "session-2",
      ok: true,
      attempts: 2,
      attemptId: "attempt-2",
      artifact: { kind: "implementation_report", summary: "newer passed" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-20T08:06:00.000Z",
    });
    const completedHandExecution = await getHandExecution(db, "run-callback-ignore-managed", "task-a", "attempt-2");
    const completedPayload = asRecord(completedHandExecution.payload);
    assert.equal(completedHandExecution.status, "completed");
    assert.equal(completedPayload.terminalAt, "2026-06-20T08:06:00.000Z");

    const terminalIgnored = await ingestTaskRunResultPg(db, {
      runId: "run-callback-ignore-managed",
      taskId: "task-a",
      rootSessionId: "session-2",
      ok: false,
      attempts: 2,
      attemptId: "attempt-2",
      artifact: { kind: "implementation_report", summary: "different late failed" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-20T08:07:00.000Z",
    });

    assert.equal(terminalIgnored.accepted, false);
    const afterTerminalIgnored = await getHandExecution(db, "run-callback-ignore-managed", "task-a", "attempt-2");
    assert.equal(afterTerminalIgnored.status, "completed");
    assert.equal(asRecord(afterTerminalIgnored.payload).terminalAt, "2026-06-20T08:06:00.000Z");
  });
});

test("stale callback records runtime exception and observe-only recovery decision", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-callback-stale-exception", taskId: "task-a", runStatus: "running", taskStatus: "running", sessionId: "session-2" });
    await seedHandExecution(db, {
      runId: "run-callback-stale-exception",
      taskId: "task-a",
      sessionId: "session-1",
      attemptId: "attempt-1",
      status: "queued",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-1",
    });
    await seedHandExecution(db, {
      runId: "run-callback-stale-exception",
      taskId: "task-a",
      sessionId: "session-2",
      attemptId: "attempt-2",
      status: "running",
      queuedAt: "2026-06-20T08:01:00.000Z",
      externalJobId: "job-2",
    });
    const callback = {
      runId: "run-callback-stale-exception",
      taskId: "task-a",
      rootSessionId: "session-1",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "old attempt passed" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-20T08:05:00.000Z",
    };

    const stale = await ingestTaskRunResultPg(db, callback);
    const duplicate = await ingestTaskRunResultPg(db, callback);

    assert.equal(stale.accepted, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.accepted, false);
    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-callback-stale-exception");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "stale_callback");
    assert.equal(exceptions[0]?.payload.source, "callback");
    assert.equal(exceptions[0]?.payload.severity, "warning");
    assert.equal(exceptions[0]?.payload.observedAt, "2026-06-20T08:05:00.000Z");
    assert.equal(exceptions[0]?.payload.evidenceRefs.length, 1);
    assert.match(
      String(exceptions[0]?.payload.evidenceRefs[0]),
      /^hand-execution:run-callback-stale-exception:task-a:attempt-1:callback:[a-f0-9]{64}$/,
    );
    assert.deepEqual(exceptions[0]?.payload.providerEvidence, {
      callbackAttemptId: "attempt-1",
      latestAttemptId: "attempt-2",
      rootSessionId: "session-1",
      currentRootSessionId: "session-2",
    });

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-callback-stale-exception");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.path, "none-observe-only");
    assert.equal(decisions[0]?.payload.exceptionId, exceptions[0]?.payload.exceptionId);
  });
});

test("late terminal callback records runtime exception and observe-only recovery decision", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-callback-late-exception", taskId: "task-a", runStatus: "running", taskStatus: "running", sessionId: "session-a" });
    await seedHandExecution(db, {
      runId: "run-callback-late-exception",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "running",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-1",
    });
    await ingestTaskRunResultPg(db, {
      runId: "run-callback-late-exception",
      taskId: "task-a",
      rootSessionId: "session-a",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "first passed" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-20T08:03:00.000Z",
    });

    const late = await ingestTaskRunResultPg(db, {
      runId: "run-callback-late-exception",
      taskId: "task-a",
      rootSessionId: "session-a",
      ok: false,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "different late failed" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-20T08:04:00.000Z",
    });

    assert.equal(late.accepted, false);
    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === "run-callback-late-exception");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "late_callback");
    assert.equal(exceptions[0]?.payload.source, "callback");
    assert.equal(exceptions[0]?.payload.severity, "warning");
    assert.equal(exceptions[0]?.payload.observedAt, "2026-06-20T08:04:00.000Z");
    assert.deepEqual(exceptions[0]?.payload.providerEvidence, { status: "completed" });

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === "run-callback-late-exception");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.path, "none-observe-only");
    assert.equal(decisions[0]?.payload.exceptionId, exceptions[0]?.payload.exceptionId);
  });
});

test("cancelled run callback is audited and cannot mutate task run resources or artifacts", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-callback-cancelled-terminal", taskId: "task-a", runStatus: "cancelled", taskStatus: "running", sessionId: "session-a" });
    await seedExecutorBinding(db, { runId: "run-callback-cancelled-terminal", taskId: "task-a", attemptId: "attempt-1", status: "running" });
    await seedHandExecution(db, {
      runId: "run-callback-cancelled-terminal",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "attempt-1",
      status: "running",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-cancelled-terminal",
    });
    await db.query(
      `update southstar.runtime_resources
          set status = 'cancel_requested',
              payload_json = case
                when resource_type = 'executor_binding' then
                  jsonb_set(jsonb_set(payload_json, '{status}', to_jsonb('cancel_requested'::text), true), '{southstarExecutorStatus}', to_jsonb('cancel_requested'::text), true)
                else jsonb_set(payload_json, '{status}', to_jsonb('cancel_requested'::text), true)
              end,
              summary_json = jsonb_set(summary_json, '{status}', to_jsonb('cancel_requested'::text), true)
        where run_id = $1
          and resource_type in ('hand_execution', 'executor_binding')`,
      ["run-callback-cancelled-terminal"],
    );

    const ignored: { accepted: boolean; ignoredRunStatus?: string } = await ingestTaskRunResultPg(db, {
      runId: "run-callback-cancelled-terminal",
      taskId: "task-a",
      rootSessionId: "session-a",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "late success after cancellation" },
      metrics: { tokens: 42 },
      events: [{ eventType: "progress.commentary", actorType: "hand", payload: { message: "late" } }],
      receivedAt: "2026-06-20T08:04:00.000Z",
    });

    assert.equal(ignored.accepted, false);
    assert.equal(ignored.ignoredRunStatus, "cancelled");
    const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", ["run-callback-cancelled-terminal"]);
    assert.equal(run.status, "cancelled");
    const task = await db.one<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1 and id = $2", ["run-callback-cancelled-terminal", "task-a"]);
    assert.equal(task.status, "running");

    const historyTypes = (await listHistoryForRunPg(db, "run-callback-cancelled-terminal")).map((event) => event.eventType);
    assert.equal(historyTypes.includes("executor.callback_ignored_cancelled_run"), true);
    assert.equal(historyTypes.includes("progress.commentary"), false);
    assert.equal(historyTypes.includes("artifact.created"), false);
    assert.equal((await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE })).filter((resource) => resource.runId === "run-callback-cancelled-terminal").length, 0);

    const handExecution = await getHandExecution(db, "run-callback-cancelled-terminal", "task-a", "attempt-1");
    assert.equal(handExecution.status, "cancel_requested");
    assert.equal(asRecord(handExecution.payload).status, "cancel_requested");
    assert.equal(asRecord(handExecution.summary).status, "cancel_requested");
    assert.equal(asRecord(handExecution.payload).terminalAt, undefined);
    const binding = await getExecutorBindingPg(db, "executor-run-callback-cancelled-terminal-task-a-attempt-1");
    assert.equal(binding?.status, "cancel_requested");
    assert.equal(binding?.payload.southstarExecutorStatus, "cancel_requested");
  });
});

test("stale callback detection uses canonical hand_execution attempts without executor_binding", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, { runId: "run-callback-hand-primary", taskId: "task-a", runStatus: "running", taskStatus: "running", sessionId: "session-2" });
    await seedHandExecution(db, {
      runId: "run-callback-hand-primary",
      taskId: "task-a",
      sessionId: "session-1",
      attemptId: "attempt-1",
      status: "queued",
      queuedAt: "2026-06-20T08:00:00.000Z",
      externalJobId: "job-1",
    });
    await seedHandExecution(db, {
      runId: "run-callback-hand-primary",
      taskId: "task-a",
      sessionId: "session-2",
      attemptId: "attempt-2",
      status: "running",
      queuedAt: "2026-06-20T08:01:00.000Z",
      externalJobId: "job-2",
    });

    const stale = await ingestTaskRunResultPg(db, {
      runId: "run-callback-hand-primary",
      taskId: "task-a",
      rootSessionId: "session-1",
      ok: false,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "late stale" },
      metrics: {},
      events: [],
      receivedAt: "2026-06-20T08:05:00.000Z",
    });

    assert.equal(stale.accepted, false);
    const staleHandExecution = await getHandExecution(db, "run-callback-hand-primary", "task-a", "attempt-1");
    assert.equal(staleHandExecution.status, "queued");
    assert.equal(asRecord(staleHandExecution.payload).terminalAt, undefined);
    const currentHandExecution = await getHandExecution(db, "run-callback-hand-primary", "task-a", "attempt-2");
    assert.equal(currentHandExecution.status, "running");
  });
});

async function seedRunTask(
  db: SouthstarDb,
  input: { runId: string; taskId: string; runStatus: string; taskStatus: string; sessionId?: string; runtimeContextJson?: Record<string, unknown> },
): Promise<void> {
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: input.runStatus,
    domain: "software",
    goalPrompt: "managed callback state",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: `wf-${input.runId}`, tasks: [{ id: input.taskId }] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify(input.runtimeContextJson ?? {}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: input.taskId,
    runId: input.runId,
    taskKey: input.taskId,
    status: input.taskStatus,
    sortOrder: 1,
    dependsOn: [],
    rootSessionId: input.sessionId ?? "session-a",
    subagentSessionIds: [],
  });
}

async function seedExecutorBinding(
  db: SouthstarDb,
  input: { runId: string; taskId: string; attemptId: string; status: "queued" | "running"; torkJobId?: string },
): Promise<void> {
  await createExecutorBindingPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    torkJobId: input.torkJobId ?? "job-a",
    status: input.status,
    now: "2026-06-20T08:00:00.000Z",
    queueTimeoutSeconds: 120,
    hardTimeoutSeconds: 600,
  });
}

async function seedHandExecution(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    status: "queued" | "running" | "completed" | "failed";
    queuedAt: string;
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
      queueTimeoutSeconds: 120,
      heartbeatTimeoutSeconds: 30,
    },
    summary: { providerId: "tork", attemptId: input.attemptId },
    metrics: {},
  });
}

async function getHandExecution(db: SouthstarDb, runId: string, taskId: string, attemptId: string) {
  const handExecutionId = `hand-execution:${runId}:${taskId}:${attemptId}`;
  const resource = await getResourceByKeyPg(db, "hand_execution", handExecutionId);
  assert.ok(resource, `expected hand_execution ${handExecutionId}`);
  return resource;
}

async function createTestServer(db: SouthstarDb) {
  return await createSouthstarRuntimeServer({
    db: db as never,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  });
}

async function post(baseUrl: string, path: string, body: unknown): Promise<{ ok: true; kind: string; result: { status?: string } }> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; kind: string; result: { status?: string } } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const db = await createTestPostgresDb();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
