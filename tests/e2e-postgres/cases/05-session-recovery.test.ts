import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  dockerReachableUrl,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForExecutorBindingStatus,
  waitForTorkJob,
} from "../postgres-real-harness.ts";

// Session recovery lifecycle: persisted failed session state is checkpointed,
// rerun creates a new root session id and completes through real Tork/Pi callback flow.
test("05 session recovery: checkpointed failed session reruns with new root session id", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({ goalPrompt: "session recovery real E2E: recover lost session and continue" }),
    });
    const run = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });
    const failedTaskId = "understand-repo";
    const initialSessionId = `root-${run.runId}-${failedTaskId}`;

    await api(server.port, "/api/v2/tork/callback", {
      method: "POST",
      body: JSON.stringify({
        runId: run.runId,
        taskId: failedTaskId,
        rootSessionId: initialSessionId,
        ok: false,
        attempts: 1,
        artifact: { summary: "session disconnected before required outputs were finalized" },
        metrics: { durationMs: 1, toolCalls: 0, retryCount: 0, tokens: 1, costMicrosUsd: 1 },
        error: "session_lost",
      }),
    });

    const callbackBase = dockerReachableUrl(server, infra);
    const recovery = await api<{ recoveryExecutionId: string; externalJobId: string; targetTaskIds: string[]; attemptId: string }>(
      server.port,
      `/api/v2/runs/${encodeURIComponent(run.runId)}/recovery/dispatch`,
      {
        method: "POST",
        body: JSON.stringify({
          failedTaskId,
          callbackUrl: `${callbackBase}/api/v2/tork/callback`,
          heartbeatUrl: `${callbackBase}/api/v2/executor/heartbeat`,
          runRoot: "/tmp/southstar-runs",
          harnessEndpoint: infra.piHarnessEndpoint,
          plan: {
            strategy: "retry-same-agent",
            failedTaskId,
            baseTaskId: failedTaskId,
            targetTaskIds: [failedTaskId],
            attemptNumber: 2,
            requiresOperatorApproval: false,
            reason: "session disconnected; rebuild from checkpointed context",
            diagnostics: ["root session heartbeat stopped before artifact acceptance"],
          },
        }),
      },
    );

    await waitForTorkJob(infra.torkBaseUrl, recovery.externalJobId);
    const bindingId = `executor-${run.runId}-${failedTaskId}-${recovery.attemptId}`;
    const bindingStatus = await waitForExecutorBindingStatus(env.db, bindingId, ["completed", "failed"]);
    assert.equal(bindingStatus, "completed");

    const task = await env.db.one<{ status: string; root_session_id: string | null }>(
      "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      [run.runId, failedTaskId],
    );
    assert.equal(task.status, "completed");
    assert.equal(task.root_session_id, `root-${run.runId}-${failedTaskId}-recovery-2`);
    assert.notEqual(task.root_session_id, initialSessionId);

    const checkpoint = await env.db.maybeOne<{ status: string; payload_json: { kind?: string; checkpointId?: string; sessionId?: string } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'session_checkpoint' and run_id = $1 and task_id = $2 order by created_at desc limit 1",
      [run.runId, failedTaskId],
    );
    assert.equal(checkpoint?.status, "created");
    assert.equal(checkpoint?.payload_json.kind, "before-recovery");
    assert.equal(checkpoint?.payload_json.sessionId, initialSessionId);

    const contextPacket = await env.db.maybeOne<{ payload_json: { rootSessionId?: string; executionAttempt?: number; checkpointSummary?: { sourceRef?: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'context_packet' and run_id = $1 and task_id = $2 order by created_at desc limit 1",
      [run.runId, failedTaskId],
    );
    assert.equal(contextPacket?.payload_json.rootSessionId, `root-${run.runId}-${failedTaskId}-recovery-2`);
    assert.equal(contextPacket?.payload_json.executionAttempt, 2);
    assert.equal(Boolean(contextPacket?.payload_json.checkpointSummary?.sourceRef), true);

    const envelope = await env.db.maybeOne<{ payload_json: { envelope?: { session?: { sessionId?: string; baseCheckpointId?: string } } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'task_envelope' and run_id = $1 and task_id = $2 order by created_at desc limit 1",
      [run.runId, failedTaskId],
    );
    assert.equal(envelope?.payload_json.envelope?.session?.sessionId, `root-${run.runId}-${failedTaskId}-recovery-2`);
    assert.equal(Boolean(envelope?.payload_json.envelope?.session?.baseCheckpointId), true);

    const history = await env.db.query<{ event_type: string; task_id: string | null }>(
      "select event_type, task_id from southstar.workflow_history where run_id = $1 order by sequence",
      [run.runId],
    );
    assert.equal(history.rows.some((event) => event.event_type === "checkpoint.created" && event.task_id === failedTaskId), true);
    assert.equal(history.rows.some((event) => event.event_type === "recovery.execution_submitted" && event.task_id === failedTaskId), true);
    assert.equal(history.rows.some((event) => event.event_type === "executor.callback_received" && event.task_id === failedTaskId), true);
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
