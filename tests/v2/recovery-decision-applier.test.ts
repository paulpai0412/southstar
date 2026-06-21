import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import { createRecoveryDecisionApplier } from "../../src/v2/exceptions/recovery-decision-applier.ts";
import { recoveryExecutionResourceKey, startRecoveryExecutionPg } from "../../src/v2/exceptions/recovery-executions.ts";
import { RECOVERY_DECISION_SCHEMA_VERSION } from "../../src/v2/exceptions/types.ts";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("reprovision-hand marks old hand lost, creates replacement hand, checkpoints, and releases task", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createReprovisionDecisionFixture(db, { runId: "run-apply-reprovision" });
    const { runId, taskId, handExecutionId, oldHandBindingId, decision, exception } = fixture;
    const now = "2026-06-21T14:00:00.000Z";

    const result = await createRecoveryDecisionApplier({
      db,
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    }).applyDecision({ decisionResourceKey: decision.resourceKey, now });

    assert.equal(result.status, "applied");

    const oldHand = await getResourceByKeyPg(db, "hand_execution", handExecutionId);
    assert.equal(oldHand?.status, "lost");
    assert.deepEqual(pickKeys(oldHand?.payload, ["status", "terminalAt", "lostReason", "recoveryDecisionId"]), {
      status: "lost",
      terminalAt: now,
      lostReason: "reprovision-hand",
      recoveryDecisionId: decision.decisionId,
    });

    const oldBinding = await getResourceByKeyPg(db, "hand_binding", oldHandBindingId);
    assert.equal(oldBinding?.status, "lost");
    assert.deepEqual(pickKeys(oldBinding?.payload, ["status", "terminalAt", "lostReason", "recoveryDecisionId"]), {
      status: "lost",
      terminalAt: now,
      lostReason: "reprovision-hand",
      recoveryDecisionId: decision.decisionId,
    });

    const task = await db.one<{ status: string; completed_at: Date | null }>(
      "select status, completed_at from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.completed_at, null);

    assert.equal((await getResourceByKeyPg(db, "recovery_decision", decision.resourceKey))?.status, "applied");
    assert.equal((await getResourceByKeyPg(db, "runtime_exception", exception.resourceKey))?.status, "resolved");

    const handBindings = (await listResourcesPg(db, { resourceType: "hand_binding" })).filter(
      (resource) => resource.runId === runId,
    );
    assert.equal(handBindings.length, 2);
    const replacementBinding = handBindings.find((resource) => resource.resourceKey !== oldHandBindingId);
    assert.match(replacementBinding?.resourceKey ?? "", /^hand-/);
    assert.equal(replacementBinding?.status, "provisioned");
    assert.equal((replacementBinding?.payload as { providerId?: string; handName?: string }).providerId, "fake-hand");
    assert.equal((replacementBinding?.payload as { providerId?: string; handName?: string }).handName, "workspace");

    const checkpoints = (await listResourcesPg(db, { resourceType: "session_checkpoint" })).filter(
      (resource) => resource.runId === runId,
    );
    assert.equal(checkpoints.length, 1);
    assert.equal((checkpoints[0]?.payload as { checkpointType?: string }).checkpointType, "before-recovery");

    const runtimeExecutions = (await listResourcesPg(db, { resourceType: "recovery_execution" })).filter(
      (resource) => resource.runId === runId,
    );
    assert.equal(runtimeExecutions.length, 1);
    assert.equal(runtimeExecutions[0]?.status, "succeeded");
    const executionPayload = runtimeExecutions[0]?.payload as {
      stateChanges: Array<{ resourceType: string; resourceKey: string; fromStatus?: string; toStatus?: string; reason: string }>;
      providerActions: Array<{ providerId: string; action: string; status: string; evidenceRef?: string; attemptedAt?: string; succeededAt?: string }>;
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
      ["fake-hand", "cancel", "succeeded", handExecutionId],
      ["fake-hand", "destroy", "succeeded", oldHandBindingId],
      ["fake-hand", "provision", "succeeded", replacementBinding?.resourceKey],
    ]);

    const history = await listHistoryForRunPg(db, runId);
    assert.equal(history.filter((event) => event.eventType === "recovery_decision.applied").length, 1);
    assert.deepEqual(history.find((event) => event.eventType === "recovery_decision.applied")?.payload, {
      recoveryDecisionId: decision.decisionId,
      runId,
      taskId,
      path: "reprovision-hand",
      executionResourceKey: result.executionResourceKey,
      result: "applied",
      status: "applied",
      appliedAt: now,
    });

    const runtimeDecisions = (await listResourcesPg(db, { resourceType: "recovery_decision" })).filter(
      (resource) => (resource.payload as { schemaVersion?: string }).schemaVersion === "southstar.runtime.recovery_decision.v1",
    );
    const managedDecisions = (await listResourcesPg(db, { resourceType: "recovery_decision" })).filter(
      (resource) => (resource.payload as { schemaVersion?: string }).schemaVersion === "southstar.managed-recovery-decision.v1",
    );
    assert.deepEqual(runtimeDecisions.map((resource) => resource.resourceKey), [decision.resourceKey]);
    assert.equal(managedDecisions.length, 1);
  } finally {
    await db.close();
  }
});

test("applyNext skips managed recovery decisions left after reprovision-hand", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createReprovisionDecisionFixture(db, { runId: "run-apply-next-skips-managed-recovery" });
    const applier = createRecoveryDecisionApplier({
      db,
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    });

    const applied = await applier.applyDecision({
      decisionResourceKey: fixture.decision.resourceKey,
      now: "2026-06-21T14:05:00.000Z",
    });
    assert.equal(applied.status, "applied");

    const next = await applier.applyNext({
      runId: fixture.runId,
      now: "2026-06-21T14:06:00.000Z",
    });
    assert.equal(next, null);

    const decisions = await listResourcesPg(db, { resourceType: "recovery_decision" });
    const runtimeDecisions = decisions.filter(
      (resource) => (resource.payload as { schemaVersion?: string }).schemaVersion === RECOVERY_DECISION_SCHEMA_VERSION,
    );
    const managedDecisions = decisions.filter(
      (resource) => (resource.payload as { schemaVersion?: string }).schemaVersion === "southstar.managed-recovery-decision.v1",
    );

    assert.deepEqual(runtimeDecisions.map((resource) => [resource.resourceKey, resource.status]), [[fixture.decision.resourceKey, "applied"]]);
    assert.equal(managedDecisions.length, 1);
    assert.equal(managedDecisions[0]?.status, "recorded");
  } finally {
    await db.close();
  }
});

test("reprovision-hand blocks when dependencies are missing without mutating hand or task", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createReprovisionDecisionFixture(db, { runId: "run-apply-reprovision-missing-deps" });
    const now = "2026-06-21T14:10:00.000Z";

    const result = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: fixture.decision.resourceKey,
      now,
    });

    assert.equal(result.status, "blocked");
    assert.match(result.reason, /missing reprovision-hand dependencies/);
    await assertReprovisionHandAndTaskUnchanged(db, fixture);

    const recoveryExecution = (await listResourcesPg(db, { resourceType: "recovery_execution" })).find(
      (resource) => resource.resourceKey === result.executionResourceKey,
    );
    assert.equal(recoveryExecution?.status, "blocked");
    assert.deepEqual((recoveryExecution?.payload as { providerActions?: unknown[] }).providerActions, []);
    assert.deepEqual((recoveryExecution?.payload as { stateChanges?: Array<{ resourceType: string; toStatus?: string }> }).stateChanges?.map(
      (change) => [change.resourceType, change.toStatus],
    ), [["recovery_decision", "blocked"]]);
    assert.equal((await listResourcesPg(db, { resourceType: "session_checkpoint" })).filter((resource) => resource.runId === fixture.runId).length, 0);
    assert.equal((await listResourcesPg(db, { resourceType: "hand_binding" })).filter((resource) => resource.runId === fixture.runId).length, 1);
  } finally {
    await db.close();
  }
});

test("reprovision-hand replay does not duplicate checkpoint, hand binding, completion, or applied history", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createReprovisionDecisionFixture(db, { runId: "run-apply-reprovision-idempotent" });
    const firstAt = "2026-06-21T14:20:00.000Z";
    const retryAt = "2026-06-21T14:21:00.000Z";
    let destroyCount = 0;
    let provisionCount = 0;
    const handProvider = createFakeHandProvider({ providerId: "fake-hand" });
    const applier = createRecoveryDecisionApplier({
      db,
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: {
        ...handProvider,
        async destroy(binding) {
          destroyCount += 1;
          return handProvider.destroy(binding);
        },
        async provision(input) {
          provisionCount += 1;
          return handProvider.provision(input);
        },
      },
    });

    const first = await applier.applyDecision({ decisionResourceKey: fixture.decision.resourceKey, now: firstAt });
    await setDecisionStatus(db, fixture.decision.resourceKey, "applying");
    const second = await applier.applyDecision({ decisionResourceKey: fixture.decision.resourceKey, now: retryAt });

    assert.equal(first.status, "applied");
    assert.equal(second.status, "applied");
    assert.equal(second.executionResourceKey, first.executionResourceKey);
    assert.equal(destroyCount, 1);
    assert.equal(provisionCount, 1);

    assert.equal((await listResourcesPg(db, { resourceType: "recovery_execution" })).filter((resource) => resource.runId === fixture.runId).length, 1);
    assert.equal((await listResourcesPg(db, { resourceType: "session_checkpoint" })).filter((resource) => resource.runId === fixture.runId).length, 1);
    assert.equal((await listResourcesPg(db, { resourceType: "hand_binding" })).filter((resource) => resource.runId === fixture.runId).length, 2);

    const historyTypes = (await listHistoryForRunPg(db, fixture.runId)).map((event) => event.eventType);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_execution.succeeded").length, 1);
    assert.equal(historyTypes.filter((eventType) => eventType === "checkpoint.created").length, 1);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery.execution_submitted").length, 1);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_decision.applied").length, 1);
  } finally {
    await db.close();
  }
});

test("concurrent reprovision-hand replay reuses staged provider evidence without duplicate provision or destroy", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createReprovisionDecisionFixture(db, { runId: "run-apply-reprovision-concurrent-replay" });
    const firstAt = "2026-06-21T14:22:00.000Z";
    const replayAt = "2026-06-21T14:22:01.000Z";
    const firstProvisionStarted = deferred<void>();
    const releaseFirstProvision = deferred<void>();
    let destroyCount = 0;
    let provisionCount = 0;
    const handProvider = createFakeHandProvider({ providerId: "fake-hand" });
    const applier = createRecoveryDecisionApplier({
      db,
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: {
        ...handProvider,
        async destroy(binding) {
          destroyCount += 1;
          return handProvider.destroy(binding);
        },
        async provision(input) {
          provisionCount += 1;
          if (provisionCount === 1) {
            firstProvisionStarted.resolve();
            await releaseFirstProvision.promise;
          }
          return handProvider.provision(input);
        },
      },
    });

    const first = applier.applyDecision({ decisionResourceKey: fixture.decision.resourceKey, now: firstAt });
    await firstProvisionStarted.promise;
    const replay = applier.applyDecision({ decisionResourceKey: fixture.decision.resourceKey, now: replayAt });

    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirstProvision.resolve();
    const [firstResult, replayResult] = await Promise.all([first, replay]);

    assert.equal(firstResult.status, "applied");
    assert.equal(replayResult.status, "applied");
    assert.equal(replayResult.executionResourceKey, firstResult.executionResourceKey);
    assert.equal(provisionCount, 1);
    assert.equal(destroyCount, 1);

    assert.equal((await listResourcesPg(db, { resourceType: "session_checkpoint" })).filter((resource) => resource.runId === fixture.runId).length, 1);
    assert.equal((await listResourcesPg(db, { resourceType: "hand_binding" })).filter((resource) => resource.runId === fixture.runId).length, 2);
    assert.equal((await listResourcesPg(db, { resourceType: "recovery_execution" })).filter((resource) => resource.runId === fixture.runId).length, 1);

    const historyTypes = (await listHistoryForRunPg(db, fixture.runId)).map((event) => event.eventType);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_execution.succeeded").length, 1);
    assert.equal(historyTypes.filter((eventType) => eventType === "checkpoint.created").length, 1);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery.execution_submitted").length, 1);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_decision.applied").length, 1);
  } finally {
    await db.close();
  }
});

test("requeue-hand-execution applies queue timeout recovery and is idempotent", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue" });
    const { runId, taskId, handExecutionId, decision, exception } = fixture;
    const now = "2026-06-21T12:00:00.000Z";

    const applier = createRecoveryDecisionApplier({ db });
    const first = await applier.applyDecision({ decisionResourceKey: decision.resourceKey, now });
    await db.query(
      "update southstar.runtime_resources set status = 'applying', updated_at = now() where resource_type = 'recovery_decision' and resource_key = $1",
      [decision.resourceKey],
    );
    const second = await applier.applyDecision({ decisionResourceKey: decision.resourceKey, now });

    assert.equal(first.status, "applied");
    assert.equal(second.status, "applied");
    assert.equal(second.executionResourceKey, first.executionResourceKey);

    const hand = await getResourceByKeyPg(db, "hand_execution", handExecutionId);
    assert.equal(hand?.status, "lost");
    const handPayload = hand?.payload as {
      status?: string;
      terminalAt?: string;
      lostReason?: string;
      recoveryDecisionId?: string;
    };
    assert.equal(handPayload.status, "lost");
    assert.equal(handPayload.terminalAt, now);
    assert.equal(handPayload.lostReason, "requeue-hand-execution");
    assert.equal(handPayload.recoveryDecisionId, decision.decisionId);

    const task = await db.one<{ status: string; completed_at: Date | null }>(
      "select status, completed_at from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.completed_at, null);

    const appliedDecision = await getResourceByKeyPg(db, "recovery_decision", decision.resourceKey);
    assert.equal(appliedDecision?.status, "applied");
    const resolvedException = await getResourceByKeyPg(db, "runtime_exception", exception.resourceKey);
    assert.equal(resolvedException?.status, "resolved");

    const recoveryExecutions = await listResourcesPg(db, { resourceType: "recovery_execution" });
    assert.equal(recoveryExecutions.filter((resource) => resource.runId === runId).length, 1);
    const recoveryExecution = recoveryExecutions.find((resource) => resource.runId === runId);
    assert.equal(recoveryExecution?.status, "succeeded");
    const recoveryExecutionPayload = recoveryExecution?.payload as {
      stateChanges: Array<{ toStatus?: string }>;
      providerActions: Array<{
        providerId?: string;
        action?: string;
        status?: string;
        evidenceRef?: string;
        attemptedAt?: string;
        succeededAt?: string;
      }>;
    };
    assert.deepEqual(
      recoveryExecutionPayload.stateChanges.map((change) => change.toStatus),
      ["lost", "pending", "applied", "resolved"],
    );
    assert.deepEqual(recoveryExecutionPayload.providerActions, [
      {
        providerId: "tork",
        action: "cancel",
        status: "succeeded",
        evidenceRef: handExecutionId,
        attemptedAt: now,
        succeededAt: now,
      },
    ]);

    const history = await listHistoryForRunPg(db, runId);
    const historyTypes = history.map((event) => event.eventType);
    assert.equal(historyTypes.includes("recovery_execution.started"), true);
    assert.equal(historyTypes.includes("recovery_execution.succeeded"), true);
    assert.equal(historyTypes.includes("runtime_exception.resolved"), true);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_decision.applied").length, 1);
    const appliedHistory = history.find((event) => event.eventType === "recovery_decision.applied");
    assert.deepEqual(appliedHistory?.payload, {
      recoveryDecisionId: decision.decisionId,
      runId,
      taskId,
      path: "requeue-hand-execution",
      executionResourceKey: first.executionResourceKey,
      result: "applied",
      status: "applied",
      appliedAt: now,
    });
  } finally {
    await db.close();
  }
});

test("requeue-hand-execution resumes an applying decision and finalizes evidence", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-resume-applying" });
    const { runId, decision, exception } = fixture;
    const now = "2026-06-21T12:30:00.000Z";
    await db.query(
      "update southstar.runtime_resources set status = 'applying', updated_at = now() where resource_type = 'recovery_decision' and resource_key = $1",
      [decision.resourceKey],
    );

    const applier = createRecoveryDecisionApplier({ db });
    const result = await applier.applyDecision({ decisionResourceKey: decision.resourceKey, now });

    assert.equal(result.status, "applied");

    const appliedDecision = await getResourceByKeyPg(db, "recovery_decision", decision.resourceKey);
    assert.equal(appliedDecision?.status, "applied");
    const resolvedException = await getResourceByKeyPg(db, "runtime_exception", exception.resourceKey);
    assert.equal(resolvedException?.status, "resolved");

    const recoveryExecution = (await listResourcesPg(db, { resourceType: "recovery_execution" })).find(
      (resource) => resource.runId === runId,
    );
    assert.equal(recoveryExecution?.status, "succeeded");

    const historyTypes = (await listHistoryForRunPg(db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_decision.applied").length, 1);
  } finally {
    await db.close();
  }
});

test("requeue-hand-execution retry completes with original staged evidence after side-effect crash", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-side-effect-crash" });
    const { runId, taskId, handExecutionId, decision, exception } = fixture;
    const startedAt = "2026-06-21T12:35:00.000Z";
    const retryAt = "2026-06-21T12:36:00.000Z";
    const secondRetryAt = "2026-06-21T12:37:00.000Z";
    const executionResourceKey = recoveryExecutionResourceKey(decision.decisionId);
    const expectedStateChanges = [
      {
        resourceType: "hand_execution",
        resourceKey: handExecutionId,
        fromStatus: "queued",
        toStatus: "lost",
        reason: "requeue-hand-execution",
      },
      {
        resourceType: "workflow_task",
        resourceKey: `${runId}:${taskId}`,
        fromStatus: "queued",
        toStatus: "pending",
        reason: "requeue-hand-execution",
      },
      {
        resourceType: "recovery_decision",
        resourceKey: decision.resourceKey,
        fromStatus: "applying",
        toStatus: "applied",
        reason: "requeue-hand-execution applied",
      },
      {
        resourceType: "runtime_exception",
        resourceKey: exception.resourceKey,
        fromStatus: "observed",
        toStatus: "resolved",
        reason: "requeue-hand-execution applied",
      },
    ];
    const expectedProviderActions = [
      {
        providerId: "tork",
        action: "cancel",
        status: "succeeded",
        evidenceRef: handExecutionId,
        attemptedAt: startedAt,
        succeededAt: startedAt,
      },
    ];

    await setDecisionStatus(db, decision.resourceKey, "applying");
    await startRecoveryExecutionPg(db, {
      decisionId: decision.decisionId,
      exceptionId: decision.payload.exceptionId,
      runId,
      taskId,
      path: decision.payload.path,
      now: startedAt,
    });
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(
                jsonb_set(payload_json, '{stateChanges}', $1::jsonb),
                '{providerActions}',
                $2::jsonb
              ),
              updated_at = now()
        where resource_type = 'recovery_execution'
          and resource_key = $3
          and status = 'started'`,
      [JSON.stringify(expectedStateChanges), JSON.stringify(expectedProviderActions), executionResourceKey],
    );
    await db.query(
      `update southstar.runtime_resources
          set status = 'lost',
              payload_json = payload_json || $1::jsonb,
              updated_at = now()
        where resource_type = 'hand_execution'
          and resource_key = $2`,
      [
        JSON.stringify({
          status: "lost",
          terminalAt: startedAt,
          lostReason: "requeue-hand-execution",
          recoveryDecisionId: decision.decisionId,
        }),
        handExecutionId,
      ],
    );
    await db.query(
      "update southstar.workflow_tasks set status = 'pending', completed_at = null, updated_at = now() where run_id = $1 and id = $2",
      [runId, taskId],
    );

    const result = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: retryAt,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.executionResourceKey, executionResourceKey);

    await setDecisionStatus(db, decision.resourceKey, "applying");
    const secondResult = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: secondRetryAt,
    });

    assert.equal(secondResult.status, "applied");
    assert.equal(secondResult.executionResourceKey, executionResourceKey);

    const recoveryExecution = (await listResourcesPg(db, { resourceType: "recovery_execution" })).find(
      (resource) => resource.resourceKey === executionResourceKey,
    );
    assert.equal(recoveryExecution?.status, "succeeded");
    const recoveryExecutionPayload = recoveryExecution?.payload as {
      stateChanges: unknown[];
      providerActions: unknown[];
      completedAt?: string;
    };
    assert.deepEqual(recoveryExecutionPayload.stateChanges, expectedStateChanges);
    assert.deepEqual(recoveryExecutionPayload.providerActions, expectedProviderActions);
    assert.equal(recoveryExecutionPayload.completedAt, startedAt);

    const appliedDecision = await getResourceByKeyPg(db, "recovery_decision", decision.resourceKey);
    assert.equal(appliedDecision?.status, "applied");
    const resolvedException = await getResourceByKeyPg(db, "runtime_exception", exception.resourceKey);
    assert.equal(resolvedException?.status, "resolved");

    const historyTypes = (await listHistoryForRunPg(db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_execution.started").length, 1);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_execution.succeeded").length, 1);
    assert.equal(historyTypes.filter((eventType) => eventType === "runtime_exception.resolved").length, 1);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_decision.applied").length, 1);
  } finally {
    await db.close();
  }
});

test("requeue-hand-execution completes with canonical staged evidence after a stale start read", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-stale-start-read" });
    const { runId, taskId, handExecutionId, decision, exception } = fixture;
    const startedAt = "2026-06-21T12:37:00.000Z";
    const executionResourceKey = recoveryExecutionResourceKey(decision.decisionId);
    const expectedStateChanges = [
      {
        resourceType: "hand_execution",
        resourceKey: handExecutionId,
        fromStatus: "queued",
        toStatus: "lost",
        reason: "requeue-hand-execution",
      },
      {
        resourceType: "workflow_task",
        resourceKey: `${runId}:${taskId}`,
        fromStatus: "queued",
        toStatus: "pending",
        reason: "requeue-hand-execution",
      },
      {
        resourceType: "recovery_decision",
        resourceKey: decision.resourceKey,
        fromStatus: "applying",
        toStatus: "applied",
        reason: "requeue-hand-execution applied",
      },
      {
        resourceType: "runtime_exception",
        resourceKey: exception.resourceKey,
        fromStatus: "observed",
        toStatus: "resolved",
        reason: "requeue-hand-execution applied",
      },
    ];
    const expectedProviderActions = [
      {
        providerId: "tork",
        action: "cancel",
        status: "succeeded",
        evidenceRef: handExecutionId,
        attemptedAt: startedAt,
        succeededAt: startedAt,
      },
    ];

    await db.query("drop trigger if exists stage_recovery_evidence_after_started_history on southstar.workflow_history");
    await db.query("drop function if exists southstar.stage_recovery_evidence_after_started_history()");
    await db.query(`
      create function southstar.stage_recovery_evidence_after_started_history()
      returns trigger
      language plpgsql
      as $$
      begin
        if new.run_id = '${runId}' and new.event_type = 'recovery_execution.started' then
          update southstar.runtime_resources
             set payload_json = jsonb_set(
                   jsonb_set(payload_json, '{stateChanges}', '${JSON.stringify(expectedStateChanges)}'::jsonb),
                   '{providerActions}',
                   '${JSON.stringify(expectedProviderActions)}'::jsonb
                 ),
                 summary_json = summary_json || '{"evidenceStagedAt":"${startedAt}","stateChangeCount":4,"providerActionCount":1}'::jsonb,
                 updated_at = now()
           where resource_type = 'recovery_execution'
             and resource_key = '${executionResourceKey}'
             and status = 'started';

          update southstar.runtime_resources
             set status = 'lost',
                 payload_json = payload_json || '{"status":"lost","terminalAt":"${startedAt}","lostReason":"requeue-hand-execution","recoveryDecisionId":"${decision.decisionId}"}'::jsonb,
                 updated_at = now()
           where resource_type = 'hand_execution'
             and resource_key = '${handExecutionId}';

          update southstar.workflow_tasks
             set status = 'pending',
                 completed_at = null,
                 updated_at = now()
           where run_id = '${runId}'
             and id = '${taskId}';
        end if;
        return new;
      end
      $$;
    `);
    await db.query(`
      create trigger stage_recovery_evidence_after_started_history
      after insert on southstar.workflow_history
      for each row execute function southstar.stage_recovery_evidence_after_started_history()
    `);

    const result = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: startedAt,
    });

    assert.equal(result.status, "applied");
    assert.equal(result.executionResourceKey, executionResourceKey);

    const recoveryExecution = (await listResourcesPg(db, { resourceType: "recovery_execution" })).find(
      (resource) => resource.resourceKey === executionResourceKey,
    );
    assert.equal(recoveryExecution?.status, "succeeded");
    const recoveryExecutionPayload = recoveryExecution?.payload as {
      stateChanges: unknown[];
      providerActions: unknown[];
    };
    assert.deepEqual(recoveryExecutionPayload.stateChanges, expectedStateChanges);
    assert.deepEqual(recoveryExecutionPayload.providerActions, expectedProviderActions);
  } finally {
    await db.close();
  }
});

test("blocked decision retry completes paired started recovery execution without mutating hand or task", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-blocked-repair" });
    const { runId, taskId, decision } = fixture;
    const startedAt = "2026-06-21T12:40:00.000Z";
    const retryAt = "2026-06-21T12:41:00.000Z";
    const executionResourceKey = recoveryExecutionResourceKey(decision.decisionId);
    const reason = "operator blocked retry";

    await setDecisionStatus(db, decision.resourceKey, "applying");
    await startRecoveryExecutionPg(db, {
      decisionId: decision.decisionId,
      exceptionId: decision.payload.exceptionId,
      runId,
      taskId,
      path: decision.payload.path,
      now: startedAt,
    });
    await patchDecisionPayload(db, decision.resourceKey, { statusReason: reason, blockedAt: startedAt });
    await setDecisionStatus(db, decision.resourceKey, "blocked");

    const result = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: retryAt,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.executionResourceKey, executionResourceKey);
    assert.match(result.reason, /operator blocked retry/);
    await assertHandAndTaskUnchanged(db, fixture);

    const recoveryExecution = (await listResourcesPg(db, { resourceType: "recovery_execution" })).find(
      (resource) => resource.resourceKey === executionResourceKey,
    );
    assert.equal(recoveryExecution?.status, "blocked");
    const recoveryExecutionPayload = recoveryExecution?.payload as {
      stateChanges: unknown[];
      providerActions: unknown[];
      completedAt?: string;
    };
    assert.deepEqual(recoveryExecutionPayload.stateChanges, [
      {
        resourceType: "recovery_decision",
        resourceKey: decision.resourceKey,
        fromStatus: "applying",
        toStatus: "blocked",
        reason,
      },
    ]);
    assert.deepEqual(recoveryExecutionPayload.providerActions, []);
    assert.equal(recoveryExecutionPayload.completedAt, startedAt);
  } finally {
    await db.close();
  }
});

test("terminal decision repair is idempotent when concurrent callers use different timestamps", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-terminal-repair-race" });
    const { runId, taskId, decision } = fixture;
    const blockedAt = "2026-06-21T12:42:00.000Z";
    const laterAt = "2026-06-21T12:43:00.000Z";
    const executionResourceKey = recoveryExecutionResourceKey(decision.decisionId);
    const reason = "operator blocked retry";

    await setDecisionStatus(db, decision.resourceKey, "applying");
    await startRecoveryExecutionPg(db, {
      decisionId: decision.decisionId,
      exceptionId: decision.payload.exceptionId,
      runId,
      taskId,
      path: decision.payload.path,
      now: blockedAt,
    });
    await patchDecisionPayload(db, decision.resourceKey, { statusReason: reason, blockedAt });
    await setDecisionStatus(db, decision.resourceKey, "blocked");

    await db.query("drop trigger if exists delay_terminal_recovery_completion on southstar.runtime_resources");
    await db.query("drop function if exists southstar.delay_terminal_recovery_completion()");
    await db.query(`
      create function southstar.delay_terminal_recovery_completion()
      returns trigger
      language plpgsql
      as $$
      begin
        if old.resource_type = 'recovery_execution'
          and old.resource_key = '${executionResourceKey}'
          and old.status = 'started'
          and new.status = 'blocked'
          and new.payload_json->>'completedAt' = '${blockedAt}' then
          perform pg_sleep(0.25);
        end if;
        return new;
      end
      $$;
    `);
    await db.query(`
      create trigger delay_terminal_recovery_completion
      before update on southstar.runtime_resources
      for each row execute function southstar.delay_terminal_recovery_completion()
    `);

    const applier = createRecoveryDecisionApplier({ db });
    const [first, second] = await Promise.all([
      applier.applyDecision({ decisionResourceKey: decision.resourceKey, now: blockedAt }),
      applier.applyDecision({ decisionResourceKey: decision.resourceKey, now: laterAt }),
    ]);

    assert.equal(first.status, "blocked");
    assert.equal(second.status, "blocked");
    assert.equal(first.executionResourceKey, executionResourceKey);
    assert.equal(second.executionResourceKey, executionResourceKey);

    const recoveryExecutions = (await listResourcesPg(db, { resourceType: "recovery_execution" })).filter(
      (resource) => resource.resourceKey === executionResourceKey,
    );
    assert.equal(recoveryExecutions.length, 1);
    assert.equal(recoveryExecutions[0]?.status, "blocked");
    const recoveryExecutionPayload = recoveryExecutions[0]?.payload as {
      stateChanges: unknown[];
      providerActions: unknown[];
      completedAt?: string;
    };
    assert.equal(recoveryExecutionPayload.completedAt, blockedAt);
    assert.deepEqual(recoveryExecutionPayload.stateChanges, [
      {
        resourceType: "recovery_decision",
        resourceKey: decision.resourceKey,
        fromStatus: "applying",
        toStatus: "blocked",
        reason,
      },
    ]);
    assert.deepEqual(recoveryExecutionPayload.providerActions, []);

    const historyTypes = (await listHistoryForRunPg(db, runId)).map((event) => event.eventType);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_execution.blocked").length, 1);
  } finally {
    await db.close();
  }
});

test("applyDecision does not revert a terminal decision observed after a stale pre-lock read", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-stale-terminal-claim" });
    const { decision } = fixture;
    const staleReadAt = "2026-06-21T12:44:00.000Z";
    const blockedAt = "2026-06-21T12:43:30.000Z";
    const reason = "operator blocked while stale caller was claiming";
    let injectedTerminalDecision = false;
    const staleReadDb: SouthstarDb = {
      query: db.query.bind(db),
      one: db.one.bind(db),
      async maybeOne(sql, params = []) {
        const row = await db.maybeOne(sql, params);
        if (
          !injectedTerminalDecision &&
          String(sql).includes("from southstar.runtime_resources") &&
          params[0] === "recovery_decision" &&
          params[1] === decision.resourceKey
        ) {
          injectedTerminalDecision = true;
          await patchDecisionPayload(db, decision.resourceKey, { blockedAt, statusReason: reason });
          await setDecisionStatus(db, decision.resourceKey, "blocked");
        }
        return row;
      },
      tx: db.tx.bind(db),
      close: async () => {},
    };

    const result = await createRecoveryDecisionApplier({ db: staleReadDb }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now: staleReadAt,
    });

    assert.equal(result.status, "blocked");
    assert.match(result.reason, /operator blocked while stale caller was claiming/);
    await assertHandAndTaskUnchanged(db, fixture);

    const finalDecision = await getResourceByKeyPg(db, "recovery_decision", decision.resourceKey);
    assert.equal(finalDecision?.status, "blocked");
    const finalPayload = finalDecision?.payload as { blockedAt?: string; statusReason?: string };
    assert.equal(finalPayload.blockedAt, blockedAt);
    assert.equal(finalPayload.statusReason, reason);
    const recoveryExecutions = (await listResourcesPg(db, { resourceType: "recovery_execution" })).filter(
      (resource) => resource.runId === fixture.runId,
    );
    assert.equal(recoveryExecutions.length, 0);
  } finally {
    await db.close();
  }
});

test("applyDecision claims a recorded requeue decision before starting recovery execution", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-claim-before-execution" });
    const { handExecutionId, decision } = fixture;
    const now = "2026-06-21T12:45:00.000Z";
    await db.query("drop trigger if exists assert_recovery_decision_claimed_before_execution_start on southstar.runtime_resources");
    await db.query("drop function if exists southstar.assert_recovery_decision_claimed_before_execution_start()");
    await db.query(`
      create function southstar.assert_recovery_decision_claimed_before_execution_start()
      returns trigger
      language plpgsql
      as $$
      declare
        decision_status text;
      begin
        if new.resource_type = 'recovery_execution' and new.status = 'started' then
          select status into decision_status
            from southstar.runtime_resources
           where resource_type = 'recovery_decision'
             and resource_key = '${decision.resourceKey}';
          if decision_status <> 'applying' then
            raise exception 'decision was % before recovery execution start', decision_status;
          end if;
        end if;
        return new;
      end
      $$;
    `);
    await db.query(`
      create trigger assert_recovery_decision_claimed_before_execution_start
      before insert or update on southstar.runtime_resources
      for each row execute function southstar.assert_recovery_decision_claimed_before_execution_start()
    `);

    const result = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now,
    });

    assert.equal(result.status, "applied");
    assert.equal((await getResourceByKeyPg(db, "hand_execution", handExecutionId))?.status, "lost");
  } finally {
    await db.close();
  }
});

test("applyDecision writes applied history before marking the decision applied", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-history-before-applied" });
    const { decision } = fixture;
    const now = "2026-06-21T12:50:00.000Z";
    await db.query("drop trigger if exists assert_recovery_decision_applied_history_first on southstar.runtime_resources");
    await db.query("drop function if exists southstar.assert_recovery_decision_applied_history_first()");
    await db.query(`
      create function southstar.assert_recovery_decision_applied_history_first()
      returns trigger
      language plpgsql
      as $$
      declare
        applied_history_count integer;
      begin
        if new.resource_type = 'recovery_decision' and new.resource_key = '${decision.resourceKey}' and new.status = 'applied' then
          select count(*) into applied_history_count
            from southstar.workflow_history
           where run_id = '${fixture.runId}'
             and idempotency_key = '${decision.resourceKey}:applied';
          if applied_history_count <> 1 then
            raise exception 'applied history count was % before decision applied', applied_history_count;
          end if;
        end if;
        return new;
      end
      $$;
    `);
    await db.query(`
      create trigger assert_recovery_decision_applied_history_first
      before update on southstar.runtime_resources
      for each row execute function southstar.assert_recovery_decision_applied_history_first()
    `);

    const result = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now,
    });

    assert.equal(result.status, "applied");
    const historyTypes = (await listHistoryForRunPg(db, fixture.runId)).map((event) => event.eventType);
    assert.equal(historyTypes.filter((eventType) => eventType === "recovery_decision.applied").length, 1);
  } finally {
    await db.close();
  }
});

test("applyDecision claims a recorded requeue decision before mutating hand or task", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-claim-first" });
    const { runId, taskId, handExecutionId, decision } = fixture;
    const now = "2026-06-21T13:00:00.000Z";
    await db.query("drop trigger if exists assert_recovery_decision_claimed_before_hand_mutation on southstar.runtime_resources");
    await db.query("drop function if exists southstar.assert_recovery_decision_claimed_before_hand_mutation()");
    await db.query(`
      create function southstar.assert_recovery_decision_claimed_before_hand_mutation()
      returns trigger
      language plpgsql
      as $$
      declare
        decision_status text;
      begin
        if new.resource_type = 'hand_execution' and new.resource_key = '${handExecutionId}' and new.status = 'lost' then
          select status into decision_status
            from southstar.runtime_resources
           where resource_type = 'recovery_decision'
             and resource_key = '${decision.resourceKey}';
          if decision_status <> 'applying' then
            raise exception 'decision was % before hand mutation', decision_status;
          end if;
        end if;
        return new;
      end
      $$;
    `);
    await db.query(`
      create trigger assert_recovery_decision_claimed_before_hand_mutation
      before update on southstar.runtime_resources
      for each row execute function southstar.assert_recovery_decision_claimed_before_hand_mutation()
    `);

    const result = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: decision.resourceKey,
      now,
    });

    assert.equal(result.status, "applied");
    assert.equal((await getResourceByKeyPg(db, "hand_execution", handExecutionId))?.status, "lost");
    const task = await db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = $2",
      [runId, taskId],
    );
    assert.equal(task.status, "pending");
  } finally {
    await db.close();
  }
});

test("requeue-hand-execution fail-closed cases do not silently mutate hand or task", async () => {
  const cases: Array<{
    name: string;
    mutate(input: Awaited<ReturnType<typeof createRequeueDecisionFixture>>): Promise<void>;
    expectedStatus: "blocked" | "failed" | "superseded";
    expectedReason: RegExp;
  }> = [
    {
      name: "missing taskId",
      async mutate({ db, decision }) {
        await patchDecisionPayload(db, decision.resourceKey, { taskId: undefined });
      },
      expectedStatus: "blocked",
      expectedReason: /missing taskId/,
    },
    {
      name: "missing referenced hand execution",
      async mutate({ db, handExecutionId }) {
        await db.query("delete from southstar.runtime_resources where resource_type = 'hand_execution' and resource_key = $1", [
          handExecutionId,
        ]);
      },
      expectedStatus: "blocked",
      expectedReason: /hand execution .* not found/,
    },
    {
      name: "unsupported path",
      async mutate({ db, decision }) {
        await patchDecisionPayload(db, decision.resourceKey, { path: "wake-new-brain" });
      },
      expectedStatus: "blocked",
      expectedReason: /unsupported recovery path wake-new-brain/,
    },
    {
      name: "failed status",
      async mutate({ db, decision }) {
        await setDecisionStatus(db, decision.resourceKey, "failed");
      },
      expectedStatus: "failed",
      expectedReason: /decision already failed/,
    },
  ];

  for (const item of cases) {
    const db = await createTestPostgresDb();
    try {
      const fixture = await createRequeueDecisionFixture(db, { runId: `run-apply-requeue-${item.name.replaceAll(" ", "-")}` });
      await item.mutate(fixture);

      const result = await createRecoveryDecisionApplier({ db }).applyDecision({
        decisionResourceKey: fixture.decision.resourceKey,
        now: "2026-06-21T13:10:00.000Z",
      });

      assert.equal(result.status, item.expectedStatus, item.name);
      assert.match(result.reason, item.expectedReason, item.name);
      await assertHandAndTaskUnchanged(db, fixture);
    } finally {
      await db.close();
    }
  }
});

test("waiting operator approval is not auto-applied and leaves hand and task unchanged", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixture = await createRequeueDecisionFixture(db, { runId: "run-apply-requeue-waiting-approval" });
    await setDecisionStatus(db, fixture.decision.resourceKey, "waiting_operator_approval");

    const next = await createRecoveryDecisionApplier({ db }).applyNext({
      runId: fixture.runId,
      now: "2026-06-21T13:20:00.000Z",
    });
    assert.equal(next, null);

    const direct = await createRecoveryDecisionApplier({ db }).applyDecision({
      decisionResourceKey: fixture.decision.resourceKey,
      now: "2026-06-21T13:20:00.000Z",
    });
    assert.equal(direct.status, "skipped");
    assert.match(direct.reason, /waiting for operator approval/);
    await assertHandAndTaskUnchanged(db, fixture);
  } finally {
    await db.close();
  }
});

async function createRequeueDecisionFixture(db: Awaited<ReturnType<typeof createTestPostgresDb>>, input: { runId: string }) {
  const runId = input.runId;
  const taskId = "task-a";
  const sessionId = "session-a";
  const attemptId = "attempt-1";
  const handExecutionId = `hand-execution:${runId}:${taskId}:${attemptId}`;

  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "apply queue timeout recovery",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "queued",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: sessionId,
  });
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId,
    taskId,
    sessionId,
    scope: "hand",
    status: "queued",
    title: "Hand execution task-a",
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      providerId: "tork",
      runId,
      taskId,
      sessionId,
      attemptId,
      brainBindingId: "brain-binding-a",
      handBindingId: "hand-binding-a",
      externalJobId: "job-queued",
      status: "queued",
      queuedAt: "2026-06-21T11:50:00.000Z",
      queueTimeoutSeconds: 300,
      heartbeatTimeoutSeconds: 300,
    },
    summary: { providerId: "tork", attemptId },
    metrics: {},
  });

  const controller = createRuntimeExceptionController({ db });
  const exception = await controller.observe({
    runId,
    taskId,
    sessionId,
    attemptId,
    handExecutionId,
    source: "tork-observer",
    kind: "tork_queue_timeout",
    severity: "recoverable",
    observedAt: "2026-06-21T11:59:00.000Z",
    evidenceRefs: [handExecutionId],
    providerEvidence: { externalJobId: "job-queued" },
  });
  const decision = await controller.decide(await controller.classify(exception));

  return { db, runId, taskId, sessionId, attemptId, handExecutionId, exception, decision };
}

async function createReprovisionDecisionFixture(db: Awaited<ReturnType<typeof createTestPostgresDb>>, input: { runId: string }) {
  const runId = input.runId;
  const taskId = "task-a";
  const sessionId = "session-a";
  const attemptId = "attempt-1";
  const oldHandBindingId = `hand-binding:${runId}:${taskId}:old`;
  const handExecutionId = `hand-execution:${runId}:${taskId}:${attemptId}`;

  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "apply reprovision recovery",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "failed",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: sessionId,
  });
  await db.query(
    "update southstar.workflow_tasks set completed_at = $1, updated_at = now() where run_id = $2 and id = $3",
    ["2026-06-21T13:55:00.000Z", runId, taskId],
  );
  await createPostgresSessionStore(db).emitEvent({
    eventType: "session.created",
    actorType: "orchestrator",
    runId,
    taskId,
    sessionId,
    idempotencyKey: `${runId}:${sessionId}:created`,
    payload: { reason: "reprovision fixture" },
  });
  await upsertRuntimeResourcePg(db, {
    id: oldHandBindingId,
    resourceType: "hand_binding",
    resourceKey: oldHandBindingId,
    runId,
    taskId,
    scope: "hand",
    status: "running",
    title: "Old workspace hand",
    payload: {
      id: oldHandBindingId,
      providerId: "fake-hand",
      runId,
      taskId,
      handName: "workspace",
      status: "running",
      createdAt: "2026-06-21T13:50:00.000Z",
      payload: { externalLeaseId: "lease-old" },
    },
    summary: { providerId: "fake-hand", handName: "workspace" },
    metrics: {},
  });
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId,
    taskId,
    sessionId,
    scope: "hand",
    status: "running",
    title: "Hand execution task-a",
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      providerId: "fake-hand",
      runId,
      taskId,
      sessionId,
      attemptId,
      brainBindingId: "brain-binding-a",
      handBindingId: oldHandBindingId,
      externalJobId: "job-running",
      status: "running",
      queuedAt: "2026-06-21T13:51:00.000Z",
      startedAt: "2026-06-21T13:52:00.000Z",
      queueTimeoutSeconds: 300,
      heartbeatTimeoutSeconds: 300,
    },
    summary: { providerId: "fake-hand", attemptId },
    metrics: {},
  });

  const controller = createRuntimeExceptionController({ db });
  const exception = await controller.observe({
    runId,
    taskId,
    sessionId,
    attemptId,
    handExecutionId,
    handBindingId: oldHandBindingId,
    source: "tork-observer",
    kind: "tork_running_hang",
    severity: "recoverable",
    observedAt: "2026-06-21T13:59:00.000Z",
    evidenceRefs: [handExecutionId, oldHandBindingId],
    providerEvidence: { externalJobId: "job-running" },
  });
  const decision = await controller.decide(await controller.classify(exception));

  return { db, runId, taskId, sessionId, attemptId, oldHandBindingId, handExecutionId, exception, decision };
}

async function setDecisionStatus(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  decisionResourceKey: string,
  status: string,
): Promise<void> {
  await db.query(
    "update southstar.runtime_resources set status = $1, updated_at = now() where resource_type = 'recovery_decision' and resource_key = $2",
    [status, decisionResourceKey],
  );
}

async function patchDecisionPayload(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  decisionResourceKey: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const decision = await getResourceByKeyPg(db, "recovery_decision", decisionResourceKey);
  const payload = { ...(decision?.payload as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete payload[key];
    } else {
      payload[key] = value;
    }
  }
  await db.query(
    "update southstar.runtime_resources set payload_json = $1::jsonb, task_id = $2, updated_at = now() where resource_type = 'recovery_decision' and resource_key = $3",
    [JSON.stringify(payload), typeof payload.taskId === "string" ? payload.taskId : null, decisionResourceKey],
  );
}

async function assertHandAndTaskUnchanged(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  fixture: Awaited<ReturnType<typeof createRequeueDecisionFixture>>,
): Promise<void> {
  const hand = await getResourceByKeyPg(db, "hand_execution", fixture.handExecutionId);
  if (hand) {
    assert.equal(hand.status, "queued");
    assert.equal((hand.payload as { status?: string }).status, "queued");
  }
  const task = await db.one<{ status: string; completed_at: Date | null }>(
    "select status, completed_at from southstar.workflow_tasks where run_id = $1 and id = $2",
    [fixture.runId, fixture.taskId],
  );
  assert.equal(task.status, "queued");
  assert.equal(task.completed_at, null);
}

async function assertReprovisionHandAndTaskUnchanged(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  fixture: Awaited<ReturnType<typeof createReprovisionDecisionFixture>>,
): Promise<void> {
  const hand = await getResourceByKeyPg(db, "hand_execution", fixture.handExecutionId);
  assert.equal(hand?.status, "running");
  assert.equal((hand?.payload as { status?: string }).status, "running");
  const binding = await getResourceByKeyPg(db, "hand_binding", fixture.oldHandBindingId);
  assert.equal(binding?.status, "running");
  assert.equal((binding?.payload as { status?: string }).status, "running");
  const task = await db.one<{ status: string; completed_at: Date | null }>(
    "select status, completed_at from southstar.workflow_tasks where run_id = $1 and id = $2",
    [fixture.runId, fixture.taskId],
  );
  assert.equal(task.status, "failed");
  assert.ok(task.completed_at);
}

function pickKeys(value: unknown, keys: string[]): Record<string, unknown> {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(error: unknown): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
