import test from "node:test";
import assert from "node:assert/strict";
import { dispatchRecoveryExecutionPg } from "../../../src/v2/session-recovery/postgres-dispatcher.ts";
import { TorkClient } from "../../../src/v2/executor/tork-client.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../../src/v2/ui-api/postgres-run-api.ts";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  dockerReachableUrl,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForExecutorBindingStatus,
  waitForTorkJob,
} from "../postgres-real-harness.ts";

// Abnormal + recovery lifecycle: callback reports failed artifact for a task,
// then recovery dispatch reruns the failed task through real Tork/Pi and reaches completed binding state.
test("04 artifact repair/recovery: failed callback evidence triggers real recovery execution", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await createPostgresPlannerDraft(env.db, { goalPrompt: "artifact recovery real E2E: fail first task and recover with bounded retry" });
    const run = await createPostgresRunFromDraft(env.db, { draftId: draft.draftId });
    const failedTaskId = "understand-repo";

    await api(server.port, "/api/v2/tork/callback", {
      method: "POST",
      body: JSON.stringify({
        runId: run.runId,
        taskId: failedTaskId,
        rootSessionId: `root-${run.runId}-${failedTaskId}`,
        ok: false,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { summary: "partial artifact missing required evidence" },
        metrics: { durationMs: 1, toolCalls: 0, retryCount: 0, tokens: 1, costMicrosUsd: 1 },
        events: [{
          eventType: "repair.requested",
          actorType: "root-session",
          sessionId: `root-${run.runId}-${failedTaskId}`,
          payload: { missingFields: ["commandsRun", "testResults"], attempt: 1, repairInstruction: "fill required evidence fields" },
        }],
      }),
    });

    const failedTask = await env.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [run.runId, failedTaskId],
    );
    assert.equal(failedTask.status, "failed");

    const callbackBase = dockerReachableUrl(server, infra);
    const torkClient = new TorkClient({ baseUrl: infra.torkBaseUrl, requestTimeoutMs: 20_000, retryCount: 2 });
    const recovery = await dispatchRecoveryExecutionPg(env.db, {
      runId: run.runId,
      failedTaskId,
      plan: {
        strategy: "retry-same-agent",
        failedTaskId,
        baseTaskId: failedTaskId,
        targetTaskIds: [failedTaskId],
        attemptNumber: 2,
        requiresOperatorApproval: false,
        reason: "repair rejected artifact with focused retry",
        diagnostics: [],
      },
      executorProvider: new TorkExecutorProvider({ torkClient }),
      callbackUrl: `${callbackBase}/api/v2/tork/callback`,
      heartbeatUrl: `${callbackBase}/api/v2/executor/heartbeat`,
      runRoot: "/tmp/southstar-runs",
      harnessEndpoint: infra.piHarnessEndpoint,
    });

    assert.equal(recovery.targetTaskIds.length, 1);
    assert.equal(recovery.targetTaskIds[0], failedTaskId);

    await waitForTorkJob(infra.torkBaseUrl, recovery.externalJobId);
    const bindingId = `executor-${run.runId}-${failedTaskId}-${recovery.attemptId}`;
    const bindingStatus = await waitForExecutorBindingStatus(env.db, bindingId, ["completed", "failed"]);
    assert.equal(bindingStatus, "completed");

    const recoveredTask = await env.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [run.runId, failedTaskId],
    );
    assert.equal(recoveredTask.status, "completed");

    const history = await env.db.query<{ event_type: string; task_id: string | null }>(
      "select event_type, task_id from southstar.workflow_history where run_id = $1 order by sequence",
      [run.runId],
    );
    assert.equal(history.rows.some((event) => event.event_type === "repair.requested" && event.task_id === failedTaskId), true);
    assert.equal(history.rows.some((event) => event.event_type === "recovery.execution_submitted" && event.task_id === failedTaskId), true);
    assert.equal(history.rows.some((event) => event.event_type === "executor.callback_received" && event.task_id === failedTaskId), true);

    const recoveryResource = await env.db.maybeOne<{ status: string; payload_json: { attemptId?: string; strategy?: string } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'recovery_execution' and run_id = $1 order by created_at desc limit 1",
      [run.runId],
    );
    assert.equal(recoveryResource?.status, "submitted");
    assert.equal(recoveryResource?.payload_json.strategy, "retry-same-agent");
    assert.equal(recoveryResource?.payload_json.attemptId, "attempt-2");
  } finally {
    await server.close();
    await env.close();
  }
});

async function api<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}
