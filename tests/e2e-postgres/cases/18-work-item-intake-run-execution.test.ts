import test from "node:test";
import assert from "node:assert/strict";
import type { ExecutorSubmitRequest } from "../../../src/v2/executor/provider.ts";
import { createWorkflowTaskPg, listHistoryForRunPg, listResourcesPg, upsertRuntimeResourcePg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import { getWorkItemPg } from "../../../src/v2/work-items/postgres-work-items.ts";
import { materializeRunFromWorkItemPg } from "../../../src/v2/work-items/run-materialization.ts";
import {
  acceptedArtifactRefs,
  asRecord,
  createManagedScheduler,
  createRuntimeServerWithoutBackgroundLoops,
  findRuntimeResource,
  hardeningExecutionProjection,
  hardeningWorkflowManifest,
  postJson,
} from "../runtime-hardening-fixtures.ts";

test("18 work item intake run execution: materialized work item schedules per-task hand and completes", async () => {
  const harness = await createInitializedRealPostgresE2E();
  const runId = "real-work-item-intake-run-execution";
  const taskId = "task-a";
  const submitted: ExecutorSubmitRequest[] = [];
  const server = await createRuntimeServerWithoutBackgroundLoops(harness.db);
  try {
    const materialized = await materializeRunFromWorkItemPg(harness.db, {
      sourceProvider: "api",
      sourceScope: "runtime-hardening",
      sourceRef: "case-18",
      title: "Runtime hardening work item",
      body: "Execute materialized runtime hardening work",
      domain: "software",
      runId,
      workflowManifest: hardeningWorkflowManifest(runId, taskId),
      executionProjection: hardeningExecutionProjection,
      metadata: { caseId: "18" },
    });

    const workItem = await getWorkItemPg(harness.db, materialized.workItemId);
    assert.equal(workItem?.runRefs[0]?.runId, runId);
    assert.equal(workItem?.runRefs[0]?.runAttempt, 1);

    const runContext = await harness.db.one<{ runtime_context_json: { workItemRef?: { workItemId?: string; runAttempt?: number } } }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      [runId],
    );
    assert.equal(runContext.runtime_context_json.workItemRef?.workItemId, materialized.workItemId);
    assert.equal(runContext.runtime_context_json.workItemRef?.runAttempt, 1);

    await createWorkflowTaskPg(harness.db, {
      id: taskId,
      runId,
      taskKey: taskId,
      status: "pending",
      sortOrder: 1,
      dependsOn: [],
    });
    await upsertRuntimeResourcePg(harness.db, {
      resourceType: "context_packet",
      resourceKey: `context-${runId}-${taskId}`,
      runId,
      taskId,
      scope: "brain",
      status: "ready",
      title: `Context ${taskId}`,
      payload: { id: `context-${runId}-${taskId}` },
    });

    const execute = await postJson<{ runId: string; status: string; schedulerWakeRequested: true }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(runId)}/execute`,
      {},
    );
    assert.deepEqual(execute, { runId, status: "scheduling", schedulerWakeRequested: true });

    const scheduler = createManagedScheduler(harness.db, server.url, submitted);
    const scheduled = await scheduler.runOnce({ runId });
    assert.deepEqual(scheduled.dispatchedTaskIds, [taskId]);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.workflow.tasks[0]?.id, taskId);
    const queuedHand = findRuntimeResource(
      await listResourcesPg(harness.db, { resourceType: "hand_execution" }),
      (resource) => resource.runId === runId && resource.taskId === taskId,
    );
    assert.equal(queuedHand.status, "queued");
    assert.equal(asRecord(queuedHand.payload).externalJobId, "job-task-a");

    await postJson(server.url, "/api/v2/tork/callback", {
      runId,
      taskId,
      rootSessionId: `session-${runId}-${taskId}`,
      ok: true,
      attempts: 1,
      attemptId: `${taskId}-attempt-1`,
      artifact: { kind: "implementation_report", summary: "completed from materialized work item" },
      metrics: { durationMs: 1 },
      events: [],
      receivedAt: "2026-06-21T11:00:00.000Z",
    });

    const finalRun = await harness.db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
    assert.equal(finalRun.status, "passed");
    assert.equal(acceptedArtifactRefs(await listResourcesPg(harness.db, { resourceType: "artifact_ref" })).length, 1);

    const historyTypes = (await listHistoryForRunPg(harness.db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.includes("run.scheduling_started"), true);
    assert.equal(historyTypes.includes("hand.execute_queued"), true);
    assert.equal(historyTypes.includes("run.completed"), true);
  } finally {
    await server.close();
    await harness.close();
  }
});
