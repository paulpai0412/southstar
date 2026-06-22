import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeExceptionController } from "../../src/v2/exceptions/runtime-exception-controller.ts";
import {
  RECOVERY_DECISION_RESOURCE_TYPE,
  type RuntimeRecoveryDecisionRecord,
} from "../../src/v2/exceptions/types.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  listResourcesPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb, type TestPostgresDb } from "./postgres-test-utils.ts";

test("POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval approves a waiting runtime decision", async () => {
  const db = await createTestPostgresDb();
  try {
    const decision = await seedWaitingRuntimeDecision(db, { runId: "run-operator-approve" });

    const response = await postRecoveryDecisionApproval(db, decision.payload.runId, decision.decisionId, {
      decision: "approved",
      reason: "operator reviewed workspace rollback",
    });

    assert.equal(response.status, 200);
    const envelope = await response.json() as ApprovalEnvelope;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.kind, "recovery-decision-approval");
    assert.deepEqual(envelope.result, {
      decisionId: decision.decisionId,
      resourceKey: decision.resourceKey,
      status: "approved",
      operatorApprovalResourceKey: `operator_approval:${decision.decisionId}`,
    });

    const persistedDecision = await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, decision.resourceKey);
    assert.equal(persistedDecision?.status, "approved");
    const operatorApproval = await getResourceByKeyPg(db, "operator_approval", `operator_approval:${decision.decisionId}`);
    assert.equal(operatorApproval?.status, "approved");
    assert.deepEqual(pickKeys(operatorApproval?.payload, ["decisionId", "operatorDecision", "reason"]), {
      decisionId: decision.decisionId,
      operatorDecision: "approved",
      reason: "operator reviewed workspace rollback",
    });

    const history = await listHistoryForRunPg(db, decision.payload.runId);
    const operatorEvents = history.filter((event) => event.eventType === "recovery_decision.operator_decided");
    assert.equal(operatorEvents.length, 1);
    assert.equal(operatorEvents[0]?.actorType, "operator");
    assert.deepEqual(pickKeys(operatorEvents[0]?.payload, ["decisionId", "operatorDecision", "reason"]), {
      decisionId: decision.decisionId,
      operatorDecision: "approved",
      reason: "operator reviewed workspace rollback",
    });
  } finally {
    await db.close();
  }
});

test("POST /api/v2/runs/:runId/recovery-decisions/:decisionId/apply applies an approved runtime decision", async () => {
  const db = await createTestPostgresDb();
  try {
    const decision = await seedWaitingRuntimeDecision(db, { runId: "run-operator-apply-approved" });
    await createWorkflowTaskPg(db, {
      id: decision.payload.taskId ?? "task-a",
      runId: decision.payload.runId,
      taskKey: decision.payload.taskId ?? "task-a",
      status: "running",
      sortOrder: 0,
      dependsOn: [],
    });
    const approval = await postRecoveryDecisionApproval(db, decision.payload.runId, decision.decisionId, {
      decision: "approved",
      reason: "operator approved workspace rollback",
    });
    assert.equal(approval.status, 200);

    const response = await postRecoveryDecisionApply(db, decision.payload.runId, decision.decisionId);

    assert.equal(response.status, 200);
    const envelope = await response.json() as ApplyEnvelope;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.kind, "recovery-decision-apply");
    assert.equal(envelope.result.status, "blocked");
    assert.match(envelope.result.reason, /unsupported recovery path rollback-workspace/);

    const persistedDecision = await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, decision.resourceKey);
    assert.equal(persistedDecision?.status, "blocked");
  } finally {
    await db.close();
  }
});

test("POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval rejects and blocks a waiting runtime decision", async () => {
  const db = await createTestPostgresDb();
  try {
    const decision = await seedWaitingRuntimeDecision(db, { runId: "run-operator-reject" });

    const response = await postRecoveryDecisionApproval(db, decision.payload.runId, decision.decisionId, {
      decision: "rejected",
      reason: "operator wants manual inspection first",
    });

    assert.equal(response.status, 200);
    const envelope = await response.json() as ApprovalEnvelope;
    assert.equal(envelope.result.status, "blocked");

    const persistedDecision = await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, decision.resourceKey);
    assert.equal(persistedDecision?.status, "blocked");
    assert.deepEqual(pickKeys(persistedDecision?.payload, ["decisionId", "operatorDecision", "operatorReason"]), {
      decisionId: decision.decisionId,
      operatorDecision: "rejected",
      operatorReason: "operator wants manual inspection first",
    });
    const operatorApproval = await getResourceByKeyPg(db, "operator_approval", `operator_approval:${decision.decisionId}`);
    assert.equal(operatorApproval?.status, "rejected");
  } finally {
    await db.close();
  }
});

test("POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval is idempotent for repeated identical decisions", async () => {
  const db = await createTestPostgresDb();
  try {
    const approved = await seedWaitingRuntimeDecision(db, { runId: "run-operator-approve-idempotent" });
    const rejected = await seedWaitingRuntimeDecision(db, { runId: "run-operator-reject-idempotent" });

    const firstApproval = await postRecoveryDecisionApproval(db, approved.payload.runId, approved.decisionId, {
      decision: "approved",
      reason: "same approval",
    });
    const secondApproval = await postRecoveryDecisionApproval(db, approved.payload.runId, approved.decisionId, {
      decision: "approved",
      reason: "same approval",
    });
    const firstRejection = await postRecoveryDecisionApproval(db, rejected.payload.runId, rejected.decisionId, {
      decision: "rejected",
      reason: "same rejection",
    });
    const secondRejection = await postRecoveryDecisionApproval(db, rejected.payload.runId, rejected.decisionId, {
      decision: "rejected",
      reason: "same rejection",
    });

    assert.equal(firstApproval.status, 200);
    assert.equal(secondApproval.status, 200);
    assert.deepEqual((await firstApproval.json() as ApprovalEnvelope).result, (await secondApproval.json() as ApprovalEnvelope).result);
    assert.equal(firstRejection.status, 200);
    assert.equal(secondRejection.status, 200);
    assert.deepEqual((await firstRejection.json() as ApprovalEnvelope).result, (await secondRejection.json() as ApprovalEnvelope).result);

    const changedApproval = await postRecoveryDecisionApproval(db, approved.payload.runId, approved.decisionId, {
      decision: "rejected",
      reason: "changed approval",
    });
    assert.equal(changedApproval.status, 400);
    assert.match(((await changedApproval.json()) as { error: string }).error, /recovery decision already approved/);
    const changedRejection = await postRecoveryDecisionApproval(db, rejected.payload.runId, rejected.decisionId, {
      decision: "approved",
      reason: "changed rejection",
    });
    assert.equal(changedRejection.status, 400);
    assert.match(((await changedRejection.json()) as { error: string }).error, /recovery decision already blocked/);

    const approvalHistory = await listHistoryForRunPg(db, approved.payload.runId);
    assert.equal(approvalHistory.filter((event) => event.eventType === "recovery_decision.operator_decided").length, 1);
    const rejectionHistory = await listHistoryForRunPg(db, rejected.payload.runId);
    assert.equal(rejectionHistory.filter((event) => event.eventType === "recovery_decision.operator_decided").length, 1);
    assert.equal((await listResourcesPg(db, { resourceType: "operator_approval" })).filter((resource) => resource.runId === approved.payload.runId).length, 1);
    assert.equal((await listResourcesPg(db, { resourceType: "operator_approval" })).filter((resource) => resource.runId === rejected.payload.runId).length, 1);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval rejects managed recovery decisions", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-managed-rejected";
    await seedRun(db, runId);
    await upsertRuntimeResourcePg(db, {
      id: "managed-decision-approval-test",
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey: "managed-recovery:run-operator-managed-rejected:task-a",
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      scope: "recovery",
      status: "waiting_operator_approval",
      title: "Managed recovery decision",
      payload: {
        schemaVersion: "southstar.managed-recovery-decision.v1",
        recoveryDecisionId: "managed-decision-approval-test",
        recoveryKey: "managed-recovery:run-operator-managed-rejected:task-a",
        runId,
        taskId: "task-a",
        sessionId: "session-a",
        strategy: "reprovision-hand",
        reason: "managed recovery remains separate",
      },
      summary: { strategy: "reprovision-hand" },
    });

    const response = await postRecoveryDecisionApproval(db, runId, "managed-decision-approval-test", {
      decision: "approved",
      reason: "should not touch managed recovery",
    });

    assert.equal(response.status, 400);
    const envelope = await response.json() as { ok: false; error: string };
    assert.equal(envelope.ok, false);
    assert.match(envelope.error, /runtime recovery decision not found: managed-decision-approval-test/);
    const managed = await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, "managed-recovery:run-operator-managed-rejected:task-a");
    assert.equal(managed?.status, "waiting_operator_approval");
    assert.equal((await listResourcesPg(db, { resourceType: "operator_approval" })).filter((resource) => resource.runId === runId).length, 0);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/runs/:runId/recovery-decisions/:decisionId/apply rejects managed recovery decisions without writes", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-managed-apply-rejected";
    const decisionId = "managed-decision-apply-test";
    const resourceKey = "managed-recovery:run-operator-managed-apply-rejected:task-a";
    await seedRun(db, runId);
    await upsertRuntimeResourcePg(db, {
      id: decisionId,
      resourceType: RECOVERY_DECISION_RESOURCE_TYPE,
      resourceKey,
      runId,
      taskId: "task-a",
      sessionId: "session-a",
      scope: "recovery",
      status: "approved",
      title: "Managed recovery decision",
      payload: {
        schemaVersion: "southstar.managed-recovery-decision.v1",
        decisionId,
        recoveryDecisionId: decisionId,
        recoveryKey: resourceKey,
        runId,
        taskId: "task-a",
        sessionId: "session-a",
        strategy: "reprovision-hand",
        reason: "managed recovery remains separate",
      },
      summary: { strategy: "reprovision-hand" },
    });

    const response = await postRecoveryDecisionApply(db, runId, decisionId);

    assert.equal(response.status, 400);
    const envelope = await response.json() as { ok: false; error: string };
    assert.equal(envelope.ok, false);
    assert.match(envelope.error, /runtime recovery decision not found: managed-decision-apply-test/);
    const managed = await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, resourceKey);
    assert.equal(managed?.status, "approved");
    assert.equal((await listResourcesPg(db, { resourceType: "recovery_execution" })).filter((resource) => resource.runId === runId).length, 0);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval rejects mismatched payload run ids without writes", async () => {
  const db = await createTestPostgresDb();
  try {
    const routeRunId = "run-operator-payload-run-mismatch";
    const payloadRunId = "run-operator-payload-other";
    const decision = await seedWaitingRuntimeDecision(db, { runId: routeRunId });
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{runId}', $1::jsonb, false)
        where resource_type = $2
          and resource_key = $3`,
      [JSON.stringify(payloadRunId), RECOVERY_DECISION_RESOURCE_TYPE, decision.resourceKey],
    );

    const response = await postRecoveryDecisionApproval(db, routeRunId, decision.decisionId, {
      decision: "approved",
      reason: "operator should not approve mismatched payload",
    });

    assert.equal(response.status, 400);
    const envelope = await response.json() as { ok: false; error: string };
    assert.equal(envelope.ok, false);
    assert.match(envelope.error, /runtime recovery decision payload runId mismatch/);

    const persistedDecision = await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, decision.resourceKey);
    assert.equal(persistedDecision?.status, "waiting_operator_approval");
    assert.equal(pickKeys(persistedDecision?.payload, ["runId", "operatorDecision", "operatorReason"]).runId, payloadRunId);
    assert.equal((await listResourcesPg(db, { resourceType: "operator_approval" })).filter((resource) => resource.runId === routeRunId).length, 0);
    assert.equal((await listHistoryForRunPg(db, routeRunId)).filter((event) => event.eventType === "recovery_decision.operator_decided").length, 0);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/runs/:runId/recovery-decisions/:decisionId/apply rejects mismatched payload run ids without writes", async () => {
  const db = await createTestPostgresDb();
  try {
    const routeRunId = "run-operator-apply-payload-run-mismatch";
    const payloadRunId = "run-operator-apply-payload-other";
    const decision = await seedWaitingRuntimeDecision(db, { runId: routeRunId });
    await db.query(
      `update southstar.runtime_resources
          set status = 'approved',
              payload_json = jsonb_set(payload_json, '{runId}', $1::jsonb, false)
        where resource_type = $2
          and resource_key = $3`,
      [JSON.stringify(payloadRunId), RECOVERY_DECISION_RESOURCE_TYPE, decision.resourceKey],
    );

    const response = await postRecoveryDecisionApply(db, routeRunId, decision.decisionId);

    assert.equal(response.status, 400);
    const envelope = await response.json() as { ok: false; error: string };
    assert.equal(envelope.ok, false);
    assert.match(envelope.error, /runtime recovery decision payload runId mismatch/);

    const persistedDecision = await getResourceByKeyPg(db, RECOVERY_DECISION_RESOURCE_TYPE, decision.resourceKey);
    assert.equal(persistedDecision?.status, "approved");
    assert.equal(pickKeys(persistedDecision?.payload, ["runId", "appliedAt", "statusReason"]).runId, payloadRunId);
    const executions = await listResourcesPg(db, { resourceType: "recovery_execution" });
    assert.equal(executions.filter((resource) => resource.runId === routeRunId || resource.runId === payloadRunId).length, 0);
    assert.equal((await listHistoryForRunPg(db, routeRunId)).filter((event) => event.eventType === "recovery_decision.applied").length, 0);
  } finally {
    await db.close();
  }
});

test("POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval returns an error envelope for invalid bodies", async () => {
  const db = await createTestPostgresDb();
  try {
    const response = await postRecoveryDecisionApproval(db, "run-invalid-body", "decision-invalid-body", {
      decision: "approved",
    });

    assert.equal(response.status, 400);
    const envelope = await response.json() as { ok: false; error: string };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error, "reason is required");
  } finally {
    await db.close();
  }
});

async function seedWaitingRuntimeDecision(
  db: TestPostgresDb,
  input: { runId: string; taskId?: string },
): Promise<RuntimeRecoveryDecisionRecord> {
  const taskId = input.taskId ?? "task-a";
  await seedRun(db, input.runId);
  const controller = createRuntimeExceptionController({ db });
  const exception = await controller.observe({
    runId: input.runId,
    taskId,
    sessionId: "session-a",
    attemptId: "attempt-1",
    handExecutionId: `hand-execution:${input.runId}:${taskId}:attempt-1`,
    source: "tork-observer",
    kind: "tork_running_hang",
    severity: "recoverable",
    observedAt: "2026-06-21T10:00:00.000Z",
    evidenceRefs: ["workspace-snapshot:dirty"],
    providerEvidence: { workspaceUnsafe: true },
  });
  const decision = await controller.decide(await controller.classify(exception));
  assert.equal(decision.status, "waiting_operator_approval");
  return decision;
}

async function seedRun(db: TestPostgresDb, runId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "approve runtime recovery",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
}

async function postRecoveryDecisionApproval(
  db: TestPostgresDb,
  runId: string,
  decisionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await handleRuntimeRoute({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
  }, new Request(`http://127.0.0.1/api/v2/runs/${encodeURIComponent(runId)}/recovery-decisions/${encodeURIComponent(decisionId)}/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function postRecoveryDecisionApply(
  db: TestPostgresDb,
  runId: string,
  decisionId: string,
): Promise<Response> {
  return await handleRuntimeRoute({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
  }, new Request(`http://127.0.0.1/api/v2/runs/${encodeURIComponent(runId)}/recovery-decisions/${encodeURIComponent(decisionId)}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  }));
}

function pickKeys(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

type ApprovalEnvelope = {
  ok: true;
  kind: "recovery-decision-approval";
  result: {
    decisionId: string;
    resourceKey: string;
    status: "approved" | "blocked";
    operatorApprovalResourceKey: string;
  };
};

type ApplyEnvelope = {
  ok: true;
  kind: "recovery-decision-apply";
  result: {
    status: "applied" | "skipped" | "blocked" | "failed" | "superseded";
    executionResourceKey?: string;
    reason: string;
  };
};
