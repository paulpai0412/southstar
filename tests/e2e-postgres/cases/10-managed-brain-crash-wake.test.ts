import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import type { BrainProvider, BrainSessionBinding } from "../../../src/v2/brain/types.ts";
import type { HandBinding, HandProvider } from "../../../src/v2/hands/types.ts";
import { createPostgresSessionStore } from "../../../src/v2/session/postgres-session-store.ts";
import { createPostgresRecoveryController } from "../../../src/v2/session-recovery/postgres-controller.ts";
import { createWorkflowRunPg } from "../../../src/v2/stores/postgres-runtime-store.ts";

test("10 managed brain crash wake: real Postgres session log can wake a new brain", async () => {
  const harness = await createInitializedRealPostgresE2E();
  try {
    await createWorkflowRunPg(harness.db, {
      id: "real-managed-brain-wake",
      status: "running",
      domain: "software",
      goalPrompt: "wake from brain crash",
      workflowManifestJson: JSON.stringify({
        schemaVersion: "southstar.v2",
        workflowId: "wf-managed-brain-wake",
        title: "Managed brain wake",
        goalPrompt: "wake from brain crash",
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

    const sessionStore = createPostgresSessionStore(harness.db);
    await sessionStore.emitEvent({ eventType: "session.created", actorType: "orchestrator", runId: "real-managed-brain-wake", sessionId: "session-real-1", payload: {} });
    await sessionStore.emitEvent({ eventType: "brain.failed", actorType: "brain", runId: "real-managed-brain-wake", taskId: "task-1", sessionId: "session-real-1", payload: { error: "brain crashed" } });

    const controller = createPostgresRecoveryController({
      db: harness.db,
      sessionStore,
      brainProvider: deterministicBrainProvider("managed-brain-e2e"),
      handProvider: deterministicHandProvider("managed-hand-e2e"),
    });
    const result = await controller.recover({
      runId: "real-managed-brain-wake",
      taskId: "task-1",
      sessionId: "session-real-1",
      strategy: "wake-new-brain",
      reason: "brain crashed",
      contextPacketId: "ctx-real-1",
    });

    assert.ok(result.brainBindingId);
    const binding = await harness.db.maybeOne<{ resource_key: string; status: string }>(
      "select resource_key, status from southstar.runtime_resources where resource_type = 'brain_binding' and resource_key = $1",
      [result.brainBindingId],
    );
    assert.equal(binding?.status, "running");
  } finally {
    await harness.close();
  }
});

function deterministicBrainProvider(providerId: string): BrainProvider {
  return {
    providerId,
    async wake(input): Promise<BrainSessionBinding> {
      return {
        id: `brain-${input.runId}-${input.taskId}`,
        providerId,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        contextPacketId: input.contextPacketId,
        status: "running",
        createdAt: new Date().toISOString(),
        payload: { recoveryKey: input.recoveryKey ?? null },
      };
    },
    async cancel() {},
    capabilities: () => ({
      supportsWakeFromSession: true,
      supportsCancel: true,
      supportsSteering: true,
      supportsNativeRewind: false,
    }),
  };
}

function deterministicHandProvider(providerId: string): HandProvider {
  return {
    providerId,
    async provision(input): Promise<HandBinding> {
      return {
        id: `hand-${input.runId}-${input.taskId}`,
        providerId,
        runId: input.runId,
        taskId: input.taskId,
        handName: input.handName,
        status: "provisioned",
        createdAt: new Date().toISOString(),
        payload: { recoveryKey: input.recoveryKey ?? null },
      };
    },
    async execute() {
      return { ok: true, output: "ok", metadata: {} };
    },
    async snapshot(binding) {
      return { id: `snapshot-${binding.id}`, handBindingId: binding.id, createdAt: new Date().toISOString(), metadata: {} };
    },
    async destroy() {},
    capabilities: () => ({
      supportsSnapshot: true,
      supportsDestroy: true,
      supportsReprovision: true,
      keepsCredentialsOutOfSandbox: true,
    }),
  };
}
