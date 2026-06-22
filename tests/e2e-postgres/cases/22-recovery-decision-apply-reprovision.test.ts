import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E as createPostgresRealHarness } from "../postgres-real-harness.ts";
import type { BrainProvider, BrainSessionBinding } from "../../../src/v2/brain/types.ts";
import { createRecoveryDecisionApplier } from "../../../src/v2/exceptions/recovery-decision-applier.ts";
import { createRuntimeExceptionController } from "../../../src/v2/exceptions/runtime-exception-controller.ts";
import type { HandBinding, HandProvider } from "../../../src/v2/hands/types.ts";
import { createPostgresSessionStore } from "../../../src/v2/session/postgres-session-store.ts";
import { getResourceByKeyPg, listHistoryForRunPg, listResourcesPg, upsertRuntimeResourcePg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  canonicalHandExecutionId,
  seedHardeningRunTask,
} from "../runtime-hardening-fixtures.ts";

test("22 recovery decision apply reprovision creates replacement hand and releases task", async () => {
  const harness = await createPostgresRealHarness();
  const runId = "real-recovery-apply-reprovision";
  const taskId = "task-a";
  const sessionId = `session-${runId}-${taskId}`;
  const attemptId = "attempt-1";
  const oldHandBindingId = "hand-binding-old-reprovision";
  const handExecutionId = canonicalHandExecutionId(runId, taskId, attemptId);
  const now = "2026-06-21T13:00:00.000Z";
  try {
    await seedHardeningRunTask(harness.db, { runId, taskId, runStatus: "running", taskStatus: "running" });
    await createPostgresSessionStore(harness.db).emitEvent({
      eventType: "session.created",
      actorType: "orchestrator",
      runId,
      taskId,
      sessionId,
      payload: {},
    });
    await upsertRuntimeResourcePg(harness.db, {
      id: oldHandBindingId,
      resourceType: "hand_binding",
      resourceKey: oldHandBindingId,
      runId,
      taskId,
      sessionId,
      scope: "hand",
      status: "running",
      title: "Old hand binding",
      payload: {
        schemaVersion: "southstar.runtime.hand_binding.v1",
        providerId: "managed-hand-e2e",
        handName: "workspace",
        status: "running",
      },
    });
    await upsertRuntimeResourcePg(harness.db, {
      resourceType: "hand_execution",
      resourceKey: handExecutionId,
      runId,
      taskId,
      sessionId,
      scope: "hand",
      status: "running",
      title: `Hand execution ${taskId}`,
      payload: {
        schemaVersion: "southstar.runtime.hand_execution.v1",
        handExecutionId,
        runId,
        taskId,
        sessionId,
        attemptId,
        providerId: "managed-hand-e2e",
        handBindingId: oldHandBindingId,
        status: "running",
        externalJobId: "job-running-apply-reprovision",
        startedAt: "2026-06-21T12:58:00.000Z",
        lastHeartbeatAt: "2026-06-21T12:58:05.000Z",
        queueTimeoutSeconds: 120,
        heartbeatTimeoutSeconds: 20,
      },
      summary: { providerId: "managed-hand-e2e", attemptId },
    });

    const controller = createRuntimeExceptionController({ db: harness.db });
    const exception = await controller.observe({
      runId,
      taskId,
      sessionId,
      attemptId,
      handExecutionId,
      source: "tork-observer",
      kind: "tork_running_hang",
      severity: "recoverable",
      observedAt: now,
      evidenceRefs: [handExecutionId, oldHandBindingId],
      providerEvidence: { status: "running", handBindingId: oldHandBindingId },
    });
    const decision = await controller.decide(await controller.classify(exception));
    assert.equal(decision.payload.path, "reprovision-hand");

    const result = await createRecoveryDecisionApplier({
      db: harness.db,
      sessionStore: createPostgresSessionStore(harness.db),
      brainProvider: deterministicBrainProvider("managed-brain-e2e"),
      handProvider: deterministicHandProvider("managed-hand-e2e"),
    }).applyDecision({ decisionResourceKey: decision.resourceKey, now: "2026-06-21T13:01:00.000Z" });

    assert.equal(result.status, "applied");
    const task = await harness.db.one<{ status: string; completed_at: Date | null }>(
      "select status, completed_at from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.completed_at, null);

    assert.equal((await getResourceByKeyPg(harness.db, "hand_execution", handExecutionId))?.status, "lost");
    assert.equal((await getResourceByKeyPg(harness.db, "hand_binding", oldHandBindingId))?.status, "lost");
    assert.equal((await getResourceByKeyPg(harness.db, "runtime_exception", exception.resourceKey))?.status, "resolved");
    assert.equal((await getResourceByKeyPg(harness.db, "recovery_decision", decision.resourceKey))?.status, "applied");

    const handBindings = (await listResourcesPg(harness.db, { resourceType: "hand_binding" })).filter((resource) => resource.runId === runId);
    const replacementBinding = handBindings.find((resource) => resource.resourceKey !== oldHandBindingId);
    assert.ok(replacementBinding);
    assert.equal(replacementBinding.status, "provisioned");
    assert.equal(replacementBinding.payload.providerId, "managed-hand-e2e");
    assert.equal(replacementBinding.payload.handName, "workspace");

    const checkpoints = (await listResourcesPg(harness.db, { resourceType: "session_checkpoint" })).filter((resource) => resource.runId === runId);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.payload.checkpointType, "before-recovery");

    const execution = await getResourceByKeyPg(harness.db, "recovery_execution", result.executionResourceKey ?? "");
    assert.equal(execution?.status, "succeeded");
    const executionPayload = execution?.payload as {
      stateChanges: Array<{ resourceType: string; toStatus?: string; reason: string }>;
      providerActions: Array<{ providerId?: string; action?: string; status?: string; evidenceRef?: string }>;
    };
    assert.deepEqual(executionPayload.stateChanges.map((change) => [change.resourceType, change.toStatus]), [
      ["hand_execution", "lost"],
      ["hand_binding", "lost"],
      ["session_checkpoint", "created"],
      ["hand_binding", "provisioned"],
      ["workflow_task", "pending"],
      ["recovery_decision", "applied"],
      ["runtime_exception", "resolved"],
    ]);
    assert.deepEqual(executionPayload.providerActions.map((action) => [action.providerId, action.action, action.status, action.evidenceRef]), [
      ["managed-hand-e2e", "cancel", "skipped", handExecutionId],
      ["managed-hand-e2e", "destroy", "requested", oldHandBindingId],
      ["managed-hand-e2e", "provision", "succeeded", replacementBinding.resourceKey],
    ]);

    const historyTypes = (await listHistoryForRunPg(harness.db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.includes("checkpoint.created"), true);
    assert.equal(historyTypes.includes("runtime_exception.resolved"), true);
    assert.equal(historyTypes.includes("recovery_execution.succeeded"), true);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_decision.applied").length, 1);
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
        createdAt: "2026-06-21T13:00:30.000Z",
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
        id: `hand-${input.runId}-${input.taskId}-${input.recoveryKey ?? "replacement"}`,
        providerId,
        runId: input.runId,
        taskId: input.taskId,
        handName: input.handName,
        status: "provisioned",
        createdAt: "2026-06-21T13:00:45.000Z",
        payload: { recoveryKey: input.recoveryKey ?? null },
      };
    },
    async execute() {
      return { ok: true, output: "ok", metadata: {} };
    },
    async snapshot(binding) {
      return { id: `snapshot-${binding.id}`, handBindingId: binding.id, createdAt: "2026-06-21T13:00:40.000Z", metadata: {} };
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
