import test from "node:test";
import assert from "node:assert/strict";
import type { BrainProvider } from "../../src/v2/brain/types.ts";
import type { HandProvider } from "../../src/v2/hands/types.ts";
import { createRunnableTaskScheduler } from "../../src/v2/scheduler/runnable-task-scheduler.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb, type TestPostgresDb } from "./postgres-test-utils.ts";

test("runnable scheduler builds fresh managed context before hand submit", async () => {
  const db = await createTestPostgresDb();
  const runId = "run-scheduler-managed-context";
  const taskId = "implement-feature";
  const legacyContextPacketId = "legacy-context-should-not-be-used";
  try {
    await seedRun(db, { runId, taskId, legacyContextPacketId });

    const submitted: Array<{ contextPacketRef: string }> = [];
    const scheduler = createRunnableTaskScheduler(db, {
      sessionStore: createPostgresSessionStore(db),
      brainProvider: {
        providerId: "test-brain",
        wake: async (input) => ({
          id: `brain-${input.taskId}`,
          providerId: "test-brain",
          runId: input.runId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          status: "running",
          createdAt: new Date().toISOString(),
          payload: {},
        }),
      } satisfies BrainProvider,
      handProvider: {
        providerId: "test-hand",
        provision: async (input) => ({
          id: `hand-${input.taskId}`,
          providerId: "test-hand",
          runId: input.runId,
          taskId: input.taskId,
          handName: input.handName,
          status: "provisioned",
          createdAt: new Date().toISOString(),
          payload: {},
        }),
        executeTask: async (_binding, input) => {
          submitted.push({ contextPacketRef: input.contextPacketRef });
          return { ok: true, output: `job-${input.taskId}`, metadata: { externalJobId: `job-${input.taskId}` } };
        },
        capabilities: () => ({
          supportsSnapshot: true,
          supportsDestroy: true,
          supportsReprovision: true,
          keepsCredentialsOutOfSandbox: true,
        }),
      } satisfies HandProvider,
    });

    const result = await scheduler.runOnce({ runId });

    assert.deepEqual(result.dispatchedTaskIds, [taskId]);
    assert.equal(submitted.length, 1);

    const packets = await listResourcesPg(db, { resourceType: "context_packet" });
    const newPackets = packets.filter((packet) => packet.resourceKey !== legacyContextPacketId);
    const envelopes = await listResourcesPg(db, { resourceType: "task_envelope" });
    const traces = await listResourcesPg(db, { resourceType: "context_assembly_trace" });
    assert.equal(packets.length, 2);
    assert.equal(newPackets.length, 1);
    assert.equal(envelopes.length, 1);
    assert.equal(traces.length, 1);
    assert.equal(submitted[0]?.contextPacketRef, newPackets[0]?.resourceKey);
    assert.notEqual(submitted[0]?.contextPacketRef, legacyContextPacketId);

    const history = await listHistoryForRunPg(db, runId);
    const dispatchSubmitted = history.find((event) => event.eventType === "task.dispatch_submitted");
    assert.equal(dispatchSubmitted?.payload.contextPacketId, newPackets[0]?.resourceKey);
    assert.equal(dispatchSubmitted?.payload.taskEnvelopeId, envelopes[0]?.resourceKey);
  } finally {
    await db.close();
  }
});

async function seedRun(
  db: TestPostgresDb,
  input: { runId: string; taskId: string; legacyContextPacketId: string },
): Promise<void> {
  const manifest = {
    schemaVersion: "southstar.v2",
    workflowId: "wf-scheduler-managed-context",
    title: "Scheduler managed context",
    goalPrompt: "submit with managed context",
    domain: "software",
    intent: "implement_feature",
    tasks: [{
      id: input.taskId,
      name: "Implement",
      domain: "software",
      dependsOn: [],
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      evaluatorPipelineRef: "software-feature-quality",
      requiredArtifactRefs: ["implementation_report"],
      skillRefs: ["software.implementation"],
      mcpGrantRefs: [],
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 600,
        infraRetry: { maxAttempts: 1 },
      },
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
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    executionPolicy: { maxParallelTasks: 1 },
  };
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: "running",
    domain: "software",
    goalPrompt: "submit with managed context",
    workflowManifestJson: JSON.stringify(manifest),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: input.taskId,
    runId: input.runId,
    taskKey: input.taskId,
    status: "pending",
    sortOrder: 0,
    dependsOn: [],
  });
  await upsertRuntimeResourcePg(db, {
    id: input.legacyContextPacketId,
    resourceType: "context_packet",
    resourceKey: input.legacyContextPacketId,
    runId: input.runId,
    taskId: input.taskId,
    scope: "context",
    status: "created",
    payload: { id: input.legacyContextPacketId },
  });
}
