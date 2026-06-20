import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";
import { listManagedBindingsForRunPg } from "../../src/v2/meta-harness/postgres-bindings.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createPostgresRecoveryController } from "../../src/v2/session-recovery/postgres-controller.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb, initSouthstarSchema, type TestPostgresDb } from "./postgres-test-utils.ts";

test("Postgres recovery controller records decision, checkpoints, wakes brain, and persists binding", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTask(db, "run-recovery-controller-brain", "task-1", "session-1");
    const sessionStore = createPostgresSessionStore(db);
    await sessionStore.emitEvent({
      eventType: "session.created",
      actorType: "orchestrator",
      runId: "run-recovery-controller-brain",
      taskId: "task-1",
      sessionId: "session-1",
      payload: { reason: "test" },
    });

    const controller = createPostgresRecoveryController({
      db,
      sessionStore,
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    });

    const result = await controller.recover({
      runId: "run-recovery-controller-brain",
      taskId: "task-1",
      sessionId: "session-1",
      strategy: "wake-new-brain",
      reason: "fresh brain after stalled evaluator",
      contextPacketId: "ctx-1",
    });

    assert.equal(result.strategy, "wake-new-brain");
    assert.match(result.recoveryDecisionId, /^recovery-decision-/);
    assert.match(result.beforeRecoveryCheckpointId, /^checkpoint-/);
    assert.match(result.brainBindingId ?? "", /^brain-/);
    assert.equal(result.handBindingId, undefined);

    const bindings = await listManagedBindingsForRunPg(db, "run-recovery-controller-brain");
    assert.deepEqual(bindings.brainBindings.map((binding) => binding.id), [result.brainBindingId]);
    assert.equal(bindings.brainBindings[0]?.providerId, "fake-brain");
    assert.equal(bindings.brainBindings[0]?.contextPacketId, "ctx-1");
    assert.deepEqual(bindings.handBindings, []);

    const decisions = await listResourcesPg(db, { resourceType: "recovery_decision" });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.id, result.recoveryDecisionId);
    assert.equal((decisions[0]?.payload as { strategy?: string }).strategy, "wake-new-brain");
    assert.equal(decisions[0]?.status, "recorded");

    const checkpoints = await listResourcesPg(db, { resourceType: "session_checkpoint" });
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.id, result.beforeRecoveryCheckpointId);
    assert.equal((checkpoints[0]?.payload as { checkpointType?: string }).checkpointType, "before-recovery");

    const history = await listHistoryForRunPg(db, "run-recovery-controller-brain");
    assert.equal(history.some((event) => event.eventType === "recovery.decision_recorded"), true);
    assert.equal(history.some((event) => event.eventType === "checkpoint.created"), true);
    assert.equal(history.some((event) => event.eventType === "recovery.execution_submitted"), true);
  } finally {
    await db.close();
  }
});

test("Postgres recovery controller reprovision-hand strategy persists a hand binding", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTask(db, "run-recovery-controller-hand", "task-1", "session-1");
    const sessionStore = createPostgresSessionStore(db);
    await sessionStore.emitEvent({
      eventType: "session.created",
      actorType: "orchestrator",
      runId: "run-recovery-controller-hand",
      taskId: "task-1",
      sessionId: "session-1",
      payload: { reason: "test" },
    });

    const controller = createPostgresRecoveryController({
      db,
      sessionStore,
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    });

    const result = await controller.recover({
      runId: "run-recovery-controller-hand",
      taskId: "task-1",
      sessionId: "session-1",
      strategy: "reprovision-hand",
      reason: "workspace tool lease was lost",
      handName: "workspace",
      handResources: { repoRoot: "/workspace" },
    });

    assert.equal(result.strategy, "reprovision-hand");
    assert.match(result.recoveryDecisionId, /^recovery-decision-/);
    assert.match(result.beforeRecoveryCheckpointId, /^checkpoint-/);
    assert.match(result.handBindingId ?? "", /^hand-/);
    assert.equal(result.brainBindingId, undefined);

    const bindings = await listManagedBindingsForRunPg(db, "run-recovery-controller-hand");
    assert.deepEqual(bindings.brainBindings, []);
    assert.deepEqual(bindings.handBindings.map((binding) => binding.id), [result.handBindingId]);
    assert.equal(bindings.handBindings[0]?.providerId, "fake-hand");
    assert.equal(bindings.handBindings[0]?.handName, "workspace");
  } finally {
    await db.close();
  }
});

async function seedRunTask(db: TestPostgresDb, runId: string, taskId: string, sessionId: string): Promise<void> {
  await initSouthstarSchema(db);
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "recovery controller",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: "wf-recovery-controller",
      title: "Recovery Controller",
      goalPrompt: "recover",
      tasks: [],
      harnessDefinitions: [],
      evaluators: [],
      memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true },
      vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
      steeringPolicy: { enabled: true, acceptedSignals: [] },
      learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
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
    status: "running",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: sessionId,
  });
}
