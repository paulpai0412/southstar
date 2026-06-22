import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
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

// Abnormal + recovery lifecycle: callback reports failed artifact for a task,
// then recovery decision apply releases the task and scheduler reruns it through real Tork/Pi.
test("04 artifact repair/recovery: failed callback evidence triggers real recovery execution", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({ goalPrompt: "artifact recovery real E2E: fail first task and recover with bounded retry" }),
    });
    const run = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });
    const failedTaskId = run.taskIds[0] ?? "understand-repo";
    const attemptId = firstAttemptId(failedTaskId);
    const initialSessionId = `root-${run.runId}-${failedTaskId}`;
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
        artifact: { summary: "partial artifact missing required evidence" },
        metrics: { durationMs: 1, toolCalls: 0, retryCount: 0, tokens: 1, costMicrosUsd: 1 },
        events: [{
          eventType: "repair.requested",
          actorType: "root-session",
          sessionId: initialSessionId,
          payload: { missingFields: ["commandsRun", "testResults"], attempt: 1, repairInstruction: "fill required evidence fields" },
        }],
      }),
    });

    const failedTask = await env.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [run.runId, failedTaskId],
    );
    assert.equal(failedTask.status, "failed");

    const rejectedArtifact = (await listResourcesPg(env.db, { resourceType: "artifact_ref" }))
      .find((resource) => resource.runId === run.runId && resource.taskId === failedTaskId && resource.status === "rejected");
    assert.ok(rejectedArtifact);

    const controller = createRuntimeExceptionController({ db: env.db });
    const exception = await controller.observe({
      runId: run.runId,
      taskId: failedTaskId,
      sessionId: initialSessionId,
      attemptId,
      handExecutionId: initialHandExecutionId,
      source: "callback",
      kind: "artifact_rejected",
      severity: "recoverable",
      observedAt: "2026-06-22T00:01:00.000Z",
      evidenceRefs: [rejectedArtifact.resourceKey],
      providerEvidence: { artifactStatus: "rejected", reason: "partial artifact missing required evidence" },
    });
    const decision = await controller.decide(await controller.classify(exception));
    assert.equal(decision.payload.path, "repair-artifact");

    const applied = await api<{ status: string; reason: string }>(
      server.port,
      `/api/v2/runs/${encodeURIComponent(run.runId)}/recovery-decisions/${encodeURIComponent(decision.decisionId)}/apply`,
      { method: "POST", body: JSON.stringify({}) },
    );
    assert.equal(applied.status, "applied");

    const releasedTask = await env.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [run.runId, failedTaskId],
    );
    assert.equal(releasedTask.status, "pending");

    const callbackBase = dockerReachableUrl(server, infra);
    const scheduled = await createRealRecoveryScheduler(env.db, { infra, callbackBase }).runOnce({ runId: run.runId });
    assert.deepEqual(scheduled.dispatchedTaskIds, [failedTaskId]);

    const handExecution = await latestHandExecutionForTask(env.db, { runId: run.runId, taskId: failedTaskId });
    assert.equal(handExecution.attemptId, `${failedTaskId}-attempt-2`);
    await waitForTorkJob(infra.torkBaseUrl, handExecution.externalJobId);
    const handStatus = await waitForHandExecutionStatus(env.db, handExecution.resourceKey, ["completed", "failed"]);
    assert.equal(handStatus, "completed");

    const recoveredTask = await env.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [run.runId, failedTaskId],
    );
    assert.equal(recoveredTask.status, "completed");

    const history = await listHistoryForRunPg(env.db, run.runId);
    assert.equal(history.some((event) => event.eventType === "repair.requested" && event.taskId === failedTaskId), true);
    assert.equal(history.some((event) => event.eventType === "recovery_decision.applied" && event.taskId === failedTaskId), true);
    assert.equal(history.some((event) => event.eventType === "task.dispatch_submitted" && event.taskId === failedTaskId), true);
    assert.equal(history.some((event) => event.eventType === "executor.callback_received" && event.taskId === failedTaskId), true);

    const recoveryResource = await env.db.maybeOne<{ status: string; payload_json: { path?: string; schemaVersion?: string } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'recovery_execution' and run_id = $1 order by created_at desc limit 1",
      [run.runId],
    );
    assert.equal(recoveryResource?.status, "succeeded");
    assert.equal(recoveryResource?.payload_json.schemaVersion, "southstar.runtime.recovery_execution.v1");
    assert.equal(recoveryResource?.payload_json.path, "repair-artifact");

    const contextPacket = await env.db.maybeOne<{ payload_json: { executionAttempt?: number; failureSummary?: { text?: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'context_packet' and run_id = $1 and task_id = $2 order by created_at desc limit 1",
      [run.runId, failedTaskId],
    );
    assert.equal(contextPacket?.payload_json.executionAttempt, 2);
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
