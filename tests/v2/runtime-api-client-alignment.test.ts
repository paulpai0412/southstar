import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runtime server client exposes P0 runtime API methods", () => {
  const client = createRuntimeServerClient({ baseUrl: "http://127.0.0.1/" });
  const methods = [
    "pauseRun",
    "resumeRun",
    "cancelRun",
    "getRunActions",
    "getSessionEvents",
    "getSessionCheckpoints",
    "getSessionCheckpoint",
    "getSessionLineage",
    "listMemoryDeltas",
    "approveMemoryDelta",
    "rejectMemoryDelta",
    "invalidateRunMemory",
    "listExecutions",
    "getExecution",
    "getTaskActions",
    "retryTask",
    "resetTaskSession",
  ] as const;

  for (const method of methods) {
    assert.equal(typeof client[method], "function", `${method} should be exposed by RuntimeServerClient`);
  }
});

test("generic read-model API routes run summary, executions, and exceptions", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-runtime-api-client-alignment";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "align runtime API read models",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-a",
      runId,
      taskKey: "plan",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
    });
    await createWorkflowTaskPg(db, {
      id: "task-b",
      runId,
      taskKey: "implement",
      status: "running",
      sortOrder: 1,
      dependsOn: ["task-a"],
    });
    await createWorkflowTaskPg(db, {
      id: "task-c",
      runId,
      taskKey: "verify",
      status: "queued",
      sortOrder: 2,
      dependsOn: ["task-b"],
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "hand_execution",
      resourceKey: `hand-execution:${runId}:task-b:attempt-1`,
      runId,
      taskId: "task-b",
      sessionId: "session-b",
      scope: "hand",
      status: "running",
      payload: {
        providerId: "tork",
        attemptId: "attempt-1",
        externalJobId: "job-b",
        lastHeartbeatAt: "2026-06-23T10:00:00.000Z",
        heartbeatSeq: 3,
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-b",
      runId,
      taskId: "task-b",
      scope: "runtime",
      status: "observed",
      payload: {
        kind: "tork_running_hang",
        severity: "recoverable",
        source: "tork-observer",
        handExecutionId: `hand-execution:${runId}:task-b:attempt-1`,
        observedAt: "2026-06-23T10:01:00.000Z",
      },
    });

    const summary = await call<{ schemaVersion: string; kind: string; data: { runId: string; status: string; rawStatus: string; domain?: string; goalPrompt: string; taskCounts: Record<string, number> } }>(
      db,
      `/api/v2/read-models/run-summary/${runId}`,
    );
    assert.equal(summary.result.schemaVersion, "southstar.read_model.run_summary.v1");
    assert.equal(summary.result.kind, "run-summary");
    assert.equal(summary.result.data.runId, runId);
    assert.equal(summary.result.data.status, "running");
    assert.equal(summary.result.data.rawStatus, "running");
    assert.equal(summary.result.data.domain, "software");
    assert.equal(summary.result.data.goalPrompt, "align runtime API read models");
    assert.deepEqual(summary.result.data.taskCounts, { completed: 1, queued: 1, running: 1 });

    const executions = await call<{ schemaVersion: string; kind: string; data: { runId: string; executions: Array<{ executionId: string; taskId?: string; status: string }> } }>(
      db,
      `/api/v2/read-models/executions/${runId}`,
    );
    assert.equal(executions.result.schemaVersion, "southstar.read_model.executions.v1");
    assert.equal(executions.result.kind, "executions");
    assert.equal(executions.result.data.runId, runId);
    assert.deepEqual(executions.result.data.executions.map((execution) => execution.executionId), [`hand-execution:${runId}:task-b:attempt-1`]);
    assert.equal(executions.result.data.executions[0]?.taskId, "task-b");
    assert.equal(executions.result.data.executions[0]?.status, "running");

    const exceptions = await call<{ schemaVersion: string; kind: string; data: { runId: string; exceptions: Array<{ resourceKey: string; kind?: string; handExecutionId?: string }> } }>(
      db,
      `/api/v2/read-models/exceptions/${runId}`,
    );
    assert.equal(exceptions.result.schemaVersion, "southstar.read_model.exceptions.v1");
    assert.equal(exceptions.result.kind, "exceptions");
    assert.equal(exceptions.result.data.runId, runId);
    assert.deepEqual(exceptions.result.data.exceptions, [{
      resourceKey: "runtime-exception-b",
      status: "observed",
      kind: "tork_running_hang",
      severity: "recoverable",
      source: "tork-observer",
      taskId: "task-b",
      handExecutionId: `hand-execution:${runId}:task-b:attempt-1`,
      observedAt: "2026-06-23T10:01:00.000Z",
    }]);

    const legacyExceptions = await call<{ runId: string; exceptions: Array<{ resourceKey: string }> }>(
      db,
      `/api/v2/runs/${runId}/exceptions`,
    );
    assert.equal(legacyExceptions.kind, "runtime-exceptions");
    assert.equal(legacyExceptions.result.runId, runId);
    assert.deepEqual(legacyExceptions.result.exceptions.map((exception) => exception.resourceKey), ["runtime-exception-b"]);
  } finally {
    await db.close();
  }
});

async function call<T>(db: Parameters<typeof handleRuntimeRoute>[0]["db"], path: string): Promise<{ ok: true; kind: string; result: T }> {
  const response = await handleRuntimeRoute({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
  }, new Request(`http://127.0.0.1${path}`));
  const envelope = await response.json() as { ok: true; kind: string; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}
