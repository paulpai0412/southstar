import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E as createPostgresRealHarness } from "../postgres-real-harness.ts";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import { getResourceByKeyPg, listHistoryForRunPg, listResourcesPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  canonicalHandExecutionId,
  createRuntimeServerWithoutBackgroundLoops,
  postJson,
  seedHardeningRunTask,
} from "../runtime-hardening-fixtures.ts";

test("23 operator approved recovery apply gates decision before approval and records operator history", async () => {
  const harness = await createPostgresRealHarness();
  const server = await createRuntimeServerWithoutBackgroundLoops(harness.db);
  const runId = "real-operator-approved-apply";
  const taskId = "task-a";
  const sessionId = `session-${runId}-${taskId}`;
  const handExecutionId = canonicalHandExecutionId(runId, taskId, "attempt-1");
  try {
    await seedHardeningRunTask(harness.db, { runId, taskId, runStatus: "running", taskStatus: "running" });
    const controller = createRuntimeExceptionController({ db: harness.db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId,
      attemptId: "attempt-1",
      handExecutionId,
      source: "operator",
      kind: "provider_unreachable",
      severity: "blocking",
      observedAt: "2026-06-21T14:00:00.000Z",
      evidenceRefs: ["provider:network-outage"],
      providerEvidence: { providerId: "tork", status: "unreachable" },
    });
    const decision = await controller.decide(await controller.classify(exception));
    assert.equal(decision.status, "waiting_operator_approval");
    assert.equal(decision.payload.path, "block-for-operator");
    assert.equal(decision.payload.operatorApprovalRequired, true);

    const skipped = await postJson<{ status: string; reason: string }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/recovery-decisions/${encodeURIComponent(decision.decisionId)}/apply`,
      {},
    );
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.reason, "decision waiting for operator approval");
    assert.equal((await getResourceByKeyPg(harness.db, "recovery_decision", decision.resourceKey))?.status, "waiting_operator_approval");
    assert.equal((await listResourcesPg(harness.db, { resourceType: "recovery_execution" })).filter((resource) => resource.runId === runId).length, 0);

    const approved = await postJson<{ status: string; operatorApprovalResourceKey: string }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/recovery-decisions/${encodeURIComponent(decision.decisionId)}/approval`,
      { decision: "approved", reason: "operator verified release should pause for manual action" },
    );
    assert.equal(approved.status, "approved");
    const approval = await getResourceByKeyPg(harness.db, "operator_approval", approved.operatorApprovalResourceKey);
    assert.equal(approval?.status, "approved");
    assert.equal(approval?.payload.decisionId, decision.decisionId);
    assert.equal(approval?.payload.operatorDecision, "approved");

    const applied = await postJson<{ status: string; executionResourceKey?: string; reason: string }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/recovery-decisions/${encodeURIComponent(decision.decisionId)}/apply`,
      {},
    );
    assert.equal(applied.status, "blocked");
    assert.equal(applied.reason, "block-for-operator blocked");

    const task = await harness.db.one<{ status: string; completed_at: Date | null }>(
      "select status, completed_at from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "blocked");
    assert.equal(task.completed_at, null);
    assert.equal((await getResourceByKeyPg(harness.db, "recovery_decision", decision.resourceKey))?.status, "blocked");
    assert.equal((await getResourceByKeyPg(harness.db, "runtime_exception", exception.resourceKey))?.status, "observed");

    const execution = await getResourceByKeyPg(harness.db, "recovery_execution", applied.executionResourceKey ?? "");
    assert.equal(execution?.status, "blocked");
    const executionPayload = execution?.payload as {
      stateChanges: Array<{ resourceType: string; toStatus?: string; reason: string }>;
      providerActions: unknown[];
    };
    assert.deepEqual(executionPayload.stateChanges.map((change) => [change.resourceType, change.toStatus, change.reason]), [
      ["workflow_task", "blocked", "block-for-operator"],
      ["recovery_decision", "blocked", "block-for-operator blocked"],
    ]);
    assert.deepEqual(executionPayload.providerActions, []);

    const historyTypes = (await listHistoryForRunPg(harness.db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.includes("recovery_decision.operator_decided"), true);
    assert.equal(historyTypes.includes("recovery_execution.blocked"), true);
    assert.equal(historyTypes.includes("recovery_decision.applied"), false);
  } finally {
    await server.close();
    await harness.close();
  }
});
