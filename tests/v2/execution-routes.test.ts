import test from "node:test";
import assert from "node:assert/strict";
import { createExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("execution routes normalize hand_execution and executor_binding", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-executions-api";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "inspect executions",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "hand_execution",
      resourceKey: `hand-execution:${runId}:task-a:attempt-1`,
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      scope: "hand",
      status: "running",
      payload: {
        providerId: "tork",
        attemptId: "attempt-1",
        externalJobId: "job-hand-1",
        lastHeartbeatAt: "2026-06-23T10:00:00.000Z",
        heartbeatSeq: 2,
        callbackReceivedAt: "2026-06-23T10:01:00.000Z",
        callbackOk: true,
        eventRefs: ["event-a"],
        providerPayload: { token: "do-not-expose" },
      },
      summary: { providerId: "summary-provider" },
    });
    const legacyBinding = await createExecutorBindingPg(db, {
      runId,
      taskId: "task-b",
      attemptId: "attempt-1",
      torkJobId: "job-legacy-1",
      status: "queued",
      now: "2026-06-23T09:59:00.000Z",
      queueTimeoutSeconds: 300,
      hardTimeoutSeconds: 600,
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "executor-binding-timeout",
      runId,
      taskId: "task-timeout",
      scope: "executor",
      status: "queue-timeout",
      payload: {
        executorType: "tork",
        attemptId: "attempt-2",
        torkJobId: "job-timeout-1",
        terminalObservedAt: "2026-06-23T10:02:00.000Z",
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "executor-binding-cancel",
      runId,
      taskId: "task-cancel",
      scope: "executor",
      status: "cancel_requested",
      payload: {
        executorType: "tork",
        attemptId: "attempt-3",
        torkJobId: "job-cancel-1",
      },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "executor-binding-orphaned",
      runId,
      taskId: "task-orphaned",
      scope: "executor",
      status: "orphaned",
      payload: {
        executorType: "tork",
        attemptId: "attempt-4",
        torkJobId: "job-orphaned-1",
      },
    });
    const unrelatedBinding = await createExecutorBindingPg(db, {
      runId,
      taskId: "task-unrelated",
      attemptId: "attempt-5",
      torkJobId: "job-unrelated-1",
      status: "queued",
      now: "2026-06-23T09:59:00.000Z",
      queueTimeoutSeconds: 300,
      hardTimeoutSeconds: 600,
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-a",
      runId,
      taskId: "task-a",
      scope: "runtime",
      status: "open",
      payload: {
        handExecutionId: `hand-execution:${runId}:task-a:attempt-1`,
      },
    });

    const list = await call<{ runId: string; executions: Array<Record<string, unknown>> }>(`/api/v2/runs/${runId}/hand-executions`);
    assert.equal(list.kind, "executions");
    assert.equal(list.result.runId, runId);
    assert.deepEqual(list.result.executions.map((item) => item.executionId).sort(), [
      "executor-binding-cancel",
      "executor-binding-orphaned",
      "executor-binding-timeout",
      legacyBinding.id,
      unrelatedBinding.id,
      `hand-execution:${runId}:task-a:attempt-1`,
    ]);
    const hand = list.result.executions.find((item) => item.taskId === "task-a")!;
    assert.equal(hand.kind, "hand_execution");
    assert.equal(hand.providerId, "tork");
    assert.equal(hand.externalJobId, "job-hand-1");
    assert.deepEqual(hand.heartbeat, { lastHeartbeatAt: "2026-06-23T10:00:00.000Z", heartbeatSeq: 2 });
    assert.deepEqual(hand.callback, { receivedAt: "2026-06-23T10:01:00.000Z", ok: true, eventRefs: ["event-a"] });
    assert.deepEqual(hand.exceptionRefs, ["runtime-exception-a"]);
    assert.equal(JSON.stringify(hand).includes("do-not-expose"), false);
    const legacy = list.result.executions.find((item) => item.taskId === "task-b")!;
    assert.equal(legacy.kind, "executor_binding");
    assert.equal(legacy.providerId, "tork");
    assert.equal(legacy.externalJobId, "job-legacy-1");
    const timeout = list.result.executions.find((item) => item.executionId === "executor-binding-timeout")!;
    assert.equal(timeout.status, "lost");
    assert.equal(timeout.rawStatus, "queue-timeout");
    assert.deepEqual(timeout.terminal, { completedAt: "2026-06-23T10:02:00.000Z" });
    const cancel = list.result.executions.find((item) => item.executionId === "executor-binding-cancel")!;
    assert.equal(cancel.status, "cancelled");
    assert.equal(cancel.rawStatus, "cancel_requested");
    const orphaned = list.result.executions.find((item) => item.executionId === "executor-binding-orphaned")!;
    assert.equal(orphaned.status, "lost");
    assert.equal(orphaned.rawStatus, "orphaned");

    const detail = await call<{ execution: Record<string, unknown> }>(
      `/api/v2/runs/${runId}/hand-executions/${encodeURIComponent(`hand-execution:${runId}:task-a:attempt-1`)}`,
    );
    assert.equal(detail.kind, "execution");
    assert.equal(detail.result.execution.externalJobId, "job-hand-1");
    assert.equal(detail.result.execution.providerId, "tork");

    const alias = await call<{ executions: Array<Record<string, unknown>> }>(`/api/v2/runs/${runId}/executor-jobs`);
    assert.deepEqual(alias.result.executions.map((item) => item.executionId).sort(), [
      "executor-binding-cancel",
      "executor-binding-orphaned",
      "executor-binding-timeout",
      legacyBinding.id,
      unrelatedBinding.id,
      `hand-execution:${runId}:task-a:attempt-1`,
    ]);
    const aliasDetail = await call<{ execution: Record<string, unknown> }>(`/api/v2/runs/${runId}/executor-jobs/job-legacy-1`);
    assert.equal(aliasDetail.result.execution.executionId, legacyBinding.id);

    const observedJobIds: string[] = [];
    const reconciled = await handleRuntimeRoute({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      torkObservationClient: {
        capabilities: () => ({ supportsJobLogs: false }),
        getJob: async (jobId: string) => {
          observedJobIds.push(jobId);
          return { id: jobId, status: "queued" };
        },
        getJobLogs: async () => "",
        cancelJob: async () => undefined,
      },
    }, new Request(`http://127.0.0.1/api/v2/runs/${runId}/executor-jobs/job-legacy-1/reconcile`, { method: "POST" }));
    const reconcileEnvelope = await readEnvelope<{ runId: string; executionId: string; result: unknown }>(reconciled);
    assert.equal(reconcileEnvelope.ok, true);
    assert.equal(reconcileEnvelope.result.runId, runId);
    assert.equal(reconcileEnvelope.result.executionId, legacyBinding.id);
    assert.deepEqual(observedJobIds, ["job-legacy-1"]);

    await createWorkflowRunPg(db, {
      id: "run-other",
      status: "running",
      domain: "software",
      goalPrompt: "other",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const mismatched = await route(`/api/v2/runs/run-other/hand-executions/${encodeURIComponent(`hand-execution:${runId}:task-a:attempt-1`)}`);
    assert.equal(mismatched.status, 400);
    assert.match(await mismatched.text(), /execution not found/);

    async function call<T>(path: string): Promise<{ ok: true; kind: string; result: T }> {
      const envelope = await readEnvelope<T>(await route(path));
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }

    async function route(path: string): Promise<Response> {
      return await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      }, new Request(`http://127.0.0.1${path}`));
    }
  } finally {
    await db.close();
  }
});

async function readEnvelope<T>(response: Response): Promise<{ ok: true; kind: string; result: T } | { ok: false; error: string }> {
  return await response.json() as { ok: true; kind: string; result: T } | { ok: false; error: string };
}

test("runtime server client exposes execution projection API URLs", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true, kind: "test", result: {} }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = createRuntimeServerClient({ baseUrl: "http://127.0.0.1/" });
    await client.listExecutions("run/a");
    await client.getExecution({ runId: "run/a", executionId: "hand-execution:run/a:task/a:attempt/1" });

    assert.deepEqual(calls, [
      "http://127.0.0.1/api/v2/runs/run%2Fa/hand-executions",
      "http://127.0.0.1/api/v2/runs/run%2Fa/hand-executions/hand-execution%3Arun%2Fa%3Atask%2Fa%3Aattempt%2F1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
