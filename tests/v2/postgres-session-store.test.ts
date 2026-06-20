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

test("SessionStore reuses checkpoint id and history idempotency for repeated resourceKey", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db);
    const store = createPostgresSessionStore(db);
    const first = await store.createCheckpoint({
      runId: "run-session-1",
      sessionId: "session-1",
      resourceKey: "checkpoint-key-1",
      checkpointType: "operator",
      summary: "operator checkpoint",
      eventRange: { fromSequence: 1, toSequence: 1 },
      refs: {},
      metrics: { tokenEstimate: 100 },
    });
    const second = await store.createCheckpoint({
      runId: "run-session-1",
      sessionId: "session-1",
      resourceKey: "checkpoint-key-1",
      checkpointType: "operator",
      summary: "operator checkpoint retry",
      eventRange: { fromSequence: 1, toSequence: 1 },
      refs: {},
      metrics: { tokenEstimate: 150 },
    });

    assert.equal(second.id, first.id);
    const loadedByKey = await store.getCheckpoint("checkpoint-key-1");
    assert.equal(loadedByKey?.id, first.id);
    assert.equal(loadedByKey?.summary, "operator checkpoint retry");

    const rows = await db.query<{ id: string; idempotency_key: string | null; payload_json: { checkpointId?: string } }>(
      "select id, idempotency_key, payload_json from southstar.workflow_history where event_type = 'checkpoint.created' order by sequence",
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.idempotency_key, "checkpoint:checkpoint-key-1");
    assert.equal(rows.rows[0]?.payload_json.checkpointId, first.id);
  } finally {
    await db.close();
  }
});

test("SessionStore slices events by anchor, task, correlation, artifact ref, and limit", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db);
    const store = createPostgresSessionStore(db);
    await store.emitEvent({
      eventType: "session.created",
      actorType: "orchestrator",
      runId: "run-session-1",
      taskId: "task-a",
      sessionId: "session-1",
      correlationId: "corr-a",
      payload: { artifactRefs: ["artifact-a"] },
    });
    const anchor = await store.emitEvent({
      eventType: "artifact.created",
      actorType: "hand",
      runId: "run-session-1",
      taskId: "task-b",
      sessionId: "session-1",
      correlationId: "corr-b",
      payload: { artifactRefs: ["artifact-b"] },
    });
    await store.emitEvent({
      eventType: "artifact.accepted",
      actorType: "evaluator",
      runId: "run-session-1",
      taskId: "task-b",
      sessionId: "session-1",
      correlationId: "corr-b",
      payload: { artifactRefs: ["artifact-c"] },
    });

    const around = await store.getEvents("session-1", { aroundEventId: anchor.id, windowBefore: 1, windowAfter: 1 });
    assert.deepEqual(around.map((event) => event.eventType), ["session.created", "artifact.created", "artifact.accepted"]);

    const taskAndCorrelation = await store.getEvents("session-1", { taskId: "task-b", correlationId: "corr-b" });
    assert.deepEqual(taskAndCorrelation.map((event) => event.eventType), ["artifact.created", "artifact.accepted"]);

    const artifact = await store.getEvents("session-1", { artifactRef: "artifact-b" });
    assert.deepEqual(artifact.map((event) => event.eventType), ["artifact.created"]);

    const limited = await store.getEvents("session-1", { limit: 2 });
    assert.deepEqual(limited.map((event) => event.eventType), ["session.created", "artifact.created"]);
  } finally {
    await db.close();
  }
});
