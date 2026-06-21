import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { getManagedAgentRunReadModelPg } from "../../src/v2/read-models/managed-agents.ts";

test("managed-agent read model lists brain and hand bindings", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await seedManagedAgentRun(db);

    const model = await getManagedAgentRunReadModelPg(db, "run-read-model-1");
    assert.equal(model.brainBindings.length, 1);
    assert.equal(model.handBindings.length, 1);
    assert.equal(model.checkpoints.length, 1);
    assert.equal(model.toolGrants.length, 2);
    assert.equal(model.resources.some((resource) => resource.resourceType === "artifact_ref"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "hand_execution"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "task_execution_intent"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "evaluator_result"), true);

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/runs/run-read-model-1/managed-agents`);
      assert.equal(response.status, 200);
      const envelope = await response.json() as { ok: true; kind: string; result: Awaited<ReturnType<typeof getManagedAgentRunReadModelPg>> };
      assert.equal(envelope.kind, "managed-agents");
      assert.equal(envelope.result.brainBindings[0]?.id, "brain-1");
      assert.equal(envelope.result.handBindings[0]?.id, "hand-1");
      assert.equal(envelope.result.resources.some((resource) => resource.resourceType === "tool_proxy_violation"), true);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

async function seedManagedAgentRun(db: Parameters<typeof createWorkflowRunPg>[0]): Promise<void> {
  const runId = "run-read-model-1";
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "read model",
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
  await upsertRuntimeResourcePg(db, { resourceType: "brain_binding", resourceKey: "brain-1", runId, taskId: "task-1", sessionId: "session-1", scope: "brain", status: "running", title: "brain", payload: { id: "brain-1", providerId: "fake-brain" } });
  await upsertRuntimeResourcePg(db, { resourceType: "hand_binding", resourceKey: "hand-1", runId, taskId: "task-1", scope: "hand", status: "provisioned", title: "hand", payload: { id: "hand-1", providerId: "fake-hand" } });
  await upsertRuntimeResourcePg(db, { resourceType: "session_checkpoint", resourceKey: "checkpoint-1", runId, taskId: "task-1", sessionId: "session-1", scope: "session", status: "created", title: "checkpoint", payload: { summary: "checkpoint" } });
  await upsertRuntimeResourcePg(db, { resourceType: "vault_lease", resourceKey: "lease-1", runId, taskId: "task-1", sessionId: "session-1", scope: "vault", status: "active", title: "lease", payload: { secretRef: "github-token" } });
  await upsertRuntimeResourcePg(db, { resourceType: "tool_grant", resourceKey: "grant-1", runId, taskId: "task-1", sessionId: "session-1", scope: "tool", status: "active", title: "grant", payload: { serverId: "github" } });
  await upsertRuntimeResourcePg(db, { resourceType: "artifact_ref", resourceKey: "artifact-ref-1", runId, taskId: "task-1", sessionId: "session-1", scope: "artifact", status: "accepted", title: "artifact ref", payload: { artifactRefId: "artifact-ref-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "hand_execution", resourceKey: "hand-execution-1", runId, taskId: "task-1", sessionId: "session-1", scope: "hand", status: "running", title: "hand execution", payload: { handExecutionId: "hand-execution-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "task_execution_intent", resourceKey: "intent-1", runId, taskId: "task-1", sessionId: "session-1", scope: "brain", status: "created", title: "intent", payload: { intentId: "intent-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "evaluator_result", resourceKey: "eval-1", runId, taskId: "task-1", sessionId: "session-1", scope: "evaluator", status: "passed", title: "evaluator", payload: { verdict: "passed" } });
  await upsertRuntimeResourcePg(db, { resourceType: "tool_proxy_violation", resourceKey: "violation-1", runId, taskId: "task-1", sessionId: "session-1", scope: "tool", status: "blocking", title: "violation", payload: { evidenceRef: "hand-execution-1:artifact" } });
}
