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
    assert.equal(model.resources.some((resource) => resource.resourceType === "context_packet"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "task_envelope"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "context_assembly_trace"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "memory_item"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "memory_delta"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "rollback_marker"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "artifact_repair_marker"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "evaluator_result"), true);
    assert.equal(model.resources.some((resource) => resource.resourceType === "recovery_execution"), true);
    assertRecoveryExecutionPayloadRedacted(model.resources);

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
      assert.equal(envelope.result.resources.some((resource) => resource.resourceType === "recovery_execution"), true);
      assertRecoveryExecutionPayloadRedacted(envelope.result.resources);
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
  await upsertRuntimeResourcePg(db, { resourceType: "context_packet", resourceKey: "context-packet-1", runId, taskId: "task-1", sessionId: "session-1", scope: "context", status: "created", title: "context packet", payload: { id: "context-packet-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "task_envelope", resourceKey: "task-envelope-1", runId, taskId: "task-1", sessionId: "session-1", scope: "context", status: "created", title: "task envelope", payload: { id: "task-envelope-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "context_assembly_trace", resourceKey: "context-trace-1", runId, taskId: "task-1", sessionId: "session-1", scope: "context", status: "created", title: "context trace", payload: { id: "context-trace-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "memory_item", resourceKey: "memory-item-1", runId, taskId: "task-1", sessionId: "session-1", scope: "memory", status: "active", title: "memory item", payload: { id: "memory-item-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "memory_delta", resourceKey: "memory-delta-1", runId, taskId: "task-1", sessionId: "session-1", scope: "memory", status: "pending_approval", title: "memory delta", payload: { id: "memory-delta-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "rollback_marker", resourceKey: "rollback-marker-1", runId, taskId: "task-1", sessionId: "session-1", scope: "recovery", status: "created", title: "rollback marker", payload: { id: "rollback-marker-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "artifact_repair_marker", resourceKey: "artifact-repair-marker-1", runId, taskId: "task-1", sessionId: "session-1", scope: "artifact", status: "created", title: "artifact repair marker", payload: { id: "artifact-repair-marker-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "evaluator_result", resourceKey: "eval-1", runId, taskId: "task-1", sessionId: "session-1", scope: "evaluator", status: "passed", title: "evaluator", payload: { verdict: "passed" } });
  await upsertRuntimeResourcePg(db, {
    resourceType: "recovery_execution",
    resourceKey: "recovery-execution-1",
    runId,
    taskId: "task-1",
    sessionId: "session-1",
    scope: "recovery",
    status: "succeeded",
    title: "recovery execution",
    payload: {
      schemaVersion: "southstar.recovery-execution.v1",
      executionId: "recovery-execution-1",
      decisionId: "decision-1",
      exceptionId: "exception-1",
      runId,
      taskId: "task-1",
      path: "retry-same-task-new-attempt",
      status: "succeeded",
      providerActions: [
        {
          providerId: "tork",
          action: "cancel",
          status: "failed",
          evidenceRef: "secret-evidence-ref",
          errorExcerpt: "token=secret-value",
          metadata: { raw: "do-not-return" },
        },
      ],
      stateChanges: [
        {
          resourceType: "hand_execution",
          resourceKey: "secret-hand",
          fromStatus: "running",
          toStatus: "lost",
          reason: "recovery",
        },
      ],
      completedAt: "2026-06-22T08:30:00.000Z",
      createdAt: "2026-06-22T08:29:00.000Z",
      metadata: { raw: "do-not-return" },
      evidenceRefs: ["secret-evidence-ref"],
      errorExcerpt: "token=secret-value",
    },
    summary: {
      summarySecret: "summarySecret",
      providerActions: [{ evidenceRef: "summary-evidence-ref", errorExcerpt: "summary-error-excerpt" }],
      stateChanges: [{ resourceKey: "summary-secret-hand" }],
      evidenceRef: "summary-evidence-ref",
      errorExcerpt: "summary-error-excerpt",
      metadata: { raw: "summary-raw-value", nested: { raw: "nested-summary-raw-value" } },
    },
  });
  await upsertRuntimeResourcePg(db, { resourceType: "tool_proxy_violation", resourceKey: "violation-1", runId, taskId: "task-1", sessionId: "session-1", scope: "tool", status: "blocking", title: "violation", payload: { evidenceRef: "hand-execution-1:artifact" } });
}

function assertRecoveryExecutionPayloadRedacted(resources: Awaited<ReturnType<typeof getManagedAgentRunReadModelPg>>["resources"]): void {
  const resource = resources.find((candidate) => candidate.resourceType === "recovery_execution");
  assert.ok(resource, "expected recovery_execution managed resource");
  assert.equal((resource.payload as { providerActionCount?: unknown }).providerActionCount, 1);
  assert.equal((resource.payload as { stateChangeCount?: unknown }).stateChangeCount, 1);

  const serializedResource = JSON.stringify(resource);
  assert.equal(serializedResource.includes('"providerActions"'), false);
  assert.equal(serializedResource.includes('"stateChanges"'), false);
  assert.equal(serializedResource.includes('"evidenceRef"'), false);
  assert.equal(serializedResource.includes('"errorExcerpt"'), false);
  assert.equal(serializedResource.includes('"metadata"'), false);
  assert.equal(serializedResource.includes("summarySecret"), false);
  assert.equal(serializedResource.includes("summary-evidence-ref"), false);
  assert.equal(serializedResource.includes("summary-error-excerpt"), false);
  assert.equal(serializedResource.includes("summary-raw-value"), false);
  assert.equal(serializedResource.includes("token=secret-value"), false);
  assert.equal(serializedResource.includes("do-not-return"), false);
  assert.equal(serializedResource.includes("secret-evidence-ref"), false);
  assert.equal(serializedResource.includes("secret-hand"), false);
}
