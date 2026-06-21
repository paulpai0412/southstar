import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import { ingestTaskRunResultPg } from "../../../src/v2/executor/postgres-tork-callback.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";

test("16 stale callback superseded attempt: older callback is observed without reopening current task", async () => {
  const harness = await createInitializedRealPostgresE2E();
  const runId = "real-late-callback-superseded-attempt";
  const taskId = "implement";
  const oldSessionId = "root-real-superseded-old";
  const currentSessionId = "root-real-superseded-current";
  const oldAttemptId = `${taskId}-attempt-1`;
  const currentAttemptId = `${taskId}-attempt-2`;
  const oldHandExecutionId = `hand-execution:${runId}:${taskId}:${oldAttemptId}`;
  const currentHandExecutionId = `hand-execution:${runId}:${taskId}:${currentAttemptId}`;
  try {
    await seedRunAndTask(harness.db, { runId, taskId, sessionId: currentSessionId });
    await upsertRuntimeResourcePg(harness.db, {
      resourceType: "hand_execution",
      resourceKey: oldHandExecutionId,
      runId,
      taskId,
      sessionId: oldSessionId,
      scope: "hand",
      status: "superseded",
      title: `Superseded hand execution ${taskId}`,
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId: oldHandExecutionId,
        providerId: "tork",
        runId,
        taskId,
        sessionId: oldSessionId,
        attemptId: oldAttemptId,
        externalJobId: "job-superseded-old-real",
        status: "superseded",
        terminalAt: "2026-06-21T00:00:20.000Z",
      },
      summary: { providerId: "tork", attemptId: oldAttemptId },
    });
    await upsertRuntimeResourcePg(harness.db, {
      resourceType: "hand_execution",
      resourceKey: currentHandExecutionId,
      runId,
      taskId,
      sessionId: currentSessionId,
      scope: "hand",
      status: "completed",
      title: `Current hand execution ${taskId}`,
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId: currentHandExecutionId,
        providerId: "tork",
        runId,
        taskId,
        sessionId: currentSessionId,
        attemptId: currentAttemptId,
        externalJobId: "job-current-real",
        status: "completed",
        terminalAt: "2026-06-21T00:00:30.000Z",
      },
      summary: { providerId: "tork", attemptId: currentAttemptId, accepted: true },
    });

    const result = await ingestTaskRunResultPg(harness.db, {
      runId,
      taskId,
      rootSessionId: oldSessionId,
      ok: true,
      attempts: 1,
      attemptId: oldAttemptId,
      artifact: { kind: "implementation_report", summary: "stale completion from older attempt" },
      metrics: { durationMs: 1 },
      events: [],
      receivedAt: "2026-06-21T00:00:40.000Z",
    });

    assert.deepEqual(result, { accepted: false });
    const task = await harness.db.one<{ status: string; root_session_id: string | null }>(
      "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "running");
    assert.equal(task.root_session_id, currentSessionId);

    const handExecutions = await listResourcesPg(harness.db, { resourceType: "hand_execution" });
    const currentHand = handExecutions.find((resource) => resource.resourceKey === currentHandExecutionId);
    const oldHand = handExecutions.find((resource) => resource.resourceKey === oldHandExecutionId);
    assert.equal(currentHand?.status, "completed");
    assert.equal(currentHand?.payload.attemptId, currentAttemptId);
    assert.equal(oldHand?.status, "superseded");

    const artifactRefs = await listResourcesPg(harness.db, { resourceType: "artifact_ref" });
    assert.equal(artifactRefs.length, 0);

    const exceptions = await listResourcesPg(harness.db, { resourceType: "runtime_exception" });
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "stale_callback");
    assert.equal(exceptions[0]?.payload.attemptId, oldAttemptId);
    assert.equal(exceptions[0]?.payload.handExecutionId, oldHandExecutionId);
    assert.equal(exceptions[0]?.payload.providerEvidence.latestAttemptId, currentAttemptId);

    const decisions = await listResourcesPg(harness.db, { resourceType: "recovery_decision" });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.path, "none-observe-only");
    assert.equal(decisions[0]?.payload.operatorApprovalRequired, false);
    assert.equal(decisions[0]?.payload.nextAttemptId, undefined);

    const history = await listHistoryForRunPg(harness.db, runId);
    assert.equal(history.some((event) => event.eventType === "executor.callback_received"), true);
    assert.equal(history.some((event) => event.eventType === "executor.callback_ignored_stale_attempt"), true);
    assert.equal(history.some((event) => event.eventType === "runtime_exception.recovery_decided"), true);
  } finally {
    await harness.close();
  }
});

async function seedRunAndTask(db: SouthstarDb, input: { runId: string; taskId: string; sessionId: string }): Promise<void> {
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: "running",
    domain: "software",
    goalPrompt: "ignore stale superseded callback",
    workflowManifestJson: JSON.stringify(manifest(input.runId, input.taskId)),
    executionProjectionJson: JSON.stringify({ executor: "tork", handRuntime: "per-task" }),
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: input.taskId,
    runId: input.runId,
    taskKey: input.taskId,
    status: "running",
    sortOrder: 1,
    dependsOn: [],
    rootSessionId: input.sessionId,
  });
}

function manifest(runId: string, taskId: string) {
  return {
    schemaVersion: "southstar.v2",
    workflowId: `wf-${runId}`,
    title: "Stale callback superseded attempt",
    goalPrompt: "ignore stale superseded callback",
    tasks: [{
      id: taskId,
      name: "Implement",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 600,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
      skillRefs: ["software.implementation"],
      subagents: [{ id: "impl", harnessId: "codex", prompt: "complete the task", requiredArtifacts: ["implementation_report"] }],
    }],
    harnessDefinitions: [{
      id: "codex",
      kind: "codex",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v1",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation_report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    executionPolicy: { maxParallelTasks: 1 },
  };
}
