import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import { createPostgresSessionStore } from "../../../src/v2/session/postgres-session-store.ts";
import { listHistoryForRunPg, listResourcesPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  dockerReachableUrl,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForTorkJob,
} from "../postgres-real-harness.ts";
import {
  createRealRecoveryScheduler,
  firstAttemptId,
  latestHandExecutionForTask,
  seedRunningHandAttempt,
  waitForHandExecutionStatus,
} from "../recovery-scheduler-helpers.ts";

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
    const failedTaskId = run.taskIds[0] ?? "understand-repo";
    const initialSessionId = `root-${run.runId}-${failedTaskId}`;
    const attemptId = firstAttemptId(failedTaskId);
    const initialHandExecutionId = await seedRunningHandAttempt(env.db, {
      runId: run.runId,
      taskId: failedTaskId,
      sessionId: initialSessionId,
      attemptId,
    });

    await api(server.port, "/api/v2/tork/callback", {
      method: "POST",
      body: JSON.stringify({
        runId: run.runId,
        taskId: failedTaskId,
        rootSessionId: initialSessionId,
        ok: false,
        attempts: 1,
        attemptId,
        artifact: { summary: "session disconnected before required outputs were finalized" },
        metrics: { durationMs: 1, toolCalls: 0, retryCount: 0, tokens: 1, costMicrosUsd: 1 },
        error: "session_lost",
      }),
    });

    const checkpointResourceKey = `checkpoint:${run.runId}:${failedTaskId}:before-recovery`;
    await createPostgresSessionStore(env.db).createCheckpoint({
      runId: run.runId,
      taskId: failedTaskId,
      sessionId: initialSessionId,
      resourceKey: checkpointResourceKey,
      checkpointType: "before-recovery",
      summary: "Session disconnected before required outputs were finalized.",
      eventRange: { fromSequence: 0, toSequence: 0 },
      refs: { contextPacketIds: [], taskEnvelopeIds: [], artifactRefs: [] },
      metrics: {},
    });

    const controller = createRuntimeExceptionController({ db: env.db });
    const exception = await controller.observe({
      runId: run.runId,
      taskId: failedTaskId,
      sessionId: initialSessionId,
      attemptId,
      handExecutionId: initialHandExecutionId,
      source: "callback",
      kind: "validation_failed",
      severity: "recoverable",
      observedAt: "2026-06-22T00:02:00.000Z",
      evidenceRefs: [checkpointResourceKey, initialHandExecutionId],
      providerEvidence: { error: "session_lost" },
    });
    const decision = await controller.decide(await controller.classify(exception));
    assert.equal(decision.payload.path, "reset-session");

    const applied = await api<{ status: string; reason: string }>(
      server.port,
      `/api/v2/runs/${encodeURIComponent(run.runId)}/recovery-decisions/${encodeURIComponent(decision.decisionId)}/apply`,
      { method: "POST", body: JSON.stringify({}) },
    );
    assert.equal(applied.status, "applied");

    const releasedTask = await env.db.one<{ status: string; root_session_id: string | null }>(
      "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      [run.runId, failedTaskId],
    );
    assert.equal(releasedTask.status, "pending");
    assert.notEqual(releasedTask.root_session_id, initialSessionId);
    assert.match(releasedTask.root_session_id ?? "", new RegExp(`^root-${escapeRegExp(run.runId)}-${failedTaskId}-reset-session-`));

    const callbackBase = dockerReachableUrl(server, infra);
    const scheduled = await createRealRecoveryScheduler(env.db, { infra, callbackBase }).runOnce({ runId: run.runId });
    assert.deepEqual(scheduled.dispatchedTaskIds, [failedTaskId]);

    const handExecution = await latestHandExecutionForTask(env.db, { runId: run.runId, taskId: failedTaskId });
    assert.equal(handExecution.attemptId, `${failedTaskId}-attempt-2`);
    await waitForTorkJob(infra.torkBaseUrl, handExecution.externalJobId);
    const handStatus = await waitForHandExecutionStatus(env.db, handExecution.resourceKey, ["completed", "failed"]);
    assert.equal(handStatus, "completed");

    const task = await env.db.one<{ status: string; root_session_id: string | null }>(
      "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      [run.runId, failedTaskId],
    );
    assert.equal(task.status, "completed");
    assert.notEqual(task.root_session_id, initialSessionId);

    const checkpoints = (await listResourcesPg(env.db, { resourceType: "session_checkpoint" }))
      .filter((resource) => resource.runId === run.runId && resource.taskId === failedTaskId);
    assert.equal(checkpoints.some((resource) => resource.payload.checkpointType === "before-recovery"), true);

    const contextPacket = await env.db.maybeOne<{ payload_json: { rootSessionId?: string; executionAttempt?: number; checkpointSummary?: { sourceRef?: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'context_packet' and run_id = $1 and task_id = $2 order by created_at desc limit 1",
      [run.runId, failedTaskId],
    );
    assert.equal(contextPacket?.payload_json.rootSessionId, task.root_session_id);
    assert.equal(contextPacket?.payload_json.executionAttempt, 2);

    const envelope = await env.db.maybeOne<{ payload_json: { envelope?: { session?: { sessionId?: string; baseCheckpointId?: string } } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'task_envelope' and run_id = $1 and task_id = $2 order by created_at desc limit 1",
      [run.runId, failedTaskId],
    );
    assert.equal(envelope?.payload_json.envelope?.session?.sessionId, task.root_session_id);

    const acceptedArtifacts = (await listResourcesPg(env.db, { resourceType: "artifact_ref" }))
      .filter((resource) => resource.runId === run.runId && resource.taskId === failedTaskId && resource.status === "accepted");
    assert.equal(acceptedArtifacts.length > 0, true);

    const history = await listHistoryForRunPg(env.db, run.runId);
    assert.equal(history.some((event) => event.eventType === "checkpoint.created" && event.taskId === failedTaskId), true);
    assert.equal(history.some((event) => event.eventType === "session.reset" && event.taskId === failedTaskId), true);
    assert.equal(history.some((event) => event.eventType === "task.dispatch_submitted" && event.taskId === failedTaskId), true);
    assert.equal(history.some((event) => event.eventType === "executor.callback_received" && event.taskId === failedTaskId), true);
  } finally {
    await server.close();
    await env.close();
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
