import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";

async function seedRun(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await initSouthstarSchema(db);
  await createWorkflowRunPg(db, {
    id: "run-session-1",
    status: "created",
    domain: "software",
    goalPrompt: "session test",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: "wf",
      title: "wf",
      goalPrompt: "g",
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
}

test("SessionStore appends and slices session events", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db);
    const store = createPostgresSessionStore(db);
    const first = await store.emitEvent({
      eventType: "session.created",
      actorType: "orchestrator",
      runId: "run-session-1",
      sessionId: "session-1",
      payload: { reason: "test" },
    });
    const second = await store.emitEvent({
      eventType: "brain.woke",
      actorType: "brain",
      runId: "run-session-1",
      sessionId: "session-1",
      payload: { providerId: "fake" },
    });

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    const events = await store.getEvents("session-1", { afterSequence: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "brain.woke");
  } finally {
    await db.close();
  }
});

test("SessionStore creates and loads checkpoints", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db);
    const store = createPostgresSessionStore(db);
    await store.emitEvent({
      eventType: "session.created",
      actorType: "orchestrator",
      runId: "run-session-1",
      sessionId: "session-1",
      payload: {},
    });
    const checkpoint = await store.createCheckpoint({
      runId: "run-session-1",
      sessionId: "session-1",
      checkpointType: "before-recovery",
      summary: "before recovery",
      eventRange: { fromSequence: 1, toSequence: 1 },
      refs: { artifactRefs: ["artifact-1"] },
      metrics: { tokenEstimate: 100 },
    });
    const loaded = await store.getCheckpoint(checkpoint.id);
    assert.equal(loaded?.checkpointType, "before-recovery");
    assert.deepEqual(loaded?.refs.artifactRefs, ["artifact-1"]);
  } finally {
    await db.close();
  }
});
