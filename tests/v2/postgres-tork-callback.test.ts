import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, getResourceByKeyPg, listHistoryForRunPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createExecutorBindingPg, getExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { ingestTaskRunResultPg, type PostgresTaskRunCallbackResult } from "../../src/v2/executor/postgres-tork-callback.ts";
import { persistBrainBindingPg, persistHandBindingPg } from "../../src/v2/meta-harness/postgres-bindings.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

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
    const evaluator = await getResourceByKeyPg(
      db,
      "requirement_evaluator_result",
      `requirement:${fixture.runId}:req-offline:task-verify`,
    );
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
    const evaluator = await getResourceByKeyPg(
      db,
      "requirement_evaluator_result",
      `requirement:${fixture.runId}:req-offline:task-verify`,
    );
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
    const evaluator = await getResourceByKeyPg(
      db,
      "requirement_evaluator_result",
      `requirement:${fixture.runId}:req-offline:task-verify`,
    );
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
    const evaluator = await getResourceByKeyPg(
      db,
      "requirement_evaluator_result",
      `requirement:${fixture.runId}:req-offline:task-verify`,
    );
    assert.equal(evaluator?.status, "failed");
  });
});

test("one evaluator task persists distinct evidence packets for multiple requirements", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-multiple");
    await upsertRuntimeResourcePg(db, {
      id: `goal-requirement-coverage:${fixture.runId}`,
      resourceType: "goal_requirement_coverage",
      resourceKey: fixture.runId,
      runId: fixture.runId,
      scope: "run",
      status: "frozen",
      payload: requirementCoverage(["req-offline", "req-installable"]),
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
        goalContractHash: "goal-contract-hash",
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
    const coverage = requirementCoverage(["req-offline"]);
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
    const evaluator = await getResourceByKeyPg(
      db,
      "requirement_evaluator_result",
      `requirement:${fixture.runId}:req-offline:task-verify`,
    );
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
    const evaluator = await getResourceByKeyPg(
      db,
      "requirement_evaluator_result",
      `requirement:${fixture.runId}:req-offline:task-verify`,
    );
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
): Promise<{ runId: string; producerArtifactRefId: string }> {
  await seedRunTask(db, runId, "task-verify");
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
    contractRefs: ["implementation_report"],
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
    payload: requirementCoverage(["req-offline"]),
    summary: { goalContractHash: "goal-contract-hash" },
  });
  return { runId, producerArtifactRefId: producerArtifact.artifactRefId };
}

function requirementCoverage(requirementIds: string[]) {
  return {
    schemaVersion: "southstar.goal_requirement_coverage.v1",
    goalContractHash: "goal-contract-hash",
    entries: requirementIds.map((requirementId) => ({
      requirementId,
      producerTaskIds: ["task-build"],
      artifactRefs: ["artifact.implementation_report"],
      evaluatorTaskIds: ["task-verify"],
      evaluatorProfileRefs: ["evaluator.software-verification-quality"],
      requiredEvidenceKinds: ["artifact-ref", "command-output", "test-result"],
    })),
  };
}

function verifierCallback(input: { runId: string; artifact: Record<string, unknown>; ok?: boolean }): PostgresTaskRunCallbackResult {
  return {
    runId: input.runId,
    taskId: "task-verify",
    rootSessionId: "session-1",
    ok: input.ok ?? true,
    attempts: 1,
    attemptId: "attempt-1",
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

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const db = await createTestPostgresDb();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}
