import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import { observeTorkHandExecutionExceptionsPg } from "../../../src/v2/executor/tork-observer.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";

test("14 Tork queue timeout recovery: stale queued hand execution records requeue decision", async () => {
  const harness = await createInitializedRealPostgresE2E();
  const runId = "real-tork-queue-timeout-recovery";
  const taskId = "implement";
  const sessionId = "root-real-queue-timeout";
  const attemptId = `${taskId}-attempt-1`;
  const handExecutionId = `hand-execution:${runId}:${taskId}:${attemptId}`;
  try {
    await seedRunAndTask(harness.db, { runId, taskId, sessionId });
    await upsertRuntimeResourcePg(harness.db, {
      resourceType: "hand_execution",
      resourceKey: handExecutionId,
      runId,
      taskId,
      sessionId,
      scope: "hand",
      status: "queued",
      title: `Hand execution ${taskId}`,
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId,
        providerId: "tork",
        runId,
        taskId,
        sessionId,
        attemptId,
        externalJobId: "job-queue-timeout-real",
        status: "queued",
        queuedAt: "2026-06-21T00:00:00.000Z",
        queueTimeoutSeconds: 30,
      },
      summary: { providerId: "tork", attemptId },
    });

    const observed = await observeTorkHandExecutionExceptionsPg(harness.db, {
      now: "2026-06-21T00:01:00.000Z",
    });

    assert.deepEqual(observed.observedKinds, ["tork_queue_timeout"]);
    const exceptions = await listResourcesPg(harness.db, { resourceType: "runtime_exception" });
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.status, "observed");
    assert.equal(exceptions[0]?.payload.kind, "tork_queue_timeout");
    assert.equal(exceptions[0]?.payload.handExecutionId, handExecutionId);
    assert.deepEqual(exceptions[0]?.payload.evidenceRefs, [handExecutionId]);
    assert.equal(exceptions[0]?.payload.providerEvidence.externalJobId, "job-queue-timeout-real");

    const decisions = await listResourcesPg(harness.db, { resourceType: "recovery_decision" });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.path, "requeue-hand-execution");
    assert.equal(decisions[0]?.payload.previousAttemptId, attemptId);
    assert.match(String(decisions[0]?.payload.nextAttemptId), new RegExp(`^${attemptId}:recovery-`));
    assert.equal(decisions[0]?.payload.operatorApprovalRequired, false);

    const history = await listHistoryForRunPg(harness.db, runId);
    assert.equal(history.some((event) => event.eventType === "runtime_exception.observed"), true);
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
    goalPrompt: "recover stale queued Tork hand execution",
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
    title: "Tork queue timeout recovery",
    goalPrompt: "recover stale queued Tork hand execution",
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
      skillRefs: ["skill.software-implementation"],
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
