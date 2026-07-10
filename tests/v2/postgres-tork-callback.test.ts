import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { appendHistoryEventPg, createWorkflowRunPg, createWorkflowTaskPg, getResourceByKeyPg, listHistoryForRunPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createExecutorBindingPg, getExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
import { acceptOrRejectArtifactRefPg, artifactRefIdentity } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { ingestTaskRunResultPg, type PostgresTaskRunCallbackResult } from "../../src/v2/executor/postgres-tork-callback.ts";
import { persistBrainBindingPg, persistHandBindingPg } from "../../src/v2/meta-harness/postgres-bindings.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { goalContractHash, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";

test("Postgres Tork callback route ingests task result, artifacts, binding status, and audit history idempotently", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-callback-pg", "task-1");
    await createExecutorBindingPg(db, {
      runId: "run-callback-pg",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-1",
      status: "running",
      now: "2026-06-19T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const first = await post(server.url, "/api/v2/tork/callback", {
        runId: "run-callback-pg",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", summary: "done", filesChanged: ["src/calc.ts"] },
        metrics: { tokens: 12 },
        receivedAt: "2026-06-19T10:05:00.000Z",
        events: [{ eventType: "session.entry", actorType: "root-session", sessionId: "session-1", payload: { message: "started" } }],
      });
      const duplicate = await post(server.url, "/api/v2/tork/callback", {
        runId: "run-callback-pg",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", summary: "done", filesChanged: ["src/calc.ts"] },
        metrics: { tokens: 12 },
        receivedAt: "2026-06-19T10:05:00.000Z",
        events: [],
      });

      assert.equal(first.result.accepted, true);
      assert.equal(duplicate.result.duplicate, true);

      const task = await db.one<{ status: string }>("select status from southstar.workflow_tasks where id = 'task-1' and run_id = 'run-callback-pg'");
      assert.equal(task.status, "completed");
      const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = 'run-callback-pg'");
      assert.equal(run.status, "passed");
      const binding = await getExecutorBindingPg(db, "executor-run-callback-pg-task-1-attempt-1");
      assert.equal(binding?.status, "completed");
      assert.equal(binding?.payload.callbackReceivedAt, "2026-06-19T10:05:00.000Z");
      const brainBindings = await listResourcesPg(db, { resourceType: "brain_binding" });
      const handBindings = await listResourcesPg(db, { resourceType: "hand_binding" });
      const brainBinding = brainBindings.find((resource) => resource.runId === "run-callback-pg" && resource.taskId === "task-1");
      const handBinding = handBindings.find((resource) => resource.runId === "run-callback-pg" && resource.taskId === "task-1");
      assert.equal(brainBinding?.status, "succeeded");
      assert.equal((brainBinding?.payload as { status?: string; terminalAt?: string }).status, "succeeded");
      assert.equal((brainBinding?.payload as { status?: string; terminalAt?: string }).terminalAt, "2026-06-19T10:05:00.000Z");
      assert.equal(handBinding?.status, "succeeded");
      assert.equal((handBinding?.payload as { status?: string; terminalAt?: string }).status, "succeeded");
      assert.equal((handBinding?.payload as { status?: string; terminalAt?: string }).terminalAt, "2026-06-19T10:05:00.000Z");

      const artifactRefs = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
      assert.equal(artifactRefs.length, 1);
      assert.equal(artifactRefs[0]?.taskId, "task-1");
      assert.equal(artifactRefs[0]?.status, "accepted");
      assert.equal((artifactRefs[0]?.payload as { artifactType?: string }).artifactType, "implementation_report");
      assert.deepEqual((artifactRefs[0]?.payload as { contractRefs?: string[] }).contractRefs, [
        "implementation_report",
        "task:task-1:completion",
      ]);
      assert.equal(first.result.artifactRefId, artifactRefs[0]?.resourceKey);

      const legacyArtifacts = await listResourcesPg(db, { resourceType: "artifact" });
      assert.equal(legacyArtifacts.length, 0);
      const client = createRuntimeServerClient({ baseUrl: server.url });
      const artifacts = await client.listArtifacts("run-callback-pg");
      assert.equal(artifacts.kind, "artifacts");
      assert.equal(Array.isArray(artifacts.result), true);
      const artifactList = artifacts.result as Array<{ resourceType: string; resourceKey: string; status: string; taskId?: string }>;
      assert.deepEqual(artifactList.map((artifact) => artifact.resourceType), [ARTIFACT_REF_RESOURCE_TYPE]);
      assert.equal(artifactList[0]?.resourceKey, first.result.artifactRefId);
      assert.equal(artifactList[0]?.status, "accepted");
      assert.equal(artifactList[0]?.taskId, "task-1");

      const evaluator = await db.one<{ status: string; payload_json: { status?: string; findings?: string[] } }>(
        "select status, payload_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
        ["completion-gate:run-callback-pg"],
      );
      assert.equal(evaluator.status, "passed");
      assert.deepEqual(evaluator.payload_json, { status: "passed", findings: [] });

      const history = await listHistoryForRunPg(db, "run-callback-pg");
      const historyTypes = history.map((event) => event.eventType);
      assert.equal(historyTypes.includes("executor.submitted"), true);
      assert.equal(historyTypes.includes("session.entry"), true);
      assertOrder(historyTypes, "artifact.accepted", "artifact.created");
      assertOrder(historyTypes, "artifact.created", "memory.run_local_written");
      assertOrder(historyTypes, "memory.run_local_written", "memory.writeback_recorded");
      assertOrder(historyTypes, "memory.writeback_recorded", "executor.callback_completed");
      assertOrder(historyTypes, "executor.callback_completed", "run.evaluating_started");
      assertOrder(historyTypes, "run.evaluating_started", "run.completed");
      assert.equal(history.find((event) => event.eventType === "run.completed")?.actorType, "evaluator");
      assert.equal(history.filter((event) => event.eventType === "executor.callback_received").length, 1);
    } finally {
      await server.close();
    }
  });
});

test("Postgres Tork callback ok false writes rejected artifact_ref and evaluator-owned run failure", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-callback-rejected", "task-1");
    await createExecutorBindingPg(db, {
      runId: "run-callback-rejected",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-1",
      status: "running",
      now: "2026-06-19T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const callbackBody = {
        runId: "run-callback-rejected",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: false,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", summary: "tests failed", risks: ["failing verification"] },
        metrics: { tokens: 12 },
        receivedAt: "2026-06-19T10:05:00.000Z",
        events: [],
      };
      const response = await post(server.url, "/api/v2/tork/callback", callbackBody);
      const duplicate = await post(server.url, "/api/v2/tork/callback", callbackBody);

      assert.equal(response.result.accepted, false);
      assert.equal(duplicate.result.duplicate, true);
      assert.equal(duplicate.result.accepted, false);
      assert.equal(duplicate.result.artifactRefId, response.result.artifactRefId);
      assert.equal(duplicate.result.artifactResourceId, response.result.artifactResourceId);
      const artifactRefs = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
      assert.equal(artifactRefs.length, 1);
      assert.equal(artifactRefs[0]?.status, "rejected");
      assert.equal(artifactRefs[0]?.resourceKey, response.result.artifactRefId);
      const task = await db.one<{ status: string }>("select status from southstar.workflow_tasks where id = 'task-1' and run_id = 'run-callback-rejected'");
      assert.equal(task.status, "failed");
      const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = 'run-callback-rejected'");
      assert.equal(run.status, "failed");
      const evaluator = await db.one<{ status: string; payload_json: { status?: string; findings?: string[] } }>(
        "select status, payload_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
        ["completion-gate:run-callback-rejected"],
      );
      assert.equal(evaluator.status, "failed");
      assert.deepEqual(evaluator.payload_json, {
        status: "failed",
        findings: ["task task-1 terminal status is failed"],
      });
      const history = await listHistoryForRunPg(db, "run-callback-rejected");
      assert.equal(history.some((event) => event.eventType === "artifact.rejected"), true);
      const completed = history.filter((event) => event.eventType === "run.completed");
      assert.equal(completed.length, 1);
      assert.equal(completed[0]?.actorType, "evaluator");
      assert.deepEqual(completed[0]?.payload, {
        status: "failed",
        findings: ["task task-1 terminal status is failed"],
      });
    } finally {
      await server.close();
    }
  });
});

test("Postgres Tork callback ignores stale attempt after a newer attempt completed the task", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-callback-stale", "task-1");
    await createExecutorBindingPg(db, {
      runId: "run-callback-stale",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-1",
      status: "running",
      now: "2026-06-19T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });
    await createExecutorBindingPg(db, {
      runId: "run-callback-stale",
      taskId: "task-1",
      attemptId: "attempt-2",
      torkJobId: "job-2",
      status: "running",
      now: "2026-06-19T10:02:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const newer = await post(server.url, "/api/v2/tork/callback", {
        runId: "run-callback-stale",
        taskId: "task-1",
        rootSessionId: "session-2",
        ok: true,
        attempts: 2,
        attemptId: "attempt-2",
        artifact: { kind: "implementation_report", summary: "newer attempt passed", filesChanged: ["src/new.ts"] },
        metrics: { tokens: 12 },
        receivedAt: "2026-06-19T10:06:00.000Z",
        events: [],
      });
      const stale = await post(server.url, "/api/v2/tork/callback", {
        runId: "run-callback-stale",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: false,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", summary: "old attempt failed", risks: ["late stale callback"] },
        metrics: { tokens: 5 },
        receivedAt: "2026-06-19T10:07:00.000Z",
        events: [{ eventType: "session.entry", actorType: "root-session", sessionId: "session-1", payload: { message: "late" } }],
      });

      assert.equal(newer.result.accepted, true);
      assert.equal(stale.result.accepted, false);
      const task = await db.one<{ status: string }>("select status from southstar.workflow_tasks where id = 'task-1' and run_id = 'run-callback-stale'");
      assert.equal(task.status, "completed");
      const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = 'run-callback-stale'");
      assert.equal(run.status, "passed");
      const evaluator = await db.one<{ status: string; payload_json: { status?: string; findings?: string[] } }>(
        "select status, payload_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
        ["completion-gate:run-callback-stale"],
      );
      assert.equal(evaluator.status, "passed");
      assert.deepEqual(evaluator.payload_json, { status: "passed", findings: [] });
      const artifactRefs = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
      assert.equal(artifactRefs.length, 1);
      assert.equal(artifactRefs[0]?.resourceKey, newer.result.artifactRefId);
      assert.equal(artifactRefs[0]?.status, "accepted");
      const attempt1 = await getExecutorBindingPg(db, "executor-run-callback-stale-task-1-attempt-1");
      const attempt2 = await getExecutorBindingPg(db, "executor-run-callback-stale-task-1-attempt-2");
      assert.equal(attempt1?.status, "running");
      assert.equal(attempt2?.status, "completed");
      const history = await listHistoryForRunPg(db, "run-callback-stale");
      assert.equal(history.filter((event) => event.eventType === "executor.callback_received").length, 2);
      assert.equal(history.filter((event) => event.eventType === "artifact.created").length, 1);
      assert.equal(history.filter((event) => event.eventType === "executor.callback_ignored_stale_attempt").length, 1);
      assert.equal(history.some((event) => event.eventType === "executor.callback_ignored_terminal"), false);
      assert.equal(history.some((event) => event.eventType === "session.entry" && event.sessionId === "session-1"), false);
    } finally {
      await server.close();
    }
  });
});

test("Postgres Tork callback ignores non-identical callback for an already terminal task", async () => {
  await withDb(async (db) => {
    await seedRunTask(db, "run-callback-terminal", "task-1");
    await createExecutorBindingPg(db, {
      runId: "run-callback-terminal",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-1",
      status: "running",
      now: "2026-06-19T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const first = await post(server.url, "/api/v2/tork/callback", {
        runId: "run-callback-terminal",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: true,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", summary: "first terminal result", filesChanged: ["src/first.ts"] },
        metrics: { tokens: 12 },
        receivedAt: "2026-06-19T10:05:00.000Z",
        events: [],
      });
      const late = await post(server.url, "/api/v2/tork/callback", {
        runId: "run-callback-terminal",
        taskId: "task-1",
        rootSessionId: "session-1",
        ok: false,
        attempts: 1,
        attemptId: "attempt-1",
        artifact: { kind: "implementation_report", summary: "different late failed result", risks: ["should be ignored"] },
        metrics: { tokens: 8 },
        receivedAt: "2026-06-19T10:06:00.000Z",
        events: [{ eventType: "session.entry", actorType: "root-session", sessionId: "session-1", payload: { message: "late" } }],
      });

      assert.equal(first.result.accepted, true);
      assert.equal(late.result.accepted, false);
      const task = await db.one<{ status: string }>("select status from southstar.workflow_tasks where id = 'task-1' and run_id = 'run-callback-terminal'");
      assert.equal(task.status, "completed");
      const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = 'run-callback-terminal'");
      assert.equal(run.status, "passed");
      const evaluator = await db.one<{ status: string; payload_json: { status?: string; findings?: string[] } }>(
        "select status, payload_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
        ["completion-gate:run-callback-terminal"],
      );
      assert.equal(evaluator.status, "passed");
      assert.deepEqual(evaluator.payload_json, { status: "passed", findings: [] });
      const artifactRefs = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
      assert.equal(artifactRefs.length, 1);
      assert.equal(artifactRefs[0]?.resourceKey, first.result.artifactRefId);
      assert.equal(artifactRefs[0]?.status, "accepted");
      const binding = await getExecutorBindingPg(db, "executor-run-callback-terminal-task-1-attempt-1");
      assert.equal(binding?.status, "completed");
      const history = await listHistoryForRunPg(db, "run-callback-terminal");
      assert.equal(history.filter((event) => event.eventType === "executor.callback_received").length, 2);
      assert.equal(history.filter((event) => event.eventType === "artifact.created").length, 1);
      assert.equal(history.filter((event) => event.eventType === "executor.callback_ignored_terminal").length, 1);
      assert.equal(history.filter((event) => event.eventType === "run.completed").length, 1);
      assert.equal(history.some((event) => event.eventType === "session.entry" && event.payload.message === "late"), false);
    } finally {
      await server.close();
    }
  });
});

test("cancelled callback replay returns the durable receipt without duplicating audit rows", async () => {
  await withDb(async (db) => {
    const runId = "run-callback-cancelled-replay";
    await seedRunTask(db, runId, "task-1");
    await db.query("update southstar.workflow_runs set status = 'cancelled' where id = $1", [runId]);
    const callback: PostgresTaskRunCallbackResult = {
      runId,
      taskId: "task-1",
      rootSessionId: "session-1",
      ok: false,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "implementation_report", summary: "cancelled" },
      metrics: {},
      events: [],
    };

    const first = await ingestTaskRunResultPg(db, callback);
    const replay = await ingestTaskRunResultPg(db, callback);

    assert.equal(first.ignoredRunStatus, "cancelled");
    assert.equal(replay.duplicate, true);
    assert.equal(replay.ignoredRunStatus, "cancelled");
    const history = await listHistoryForRunPg(db, runId);
    assert.equal(history.filter((event) => event.eventType === "executor.callback_received").length, 1);
    assert.equal(history.filter((event) => event.eventType === "executor.callback_ignored_cancelled_run").length, 1);
  });
});

test("verifier callback persists requirement evidence and evaluator result idempotently", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-evidence");
    const callback = verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: ["npm test"],
        testResults: [{ command: ["npm", "test"], status: "passed" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    });

    const first = await ingestTaskRunResultPg(db, callback);
    const replay = await ingestTaskRunResultPg(db, callback);

    assert.equal(first.accepted, true);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.accepted, true);
    const evaluator = await latestRequirementResultPg(db, fixture.runId, "req-offline");
    assert.equal(evaluator?.status, "passed");
    assert.deepEqual((evaluator?.payload as { requirementIds?: string[] }).requirementIds, ["req-offline"]);
    assert.deepEqual((evaluator?.payload as { artifactRefs?: string[] }).artifactRefs, [fixture.producerArtifactRefId]);
    assert.equal((evaluator?.payload as { evidenceRefs?: string[] }).evidenceRefs?.length, 1);

    const callbackArtifact = await getResourceByKeyPg(db, ARTIFACT_REF_RESOURCE_TYPE, first.artifactRefId!);
    const callbackPayload = callbackArtifact?.payload as { evidenceRefs?: string[]; evaluatorResultRefs?: string[] };
    assert.equal(callbackPayload.evidenceRefs?.length, 1);
    assert.equal(callbackPayload.evaluatorResultRefs?.length, 2);
    const counts = await db.query<{ resource_type: string; count: string }>(
      `select resource_type, count(*)::text as count
         from southstar.runtime_resources
        where run_id = $1
          and resource_type = any($2::text[])
        group by resource_type
        order by resource_type`,
      [fixture.runId, ["evidence_packet", "validator_result", "requirement_evaluator_result"]],
    );
    assert.deepEqual(counts.rows, [
      { resource_type: "evidence_packet", count: "1" },
      { resource_type: "requirement_evaluator_result", count: "1" },
      { resource_type: "validator_result", count: "1" },
    ]);
    const history = await listHistoryForRunPg(db, fixture.runId);
    assert.equal(history.filter((event) => event.eventType === "executor.callback_received").length, 1);
  });
});

test("missing required evidence blocks an otherwise ok verifier callback", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-missing-evidence");

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: { kind: "verification_report", pass: true },
    }));

    assert.equal(result.accepted, false);
    const evaluator = await latestRequirementResultPg(db, fixture.runId, "req-offline");
    assert.equal(evaluator?.status, "blocked");
    const task = await db.one<{ status: string }>(
      "select status from southstar.workflow_tasks where run_id = $1 and id = 'task-verify'",
      [fixture.runId],
    );
    assert.equal(task.status, "failed");
    const completion = await getResourceByKeyPg(db, "evaluator_result", `completion-gate:${fixture.runId}`);
    assert.equal(completion?.status, "failed");
  });
});

test("verifier callback cannot satisfy coverage with an arbitrary artifact ref", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-arbitrary-ref");

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: ["npm test"],
        testResults: [{ status: "passed" }],
        verifiedArtifactRefs: ["artifact_ref:unrelated:task:attempt-1:abc"],
      },
    }));

    assert.equal(result.accepted, false);
    const evaluator = await latestRequirementResultPg(db, fixture.runId, "req-offline");
    assert.equal(evaluator?.status, "blocked");
    assert.deepEqual((evaluator?.payload as { artifactRefs?: string[] }).artifactRefs, []);
  });
});

test("invalid verifier evidence produces a failed requirement evaluator result", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-invalid-evidence");

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: ["npm test"],
        testResults: [{ note: "no result status" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));

    assert.equal(result.accepted, false);
    const evaluator = await latestRequirementResultPg(db, fixture.runId, "req-offline");
    assert.equal(evaluator?.status, "failed");
  });
});

test("one evaluator task persists distinct evidence packets for multiple requirements", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-multiple", {
      requirementIds: ["req-offline", "req-installable"],
    });
    await upsertRuntimeResourcePg(db, {
      id: `goal-requirement-coverage:${fixture.runId}`,
      resourceType: "goal_requirement_coverage",
      resourceKey: fixture.runId,
      runId: fixture.runId,
      scope: "run",
      status: "frozen",
      payload: requirementCoverage(["req-offline", "req-installable"], fixture.goalContractHash),
    });

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: ["npm test"],
        testResults: [{ status: "passed" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));

    assert.equal(result.accepted, true);
    const evidence = await db.query<{ resource_key: string }>(
      "select resource_key from southstar.runtime_resources where run_id = $1 and resource_type = 'evidence_packet' order by resource_key",
      [fixture.runId],
    );
    assert.equal(evidence.rows.length, 2);
    assert.notEqual(evidence.rows[0]?.resource_key, evidence.rows[1]?.resource_key);
    const evaluators = await db.query<{ payload_json: { evidenceRefs: string[] } }>(
      "select payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'requirement_evaluator_result' order by resource_key",
      [fixture.runId],
    );
    assert.equal(evaluators.rows.length, 2);
    assert.notEqual(evaluators.rows[0]?.payload_json.evidenceRefs[0], evaluators.rows[1]?.payload_json.evidenceRefs[0]);
  });
});

test("malformed frozen requirement coverage fails closed with a descriptive error", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-malformed-coverage");
    await upsertRuntimeResourcePg(db, {
      id: `goal-requirement-coverage:${fixture.runId}`,
      resourceType: "goal_requirement_coverage",
      resourceKey: fixture.runId,
      runId: fixture.runId,
      scope: "run",
      status: "frozen",
      payload: {
        schemaVersion: "southstar.goal_requirement_coverage.v1",
        goalContractHash: fixture.goalContractHash,
        entries: [{ requirementId: "req-offline", evaluatorTaskIds: "task-verify" }],
      },
    });

    await assert.rejects(
      ingestTaskRunResultPg(db, verifierCallback({
        runId: fixture.runId,
        artifact: { kind: "verification_report", pass: true },
      })),
      /invalid Goal Requirement Coverage for run run-requirement-malformed-coverage: entries\[0\]\.producerTaskIds/,
    );
  });
});

test("requirement evaluator profile must match the persisted manifest task", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-profile-mismatch");
    await db.query(
      `update southstar.workflow_runs
          set workflow_manifest_json = jsonb_set(
            workflow_manifest_json,
            '{tasks,0,evaluatorPipelineRef}',
            to_jsonb('different-evaluator'::text)
          )
        where id = $1`,
      [fixture.runId],
    );

    await assert.rejects(
      ingestTaskRunResultPg(db, verifierCallback({
        runId: fixture.runId,
        artifact: {
          kind: "verification_report",
          pass: true,
          commandsRun: ["npm test"],
          testResults: [{ status: "passed" }],
          verifiedArtifactRefs: [fixture.producerArtifactRefId],
        },
      })),
      /evaluator profile different-evaluator does not match frozen coverage for task task-verify/,
    );
  });
});

test("a producer task cannot act as its own independent requirement evaluator", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-self-evaluator");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.producerTaskIds = ["task-verify"];
    await upsertRuntimeResourcePg(db, {
      id: `goal-requirement-coverage:${fixture.runId}`,
      resourceType: "goal_requirement_coverage",
      resourceKey: fixture.runId,
      runId: fixture.runId,
      scope: "run",
      status: "frozen",
      payload: coverage,
    });

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: ["npm test"],
        testResults: [{ status: "passed" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));

    assert.equal(result.accepted, false);
    const evaluator = await latestRequirementResultPg(db, fixture.runId, "req-offline");
    assert.equal(evaluator?.status, "blocked");
    assert.equal(
      (evaluator?.payload as { findings?: string[] }).findings?.includes("evaluator task task-verify is also a producer"),
      true,
    );
  });
});

test("a verifier callback that reports failure produces a failed requirement evaluator result", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-callback-failed");

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      ok: false,
      artifact: {
        kind: "verification_report",
        pass: false,
        commandsRun: ["npm test"],
        testResults: [{ status: "failed" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));

    assert.equal(result.accepted, false);
    const evaluator = await latestRequirementResultPg(db, fixture.runId, "req-offline");
    assert.equal(evaluator?.status, "failed");
  });
});

test("a Goal Contract run missing its frozen coverage fails closed", async () => {
  await withDb(async (db) => {
    const runId = "run-requirement-missing-coverage";
    await seedRunTask(db, runId, "task-verify");
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = $2::jsonb where id = $1",
      [runId, JSON.stringify({ goalContractHash: "goal-contract-hash" })],
    );

    await assert.rejects(
      ingestTaskRunResultPg(db, verifierCallback({
        runId,
        artifact: { kind: "verification_report", pass: true },
      })),
      /Goal Contract run run-requirement-missing-coverage is missing frozen requirement coverage/,
    );
  });
});

test("browser verifier evidence passes only with valid structured URL and screenshot evidence", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-browser-requirement-evidence");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "url", "screenshot"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
        browserEvidence: {
          url: "https://example.test/subscriptions?token=redact-me",
          screenshots: [{ path: "artifacts/subscription-page.png" }],
        },
      },
    }));

    assert.equal(result.accepted, true);
  });
});

test("malformed browser evaluator evidence is rejected", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-browser-requirement-invalid");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "url", "screenshot"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
        browserEvidence: {
          url: "file:///home/user/.ssh/id_rsa",
          screenshots: [{ path: "../../home/user/.ssh/id_rsa" }],
        },
      },
    }));

    assert.equal(result.accepted, false);
    assert.equal((await latestRequirementResultPg(db, fixture.runId, "req-offline"))?.status, "failed");
  });
});

test("evaluator callbacks require the current persisted execution identity", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-no-execution");
    await db.query(
      `delete from southstar.runtime_resources
        where run_id = $1
          and resource_type in ('executor_binding', 'task_execution_intent')`,
      [fixture.runId],
    );

    await assert.rejects(
      ingestTaskRunResultPg(db, validVerifierCallback(fixture)),
      /evaluator execution identity .*missing persisted execution binding/,
    );
    assert.equal(await evaluatorResourceCount(db, fixture.runId), 0);
  });

  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-no-hand");
    await db.query(
      "delete from southstar.runtime_resources where resource_type = 'hand_execution' and resource_key = $1",
      [`hand-execution:${fixture.runId}:task-verify:attempt-1`],
    );

    await assert.rejects(
      ingestTaskRunResultPg(db, validVerifierCallback(fixture)),
      /evaluator execution identity .*hand execution is missing/,
    );
    assert.equal(await evaluatorResourceCount(db, fixture.runId), 0);
  });
});

test("evaluator callback session, attempt, and executed profile must match persisted identity", async () => {
  await withDb(async (db) => {
    const sessionFixture = await seedRequirementEvidenceRun(db, "run-requirement-session-spoof");
    await assert.rejects(
      ingestTaskRunResultPg(db, {
        ...validVerifierCallback(sessionFixture),
        rootSessionId: "session-spoofed",
      }),
      /evaluator execution identity .*sessionId/,
    );
    assert.equal(await evaluatorResourceCount(db, sessionFixture.runId), 0);
  });

  await withDb(async (db) => {
    const attemptFixture = await seedRequirementEvidenceRun(db, "run-requirement-attempt-spoof");
    await assert.rejects(
      ingestTaskRunResultPg(db, {
        ...validVerifierCallback(attemptFixture),
        attempts: 99,
        attemptId: "attempt-99",
      }),
      /evaluator execution identity .*attempt-99/,
    );
    assert.equal(await evaluatorResourceCount(db, attemptFixture.runId), 0);
  });

  await withDb(async (db) => {
    const profileFixture = await seedRequirementEvidenceRun(db, "run-requirement-profile-spoof");
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{envelope,evaluatorPipeline,id}', to_jsonb('other-profile'::text))
        where resource_type = 'task_envelope'
          and resource_key = $1`,
      [`task-envelope-${profileFixture.runId}-task-verify-attempt-1`],
    );
    await assert.rejects(
      ingestTaskRunResultPg(db, validVerifierCallback(profileFixture)),
      /executed evaluator profile other-profile does not match frozen coverage/,
    );
    assert.equal(await evaluatorResourceCount(db, profileFixture.runId), 0);
  });
});

test("retry keeps old rejected evaluator resources immutable", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-retry-immutable");
    const first = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      ok: false,
      artifact: {
        kind: "verification_report",
        pass: false,
        commandsRun: ["npm test"],
        testResults: [{ status: "failed" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));
    const firstArtifact = await getResourceByKeyPg(db, ARTIFACT_REF_RESOURCE_TYPE, first.artifactRefId!);
    const firstResultRef = await requirementResultRefFromArtifact(db, firstArtifact?.payload);
    const firstResultBefore = await getResourceByKeyPg(db, "requirement_evaluator_result", firstResultRef);
    assert.equal(firstResultBefore?.status, "failed");

    await db.query(
      "update southstar.workflow_tasks set status = 'running', root_session_id = 'session-2', completed_at = null where run_id = $1 and id = 'task-verify'",
      [fixture.runId],
    );
    await seedEvaluatorAttempt(db, {
      runId: fixture.runId,
      taskId: "task-verify",
      sessionId: "session-2",
      attemptId: "attempt-2",
      evaluatorPipelineRef: "software-verification-quality",
    });
    const second = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      sessionId: "session-2",
      attemptId: "attempt-2",
      attempts: 2,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: ["npm test"],
        testResults: [{ status: "passed" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));
    assert.equal(second.accepted, true);
    const secondArtifact = await getResourceByKeyPg(db, ARTIFACT_REF_RESOURCE_TYPE, second.artifactRefId!);
    const secondResultRef = await requirementResultRefFromArtifact(db, secondArtifact?.payload);
    assert.notEqual(firstResultRef, secondResultRef);
    assert.equal((await getResourceByKeyPg(db, "requirement_evaluator_result", firstResultRef))?.status, "failed");
    assert.equal((await getResourceByKeyPg(db, "requirement_evaluator_result", secondResultRef))?.status, "passed");
  });
});

test("committed old-attempt callback replay remains duplicate after a newer evaluator attempt exists", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-old-attempt-replay");
    const callback = validVerifierCallback(fixture);
    const first = await ingestTaskRunResultPg(db, callback);
    await db.query(
      "update southstar.workflow_tasks set status = 'running', root_session_id = 'session-2', completed_at = null where run_id = $1 and id = 'task-verify'",
      [fixture.runId],
    );
    await seedEvaluatorAttempt(db, {
      runId: fixture.runId,
      taskId: "task-verify",
      sessionId: "session-2",
      attemptId: "attempt-2",
      evaluatorPipelineRef: "software-verification-quality",
    });
    const before = await evaluatorResourceCount(db, fixture.runId);

    const replay = await ingestTaskRunResultPg(db, callback);

    assert.equal(replay.duplicate, true);
    assert.equal(replay.artifactRefId, first.artifactRefId);
    assert.equal(await evaluatorResourceCount(db, fixture.runId), before);
  });
});

test("second callback transaction checks a concurrently committed receipt before current attempt identity", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-receipt-race");
    const callback = validVerifierCallback(fixture);
    const attemptId = callback.attemptId!;
    const handExecutionId = `hand-execution:${fixture.runId}:task-verify:${attemptId}`;
    const artifactHash = createHash("sha256").update(stableStringify(callback.artifact)).digest("hex");
    const receiptKey = `${handExecutionId}:callback:${artifactHash}`;
    let resourceCountAfterConcurrentCommit = 0;
    const racedDb = withBeforeTopLevelTransaction(db, 2, async () => {
      await acceptOrRejectArtifactRefPg(db, {
        runId: fixture.runId,
        taskId: "task-verify",
        sessionId: "session-1",
        attemptId,
        handExecutionId,
        producer: { actorType: "hand", providerId: "tork" },
        artifactType: "verification_report",
        status: "accepted",
        content: callback.artifact,
        contractRefs: ["implementation_report", "task:task-verify:completion"],
        summary: "Concurrent callback artifact",
        sourceEventRefs: [receiptKey],
      });
      await appendHistoryEventPg(db, {
        runId: fixture.runId,
        taskId: "task-verify",
        sessionId: "session-1",
        eventType: "executor.callback_received",
        actorType: "executor",
        idempotencyKey: receiptKey,
        payload: { attempts: 1, attemptId, artifactHash },
      });
      await db.query(
        "update southstar.workflow_tasks set status = 'running', root_session_id = 'session-2', completed_at = null where run_id = $1 and id = 'task-verify'",
        [fixture.runId],
      );
      await seedEvaluatorAttempt(db, {
        runId: fixture.runId,
        taskId: "task-verify",
        sessionId: "session-2",
        attemptId: "attempt-2",
        evaluatorPipelineRef: "software-verification-quality",
      });
      resourceCountAfterConcurrentCommit = (await listResourcesPg(db, {})).filter((resource) => resource.runId === fixture.runId).length;
    });

    const replay = await ingestTaskRunResultPg(racedDb, callback);

    assert.equal(replay.duplicate, true);
    assert.equal(replay.artifactRefId, artifactRefIdentity({
      runId: fixture.runId,
      taskId: "task-verify",
      attemptId,
      content: callback.artifact,
    }).artifactRefId);
    assert.equal((await listResourcesPg(db, {})).filter((resource) => resource.runId === fixture.runId).length, resourceCountAfterConcurrentCommit);
  });
});

test("frozen coverage must match canonical Goal Contract hash and manifest task membership", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-hash-mismatch");
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{goalContractHash}', to_jsonb('wrong-hash'::text))
        where resource_type = 'goal_requirement_coverage' and resource_key = $1`,
      [fixture.runId],
    );
    await assert.rejects(
      ingestTaskRunResultPg(db, validVerifierCallback(fixture)),
      /Goal Requirement Coverage .*goalContractHash does not match canonical Goal Contract/,
    );
  });

  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-manifest-task-missing");
    await db.query(
      `update southstar.workflow_runs
          set workflow_manifest_json = jsonb_set(
            workflow_manifest_json,
            '{tasks}',
            '[{"id":"task-build","requiredArtifactRefs":["implementation_report"]}]'::jsonb
          )
        where id = $1`,
      [fixture.runId],
    );
    await assert.rejects(
      ingestTaskRunResultPg(db, validVerifierCallback(fixture)),
      /manifest is missing evaluator task task-verify/,
    );
  });
});

test("frozen coverage rejects phantom producer tasks", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-phantom-producer");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.producerTaskIds = ["task-phantom"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);
    await assert.rejects(
      ingestTaskRunResultPg(db, validVerifierCallback(fixture)),
      /manifest is missing producer task task-phantom/,
    );
  });
});

test("frozen coverage rejects undeclared producer artifact contracts", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-undeclared-artifact");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.artifactRefs = ["artifact.not-declared-by-producer"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);
    await assert.rejects(
      ingestTaskRunResultPg(db, validVerifierCallback(fixture)),
      /artifact ref artifact\.not-declared-by-producer is not declared by producer task/,
    );
  });
});

test("non-blocking uncovered Goal Contract entries do not block a valid evaluator callback", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-non-blocking", {
      requirementIds: ["req-offline", "req-optional"],
      nonBlockingRequirementIds: ["req-optional"],
    });
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries.push({
      requirementId: "req-optional",
      producerTaskIds: [],
      artifactRefs: [],
      evaluatorTaskIds: [],
      evaluatorProfileRefs: [],
      requiredEvidenceKinds: [],
    });
    await replaceRequirementCoverage(db, fixture.runId, coverage);

    const result = await ingestTaskRunResultPg(db, validVerifierCallback(fixture));
    assert.equal(result.accepted, true);
  });
});

test("optional evaluator evidence is persisted without failing a passing blocking requirement", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-optional-evidence", {
      requirementIds: ["req-blocking", "req-optional"],
      nonBlockingRequirementIds: ["req-optional"],
    });
    const coverage = requirementCoverage(["req-blocking", "req-optional"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref"];
    coverage.entries[1]!.requiredEvidenceKinds = ["artifact-ref", "screenshot"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));

    assert.equal(result.accepted, true);
    assert.equal((await latestRequirementResultPg(db, fixture.runId, "req-blocking"))?.status, "passed");
    assert.equal((await latestRequirementResultPg(db, fixture.runId, "req-optional"))?.status, "blocked");
  });
});

test("producer artifacts match frozen coverage through host-owned contract refs and manifest aliases", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-custom-contract", {
      producerContractRefs: ["build-output"],
      coverageArtifactRefs: ["artifact.custom-build"],
      manifestArtifactContracts: [{
        id: "custom-build",
        artifactType: "implementation_report",
        requiredFields: ["summary"],
        evidenceFields: [],
      }],
    });
    const result = await ingestTaskRunResultPg(db, validVerifierCallback(fixture));
    assert.equal(result.accepted, false, "unrelated host-owned contract ref must not match worker artifactType");

    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{contractRefs}', '["custom-build"]'::jsonb)
        where resource_type = 'artifact_ref' and resource_key = $1`,
      [fixture.producerArtifactRefId],
    );
    await db.query(
      "update southstar.workflow_tasks set status = 'running', root_session_id = 'session-2', completed_at = null where run_id = $1 and id = 'task-verify'",
      [fixture.runId],
    );
    await seedEvaluatorAttempt(db, {
      runId: fixture.runId,
      taskId: "task-verify",
      sessionId: "session-2",
      attemptId: "attempt-2",
      evaluatorPipelineRef: "software-verification-quality",
    });
    const retry = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      sessionId: "session-2",
      attemptId: "attempt-2",
      attempts: 2,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: ["npm test"],
        testResults: [{ status: "passed" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));
    assert.equal(retry.accepted, true);
  });
});

async function seedRunTask(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "callback ingestion",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: "wf-callback",
      tasks: [{
        id: taskId,
        requiredArtifactRefs: ["implementation_report"],
        ...(taskId === "task-verify" ? { evaluatorPipelineRef: "software-verification-quality" } : {}),
      }],
    }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: taskId,
    runId,
    taskKey: "implement-feature",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-1",
  });
  await persistBrainBindingPg(db, {
    id: `brain-${runId}-${taskId}`,
    providerId: "pi",
    runId,
    taskId,
    sessionId: "session-1",
    contextPacketId: `ctx-${runId}-${taskId}`,
    status: "running",
    createdAt: "2026-06-19T10:00:00.000Z",
    payload: { recoveryKey: `task-dispatch:${runId}:${taskId}` },
  });
  await persistHandBindingPg(db, {
    id: `hand-${runId}-${taskId}`,
    providerId: "tork",
    runId,
    taskId,
    handName: "workspace",
    status: "running",
    createdAt: "2026-06-19T10:00:00.000Z",
    payload: { recoveryKey: `task-dispatch:${runId}:${taskId}` },
  });
  await upsertRuntimeResourcePg(db, {
    id: `hand-execution:${runId}:${taskId}:attempt-1`,
    resourceType: "hand_execution",
    resourceKey: `hand-execution:${runId}:${taskId}:attempt-1`,
    runId,
    taskId,
    sessionId: "session-1",
    scope: "hand",
    status: "running",
    title: `Hand execution ${taskId}`,
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId: `hand-execution:${runId}:${taskId}:attempt-1`,
      providerId: "tork",
      runId,
      taskId,
      sessionId: "session-1",
      attemptId: "attempt-1",
      brainBindingId: `brain-${runId}-${taskId}`,
      handBindingId: `hand-${runId}-${taskId}`,
      status: "running",
      queuedAt: "2026-06-19T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      heartbeatTimeoutSeconds: 60,
    },
    summary: { providerId: "tork", attemptId: "attempt-1" },
  });
}

async function seedRequirementEvidenceRun(
  db: SouthstarDb,
  runId: string,
  options: {
    requirementIds?: string[];
    nonBlockingRequirementIds?: string[];
    producerContractRefs?: string[];
    coverageArtifactRefs?: string[];
    manifestArtifactContracts?: Array<{ id: string; artifactType: string; requiredFields: string[]; evidenceFields: string[] }>;
  } = {},
): Promise<{ runId: string; producerArtifactRefId: string; goalContractHash: string }> {
  await seedRunTask(db, runId, "task-verify");
  const requirementIds = options.requirementIds ?? ["req-offline"];
  const goalContract = requirementGoalContract(requirementIds, options.nonBlockingRequirementIds);
  const contractHash = goalContractHash(goalContract);
  const draftId = `draft-${runId}`;
  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: `Planner draft ${runId}`,
    payload: { goalContract, goalContractHash: contractHash },
    summary: { goalContractHash: contractHash },
  });
  await db.query(
    `update southstar.workflow_runs
        set runtime_context_json = $2::jsonb,
            workflow_manifest_json = jsonb_set(
              workflow_manifest_json || $3::jsonb,
              '{tasks}',
              $4::jsonb
            )
      where id = $1`,
    [
      runId,
      JSON.stringify({ draftId, goalContractHash: contractHash }),
      JSON.stringify(options.manifestArtifactContracts ? { artifactContracts: options.manifestArtifactContracts } : {}),
      JSON.stringify([
        {
          id: "task-verify",
          requiredArtifactRefs: ["implementation_report"],
          evaluatorPipelineRef: "software-verification-quality",
        },
        {
          id: "task-build",
          requiredArtifactRefs: (options.coverageArtifactRefs ?? ["artifact.implementation_report"])
            .map((ref) => ref.replace(/^artifact[.:]/, "")),
        },
      ]),
    ],
  );
  await createWorkflowTaskPg(db, {
    id: "task-build",
    runId,
    taskKey: "build-feature",
    status: "completed",
    sortOrder: -1,
    dependsOn: [],
    rootSessionId: "session-build",
  });
  const producerArtifact = await acceptOrRejectArtifactRefPg(db, {
    runId,
    taskId: "task-build",
    sessionId: "session-build",
    attemptId: "attempt-1",
    handExecutionId: `hand-execution:${runId}:task-build:attempt-1`,
    producer: { actorType: "hand", providerId: "tork" },
    artifactType: "implementation_report",
    status: "accepted",
    content: { kind: "implementation_report", summary: "built" },
    contractRefs: options.producerContractRefs ?? ["implementation_report"],
    summary: "Build artifact",
    producedAt: "2026-07-10T00:00:00.000Z",
  });
  await upsertRuntimeResourcePg(db, {
    id: `goal-requirement-coverage:${runId}`,
    resourceType: "goal_requirement_coverage",
    resourceKey: runId,
    runId,
    scope: "run",
    status: "frozen",
    title: "Goal Requirement Coverage",
    payload: requirementCoverage(requirementIds, contractHash, options.coverageArtifactRefs),
    summary: { goalContractHash: contractHash },
  });
  await seedEvaluatorAttempt(db, {
    runId,
    taskId: "task-verify",
    sessionId: "session-1",
    attemptId: "attempt-1",
    evaluatorPipelineRef: "software-verification-quality",
  });
  return { runId, producerArtifactRefId: producerArtifact.artifactRefId, goalContractHash: contractHash };
}

function requirementCoverage(requirementIds: string[], contractHash: string, artifactRefs = ["artifact.implementation_report"]) {
  return {
    schemaVersion: "southstar.goal_requirement_coverage.v1",
    goalContractHash: contractHash,
    entries: requirementIds.map((requirementId) => ({
      requirementId,
      producerTaskIds: ["task-build"],
      artifactRefs,
      evaluatorTaskIds: ["task-verify"],
      evaluatorProfileRefs: ["evaluator.software-verification-quality"],
      requiredEvidenceKinds: ["artifact-ref", "command-output", "test-result"],
    })),
  };
}

function requirementGoalContract(
  requirementIds: string[],
  nonBlockingIds: string[] = [],
): GoalContractV1 {
  const prompt = "Build and independently verify the requested feature";
  return {
    schemaVersion: "southstar.goal_contract.v1",
    originalPrompt: prompt,
    promptHash: createHash("sha256").update(prompt).digest("hex"),
    revision: 1,
    workspace: { cwd: "/workspace" },
    domain: "software",
    intent: "implement_feature",
    summary: "Build and verify the requested feature",
    requirements: requirementIds.map((id) => ({
      id,
      statement: `Satisfy ${id}`,
      acceptanceCriteria: [`${id} is independently verified`],
      blocking: !nonBlockingIds.includes(id),
      source: "explicit",
    })),
    expectedArtifactRefs: ["artifact.implementation_report"],
    requiredCapabilities: ["software"],
    nonGoals: [],
    assumptions: [],
    blockingInputs: [],
    riskTags: [],
    requestedSideEffects: [],
  };
}

async function seedTaskEnvelope(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    evaluatorPipelineRef: string;
  },
): Promise<void> {
  const resourceKey = `task-envelope-${input.runId}-${input.taskId}-${input.attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: resourceKey,
    resourceType: "task_envelope",
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "task",
    status: "materialized",
    title: `Task envelope ${input.taskId}`,
    payload: {
      envelope: {
        schemaVersion: "southstar.task-envelope.v2",
        runId: input.runId,
        taskId: input.taskId,
        evaluatorPipeline: { id: input.evaluatorPipelineRef },
        session: { sessionId: input.sessionId },
      },
    },
    summary: { attemptId: input.attemptId },
  });
}

async function seedEvaluatorAttempt(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    evaluatorPipelineRef: string;
  },
): Promise<void> {
  const handExecutionId = `hand-execution:${input.runId}:${input.taskId}:${input.attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "hand",
    status: "running",
    title: `Hand execution ${input.taskId}`,
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      providerId: "tork",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      brainBindingId: `brain-${input.runId}-${input.taskId}`,
      handBindingId: `hand-${input.runId}-${input.taskId}`,
      status: "running",
      queuedAt: "2026-07-10T00:00:00.000Z",
      queueTimeoutSeconds: 60,
      heartbeatTimeoutSeconds: 60,
    },
    summary: { providerId: "tork", attemptId: input.attemptId },
  });
  const intentKey = `task-intent:${input.runId}:${input.taskId}:${input.attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: intentKey,
    resourceType: "task_execution_intent",
    resourceKey: intentKey,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "task",
    status: "created",
    title: `Task execution intent ${input.taskId}`,
    payload: {
      schemaVersion: "southstar.brain.task_execution_intent.v1",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      handProviderId: "tork",
    },
    summary: { attemptId: input.attemptId },
  });
  await createExecutorBindingPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    torkJobId: `job-${input.runId}-${input.taskId}-${input.attemptId}`,
    status: "running",
    now: "2026-07-10T00:00:00.000Z",
    queueTimeoutSeconds: 60,
    hardTimeoutSeconds: 600,
  });
  await seedTaskEnvelope(db, input);
}

async function replaceRequirementCoverage(db: SouthstarDb, runId: string, payload: unknown): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: `goal-requirement-coverage:${runId}`,
    resourceType: "goal_requirement_coverage",
    resourceKey: runId,
    runId,
    scope: "run",
    status: "frozen",
    title: "Goal Requirement Coverage",
    payload,
  });
}

async function evaluatorResourceCount(db: SouthstarDb, runId: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    `select count(*)::text as count
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = any($2::text[])`,
    [runId, ["evidence_packet", "validator_result", "requirement_evaluator_result"]],
  );
  return Number(row.count);
}

async function requirementResultRefFromArtifact(db: SouthstarDb, value: unknown): Promise<string> {
  const refs = (value as { evaluatorResultRefs?: unknown } | undefined)?.evaluatorResultRefs;
  if (!Array.isArray(refs)) throw new Error("callback artifact has no evaluator result refs");
  for (const ref of refs) {
    if (typeof ref !== "string") continue;
    if (await getResourceByKeyPg(db, "requirement_evaluator_result", ref)) return ref;
  }
  throw new Error("callback artifact has no requirement evaluator result ref");
}

async function latestRequirementResultPg(db: SouthstarDb, runId: string, requirementId: string) {
  const row = await db.maybeOne<{ resource_key: string }>(
    `select resource_key
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'requirement_evaluator_result'
        and payload_json -> 'requirementIds' @> $2::jsonb
      order by created_at desc, resource_key desc
      limit 1`,
    [runId, JSON.stringify([requirementId])],
  );
  return row ? await getResourceByKeyPg(db, "requirement_evaluator_result", row.resource_key) : null;
}

function validVerifierCallback(fixture: { runId: string; producerArtifactRefId: string }): PostgresTaskRunCallbackResult {
  return verifierCallback({
    runId: fixture.runId,
    artifact: {
      kind: "verification_report",
      pass: true,
      commandsRun: ["npm test"],
      testResults: [{ status: "passed" }],
      verifiedArtifactRefs: [fixture.producerArtifactRefId],
    },
  });
}

function verifierCallback(input: {
  runId: string;
  artifact: Record<string, unknown>;
  ok?: boolean;
  sessionId?: string;
  attemptId?: string;
  attempts?: number;
}): PostgresTaskRunCallbackResult {
  return {
    runId: input.runId,
    taskId: "task-verify",
    rootSessionId: input.sessionId ?? "session-1",
    ok: input.ok ?? true,
    attempts: input.attempts ?? 1,
    attemptId: input.attemptId ?? "attempt-1",
    artifact: input.artifact,
    metrics: {},
    events: [],
    receivedAt: "2026-07-10T00:05:00.000Z",
  };
}

async function post(baseUrl: string, path: string, body: unknown): Promise<{ ok: true; kind: string; result: { accepted?: boolean; duplicate?: boolean; artifactRefId?: string; artifactResourceId?: string } }> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; kind: string; result: { accepted?: boolean; duplicate?: boolean; artifactRefId?: string; artifactResourceId?: string } } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

function assertOrder(eventTypes: string[], before: string, after: string): void {
  const beforeIndex = eventTypes.indexOf(before);
  const afterIndex = eventTypes.indexOf(after);
  assert.notEqual(beforeIndex, -1, `missing event ${before}`);
  assert.notEqual(afterIndex, -1, `missing event ${after}`);
  assert.equal(beforeIndex < afterIndex, true, `${before} should come before ${after}`);
}

function withBeforeTopLevelTransaction(
  db: SouthstarDb,
  transactionNumber: number,
  before: () => Promise<void>,
): SouthstarDb {
  let count = 0;
  return {
    query: db.query.bind(db),
    one: db.one.bind(db),
    maybeOne: db.maybeOne.bind(db),
    tx: async (run) => {
      count += 1;
      if (count === transactionNumber) await before();
      return await db.tx(run);
    },
    close: async () => {},
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const db = await createTestPostgresDb();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}
