import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { persistBrainBindingPg, persistHandBindingPg, listManagedBindingsForRunPg } from "../../src/v2/meta-harness/postgres-bindings.ts";

test("managed brain and hand bindings persist as runtime resources", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedRun(db, "run-bindings-1");
    await seedRun(db, "run-bindings-2");
    await persistBrainBindingPg(db, {
      id: "brain-binding-1",
      providerId: "fake-brain",
      runId: "run-bindings-1",
      taskId: "task-1",
      sessionId: "session-1",
      contextPacketId: "ctx-1",
      status: "running",
      createdAt: "2026-06-20T01:00:00.000Z",
      payload: { model: "fake-model" },
    });
    await persistHandBindingPg(db, {
      id: "hand-binding-1",
      providerId: "fake-hand",
      runId: "run-bindings-1",
      taskId: "task-1",
      handName: "workspace",
      status: "provisioned",
      createdAt: "2026-06-20T01:00:01.000Z",
      payload: { externalJobId: "job-1" },
    });
    await persistBrainBindingPg(db, {
      id: "brain-binding-other",
      providerId: "fake-brain",
      runId: "run-bindings-2",
      taskId: "task-2",
      sessionId: "session-2",
      contextPacketId: "ctx-2",
      status: "running",
      createdAt: "2026-06-20T01:00:02.000Z",
      payload: {},
    });

    const listed = await listManagedBindingsForRunPg(db, "run-bindings-1");
    assert.deepEqual(listed.brainBindings.map((binding) => binding.id), ["brain-binding-1"]);
    assert.deepEqual(listed.handBindings.map((binding) => binding.id), ["hand-binding-1"]);
    assert.equal(listed.brainBindings[0]?.status, "running");
    assert.equal(listed.brainBindings[0]?.providerId, "fake-brain");
    assert.equal(listed.brainBindings[0]?.payload.model, "fake-model");
    assert.equal(listed.handBindings[0]?.status, "provisioned");
    assert.equal(listed.handBindings[0]?.providerId, "fake-hand");
    assert.equal(listed.handBindings[0]?.payload.externalJobId, "job-1");
  } finally {
    await db.close();
  }
});

async function seedRun(db: Awaited<ReturnType<typeof createTestPostgresDb>>, id: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id,
    status: "created",
    domain: "software",
    goalPrompt: "bindings",
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
