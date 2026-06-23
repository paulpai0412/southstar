import test from "node:test";
import assert from "node:assert/strict";
import { createExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import {
  createWorkflowRunPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
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

test("executor job actions and cancel route write durable runtime command evidence", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-executor-job-cancel-api";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "cancel executor job",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "hand_execution",
      resourceKey: `hand-execution:${runId}:task-hand:attempt-1`,
      runId,
      taskId: "task-hand",
      sessionId: "session-hand",
      scope: "hand",
      status: "running",
      payload: {
        providerId: "tork",
        attemptId: "attempt-1",
        externalJobId: "job-hand-cancel",
        status: "running",
      },
      summary: { status: "running" },
    });
    const binding = await createExecutorBindingPg(db, {
      runId,
      taskId: "task-binding",
      attemptId: "attempt-1",
      torkJobId: "job-binding-cancel",
      status: "queued",
      now: "2026-06-23T09:59:00.000Z",
      queueTimeoutSeconds: 300,
      hardTimeoutSeconds: 600,
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "executor-binding-terminal",
      runId,
      taskId: "task-terminal",
      scope: "executor",
      status: "completed",
      payload: {
        executorType: "tork",
        attemptId: "attempt-terminal",
        torkJobId: "job-terminal-cancel",
        status: "completed",
      },
      summary: { status: "completed" },
    });

    const actionEnvelope = await call<{ actions: Array<{ action: string; allowed: boolean; endpoint?: string }> }>(
      `/api/v2/runs/${runId}/executor-jobs/job-hand-cancel/actions`,
    );
    assert.equal(actionEnvelope.kind, "executor-job-actions");
    assert.equal(actionEnvelope.result.actions.some((action) => action.action === "cancel" && action.allowed), true);
    assert.equal(actionEnvelope.result.actions.some((action) => action.action === "reconcile" && !action.allowed), true);

    const dryRun = await post<{ status: string; resourceRefs: unknown[]; eventRefs: unknown[] }>(
      `/api/v2/runs/${runId}/executor-jobs/job-hand-cancel/cancel`,
      {
        commandId: "cmd-job-cancel-dry-run",
        actor: { type: "user", id: "operator-a" },
        reason: "preview job cancel",
        dryRun: true,
      },
    );
    assert.equal(dryRun.result.status, "noop");
    assert.deepEqual(dryRun.result.resourceRefs, []);
    assert.deepEqual(dryRun.result.eventRefs, []);
    assert.equal((await getResourceByKeyPg(db, "hand_execution", `hand-execution:${runId}:task-hand:attempt-1`))?.status, "running");

    const cancelHand = await post<{
      commandId: string;
      status: string;
      affectedRunId?: string;
      affectedTaskId?: string;
      affectedSessionId?: string;
      resourceRefs: Array<{ resourceType: string; resourceKey: string }>;
      eventRefs: Array<{ eventType: string }>;
      nextSuggestedActions: string[];
    }>(`/api/v2/runs/${runId}/executor-jobs/job-hand-cancel/cancel`, {
      commandId: "cmd-job-cancel-hand",
      actor: { type: "user", id: "operator-a" },
      reason: "operator cancels active hand job",
    });
    assert.equal(cancelHand.result.commandId, "cmd-job-cancel-hand");
    assert.equal(cancelHand.result.status, "applied");
    assert.equal(cancelHand.result.affectedRunId, runId);
    assert.equal(cancelHand.result.affectedTaskId, "task-hand");
    assert.equal(cancelHand.result.affectedSessionId, "session-hand");
    assert.deepEqual(cancelHand.result.nextSuggestedActions, ["reconcile-executor-job", "watch-events"]);
    assert.equal(cancelHand.result.resourceRefs.some((ref) => ref.resourceType === "hand_execution"), true);
    assert.deepEqual(cancelHand.result.eventRefs.map((event) => event.eventType), [
      "run.command_requested",
      "executor_job.cancel_requested",
    ]);

    const replayHand = await post<typeof cancelHand.result>(`/api/v2/runs/${runId}/executor-jobs/job-hand-cancel/cancel`, {
      commandId: "cmd-job-cancel-hand",
      actor: { type: "user", id: "operator-a" },
      reason: "operator cancels active hand job",
    });
    assert.deepEqual(replayHand.result, cancelHand.result);

    const handResource = await getResourceByKeyPg(db, "hand_execution", `hand-execution:${runId}:task-hand:attempt-1`);
    assert.equal(handResource?.status, "cancel_requested");
    assert.equal((handResource?.payload as { status?: string }).status, "cancel_requested");
    assert.equal((handResource?.summary as { status?: string }).status, "cancel_requested");

    const cancelBinding = await post<{ status: string }>(`/api/v2/runs/${runId}/executor-jobs/job-binding-cancel/cancel`, {
      commandId: "cmd-job-cancel-binding",
      actor: { type: "user", id: "operator-a" },
      reason: "operator cancels active binding job",
    });
    assert.equal(cancelBinding.result.status, "applied");
    const bindingResource = await getResourceByKeyPg(db, "executor_binding", binding.id);
    assert.equal(bindingResource?.status, "cancel_requested");
    assert.equal((bindingResource?.payload as { status?: string }).status, "cancel_requested");
    assert.equal((bindingResource?.payload as { southstarExecutorStatus?: string }).southstarExecutorStatus, "cancel_requested");
    assert.equal((bindingResource?.summary as { status?: string }).status, "cancel_requested");

    const terminal = await post<{ status: string; message?: string }>(
      `/api/v2/runs/${runId}/executor-jobs/job-terminal-cancel/cancel`,
      {
        commandId: "cmd-job-cancel-terminal",
        actor: { type: "user", id: "operator-a" },
        reason: "terminal job should not mutate",
      },
    );
    assert.equal(terminal.result.status, "noop");
    assert.match(terminal.result.message ?? "", /terminal/);
    assert.equal((await getResourceByKeyPg(db, "executor_binding", "executor-binding-terminal"))?.status, "completed");

    const missing = await route(`/api/v2/runs/${runId}/executor-jobs/missing-job/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd-job-cancel-missing",
        actor: { type: "user", id: "operator-a" },
        reason: "missing job",
      }),
    });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /execution not found/);
    assert.equal((await getResourceByKeyPg(db, "runtime_command", "cmd-job-cancel-missing")), null);

    const commandResources = (await listResourcesPg(db, { resourceType: "runtime_command" }))
      .filter((resource) => resource.runId === runId)
      .map((resource) => resource.resourceKey)
      .sort();
    assert.deepEqual(commandResources, [
      "cmd-job-cancel-binding",
      "cmd-job-cancel-hand",
      "cmd-job-cancel-terminal",
    ]);
    const historyTypes = (await listHistoryForRunPg(db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.filter((eventType) => eventType === "executor_job.cancel_requested").length, 2);

    async function call<T>(path: string): Promise<{ ok: true; kind: string; result: T }> {
      const envelope = await readEnvelope<T>(await route(path));
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }

    async function post<T>(path: string, body: unknown): Promise<{ ok: true; kind: string; result: T }> {
      const envelope = await readEnvelope<T>(await route(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope;
    }

    async function route(path: string, init?: RequestInit): Promise<Response> {
      return await handleRuntimeRoute({
        db,
        plannerClient: { generate: async () => { throw new Error("planner not used"); } },
        executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      }, new Request(`http://127.0.0.1${path}`, init));
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
    await client.getExecutorJobActions({ runId: "run/a", jobId: "job/a" });
    await client.reconcileExecutorJob({ runId: "run/a", jobId: "job/a" });
    await client.cancelExecutorJob({
      runId: "run/a",
      jobId: "job/a",
      commandId: "cmd/a",
      actor: { type: "user", id: "operator-a" },
      reason: "cancel job",
    });

    assert.deepEqual(calls, [
      "http://127.0.0.1/api/v2/runs/run%2Fa/hand-executions",
      "http://127.0.0.1/api/v2/runs/run%2Fa/hand-executions/hand-execution%3Arun%2Fa%3Atask%2Fa%3Aattempt%2F1",
      "http://127.0.0.1/api/v2/runs/run%2Fa/executor-jobs/job%2Fa/actions",
      "http://127.0.0.1/api/v2/runs/run%2Fa/executor-jobs/job%2Fa/reconcile",
      "http://127.0.0.1/api/v2/runs/run%2Fa/executor-jobs/job%2Fa/cancel",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
