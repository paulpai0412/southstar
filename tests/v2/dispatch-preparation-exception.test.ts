import test from "node:test";
import assert from "node:assert/strict";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import { observeDispatchPreparationException } from "../../src/v2/scheduler/dispatch-preparation-exception.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";

test("dispatch preparation helper observes exception and records retry decision with redacted provider evidence", async () => {
  const db = await createTestPostgresDb();
  const runId = "run-dispatch-preparation-exception";
  const taskId = "task-a";
  const sessionId = `root-${runId}-${taskId}`;
  try {
    await initSouthstarSchema(db);
    await seedRun(db, runId, taskId);

    const rawError = "dispatch preparation failed payload={\"authorization\":\"Bearer secret-token\",\"apiKey\":\"plain-secret-value\"} token sk-1234567890abcdefghijklmnopqrst";
    const observed = await observeDispatchPreparationException(db, {
      runId,
      taskId,
      sessionId,
      attemptId: `${taskId}-attempt-1`,
      recoveryKey: `task-dispatch:${runId}:${taskId}`,
      errorMessage: rawError,
    });

    assert.equal(observed.exception.payload.kind, "dispatch_preparation_failed");
    assert.equal(observed.exception.payload.source, "scheduler");
    assert.equal(observed.exception.payload.severity, "recoverable");
    assert.equal(
      observed.exception.payload.providerEvidence?.errorExcerpt,
      "dispatch preparation failed payload={\"authorization\":\"[REDACTED]\",\"apiKey\":\"[REDACTED]\"} token [REDACTED]",
    );
    assert.deepEqual(observed.exception.payload.evidenceRefs, [`task-dispatch:${runId}:${taskId}`]);
    assert.equal(observed.decision.payload.path, "retry-same-task-new-attempt");
    assert.equal(observed.decision.payload.exceptionId, observed.exception.payload.exceptionId);

    const exceptions = (await listResourcesPg(db, { resourceType: "runtime_exception" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0]?.payload.kind, "dispatch_preparation_failed");

    const decisions = (await listResourcesPg(db, { resourceType: "recovery_decision" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.payload.exceptionId, observed.exception.payload.exceptionId);
    assert.equal(decisions[0]?.payload.path, "retry-same-task-new-attempt");
  } finally {
    await db.close();
  }
});

async function seedRun(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  await seedSoftwareLibraryGraph(db);
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "observe prep failures",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: runId,
      title: "Dispatch preparation fixture",
      goalPrompt: "observe prep failures",
      tasks: [{
        id: taskId,
        name: taskId,
        domain: "software",
        dependsOn: [],
        roleRef: "maker",
        agentProfileRef: "software-maker-pi",
        evaluatorPipelineRef: "software-feature-quality",
        requiredArtifactRefs: ["implementation_report"],
        skillRefs: ["software.implementation"],
        mcpGrantRefs: [],
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
        subagents: [],
      }],
      harnessDefinitions: [{
        id: "pi",
        kind: "pi-agent",
        entrypoint: "southstar-agent-runner",
        image: "southstar/pi-agent:local",
        capabilities: ["software"],
        inputProtocol: "task-envelope-v2",
        eventProtocol: "southstar-events-v1",
        supportsCheckpoint: true,
        supportsSteering: true,
        supportsProgress: true,
      }],
      evaluators: [],
      memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true },
      vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
      steeringPolicy: { enabled: true, acceptedSignals: [] },
      learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
      effortPolicy: {
        complexity: "standard",
        maxBrains: 1,
        maxHandsPerBrain: 1,
        maxParallelTasks: 1,
        maxToolCallsPerTask: 10,
        maxInputTokensPerBrain: 20_000,
        maxCostMicrosUsd: 100_000,
        stopWhenEvidenceSufficient: true,
      },
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "claimed",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: `root-${runId}-${taskId}`,
  });
}
