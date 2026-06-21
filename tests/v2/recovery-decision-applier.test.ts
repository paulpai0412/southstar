import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import { createRecoveryDecisionApplier } from "../../src/v2/exceptions/recovery-decision-applier.ts";
import { recoveryExecutionResourceKey, startRecoveryExecutionPg } from "../../src/v2/exceptions/recovery-executions.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

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
    assert.equal(recoveryExecutionPayload.completedAt, retryAt);

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
    assert.equal(recoveryExecutionPayload.completedAt, retryAt);
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
