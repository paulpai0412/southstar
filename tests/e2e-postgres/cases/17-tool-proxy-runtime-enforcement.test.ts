import test from "node:test";
import assert from "node:assert/strict";
import type { ExecutorSubmitRequest } from "../../../src/v2/executor/provider.ts";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import {
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  createManagedScheduler,
  findRuntimeResource,
  seedHardeningRunTask,
} from "../runtime-hardening-fixtures.ts";

test("17 tool proxy runtime enforcement: scheduler blocks credential-bearing inputs before hand execution", async () => {
  const harness = await createInitializedRealPostgresE2E();
  const runId = "real-tool-proxy-runtime-enforcement";
  const upstreamTaskId = "discover";
  const blockedTaskId = "implement";
  const rawSecret = "ghp_runtimehardening1234567890abcdef1234567890";
  const submitted: ExecutorSubmitRequest[] = [];
  try {
    await seedHardeningRunTask(harness.db, {
      runId,
      taskId: blockedTaskId,
      runStatus: "scheduling",
      taskStatus: "pending",
      dependsOn: [upstreamTaskId],
    });
    await createWorkflowTaskPg(harness.db, {
      id: upstreamTaskId,
      runId,
      taskKey: upstreamTaskId,
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: `session-${runId}-${upstreamTaskId}`,
    });
    await upsertRuntimeResourcePg(harness.db, {
      resourceType: "artifact_ref",
      resourceKey: `artifact-ref-${runId}-${upstreamTaskId}`,
      runId,
      taskId: upstreamTaskId,
      sessionId: `session-${runId}-${upstreamTaskId}`,
      scope: "artifact",
      status: "accepted",
      title: "Upstream artifact ref with credential-shaped ref",
      payload: {
        schemaVersion: "southstar.artifact_ref.v1",
        artifactRefId: `artifact-ref-${runId}-${upstreamTaskId}`,
        ref: rawSecret,
      },
    });

    const scheduler = createManagedScheduler(harness.db, "http://127.0.0.1:1", submitted);
    await assert.rejects(
      () => scheduler.runOnce({ runId }),
      /raw credential payload blocked before hand execution/,
    );

    assert.deepEqual(submitted, []);
    const task = await harness.db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, blockedTaskId],
    );
    assert.equal(task.status, "blocked");

    const handExecutions = (await listResourcesPg(harness.db, { resourceType: "hand_execution" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(handExecutions.length, 0);
    const intents = (await listResourcesPg(harness.db, { resourceType: "task_execution_intent" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(intents.length, 0);

    const violations = await listResourcesPg(harness.db, { resourceType: "tool_proxy_violation" });
    const violation = findRuntimeResource(violations, (resource) => resource.runId === runId);
    assert.equal(violation.status, "blocking");
    assert.equal(violation.scope, "security");
    assert.doesNotMatch(JSON.stringify(violation), new RegExp(rawSecret));

    const exceptions = await listResourcesPg(harness.db, { resourceType: "runtime_exception" });
    const exception = findRuntimeResource(exceptions, (resource) => resource.payload.kind === "tool_proxy_violation");
    assert.equal(exception.payload.severity, "blocking");
    assert.equal(exception.payload.handExecutionId, `hand-execution:${runId}:${blockedTaskId}:${blockedTaskId}-attempt-1`);
    assert.doesNotMatch(JSON.stringify(exception), new RegExp(rawSecret));

    const decisions = await listResourcesPg(harness.db, { resourceType: "recovery_decision" });
    const decision = findRuntimeResource(decisions, (resource) => resource.payload.exceptionId === exception.payload.exceptionId);
    assert.equal(decision.payload.path, "block-for-operator");
    assert.equal(decision.payload.operatorApprovalRequired, true);

    const retry = await scheduler.runOnce({ runId });
    assert.deepEqual(retry.dispatchedTaskIds, []);
    assert.equal(retry.skippedTaskIds.find((entry) => entry.taskId === blockedTaskId)?.reason, "status:blocked");
    assert.deepEqual(submitted, []);

    const historyTypes = (await listHistoryForRunPg(harness.db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.includes("tool_proxy.violation"), true);
    assert.equal(historyTypes.includes("runtime_exception.observed"), true);
    assert.equal(historyTypes.includes("runtime_exception.recovery_decided"), true);
    assert.equal(historyTypes.includes("task.dispatch_blocked"), true);
    assert.equal(historyTypes.includes("hand.execute_queued"), false);
  } finally {
    await harness.close();
  }
});
