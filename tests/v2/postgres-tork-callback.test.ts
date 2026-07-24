import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { appendHistoryEventPg, createWorkflowRunPg, createWorkflowTaskPg, getResourceByKeyPg, listHistoryForRunPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createExecutorBindingPg, getExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
import { acceptOrRejectArtifactRefPg, artifactRefIdentity } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { artifactEvidenceClaims } from "../../src/v2/artifacts/evidence.ts";
import { ingestTaskRunResultPg, type PostgresTaskRunCallbackResult } from "../../src/v2/executor/postgres-tork-callback.ts";
import { persistBrainBindingPg, persistHandBindingPg } from "../../src/v2/meta-harness/postgres-bindings.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { goalContractHash, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import {
  inspectSupportedImage,
  loadFrozenCoverageContextsPg,
  prepareWorkspaceScreenshotProof,
  recordRequirementEvaluatorResultsPg,
} from "../../src/v2/evaluators/requirement-evaluator-results.ts";
import { canonicalGoalDesignPackageFixture } from "./fixtures/goal-design.ts";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=", "base64");
const ONE_PIXEL_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cf//Z", "base64");
const ONE_PIXEL_WEBP = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA", "base64");
const HEADER_ONLY_WEBP = Buffer.concat([
  Buffer.from("RIFF"), Buffer.from([18, 0, 0, 0]), Buffer.from("WEBPVP8L"),
  Buffer.from([5, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0]),
]);

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
        events: [{ eventType: "session.entry", actorType: "root-session", sessionId: "session-1", payload: { message: "started" } }],
      });

      assert.equal(first.result.accepted, true);
      assert.equal(duplicate.result.duplicate, true);

      const task = await db.one<{ status: string }>("select status from southstar.workflow_tasks where id = 'task-1' and run_id = 'run-callback-pg'");
      assert.equal(task.status, "completed");
      const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = 'run-callback-pg'");
      assert.equal(run.status, "completed");
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

      const evaluator = await db.one<{ status: string; payload_json: { executionStatus?: string; outcomeStatus?: string; findings?: string[] } }>(
        "select status, payload_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
        ["completion-gate:run-callback-pg"],
      );
      assert.equal(evaluator.status, "satisfied");
      assert.deepEqual(evaluator.payload_json, {
        executionStatus: "completed",
        outcomeStatus: "satisfied",
        findings: [],
      });

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
      assert.equal(run.status, "completed");
      const evaluator = await db.one<{ status: string; payload_json: { executionStatus?: string; outcomeStatus?: string; findings?: string[] } }>(
        "select status, payload_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
        ["completion-gate:run-callback-rejected"],
      );
      assert.equal(evaluator.status, "satisfied");
      assert.deepEqual(evaluator.payload_json, {
        executionStatus: "completed",
        outcomeStatus: "satisfied",
        findings: [],
      });
      const history = await listHistoryForRunPg(db, "run-callback-rejected");
      assert.equal(history.some((event) => event.eventType === "artifact.rejected"), true);
      const completed = history.filter((event) => event.eventType === "run.completed");
      assert.equal(completed.length, 1);
      assert.equal(completed[0]?.actorType, "evaluator");
      assert.deepEqual(completed[0]?.payload, {
        schemaVersion: "southstar.goal_outcome.v1",
        outcomeStatus: "satisfied",
        coveredRequirementIds: [],
        failedRequirementIds: [],
        findings: [],
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
      assert.equal(run.status, "completed");
      const evaluator = await db.one<{ status: string; payload_json: { executionStatus?: string; outcomeStatus?: string; findings?: string[] } }>(
        "select status, payload_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
        ["completion-gate:run-callback-stale"],
      );
      assert.equal(evaluator.status, "satisfied");
      assert.deepEqual(evaluator.payload_json, {
        executionStatus: "completed",
        outcomeStatus: "satisfied",
        findings: [],
      });
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
      assert.equal(run.status, "completed");
      const evaluator = await db.one<{ status: string; payload_json: { executionStatus?: string; outcomeStatus?: string; findings?: string[] } }>(
        "select status, payload_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
        ["completion-gate:run-callback-terminal"],
      );
      assert.equal(evaluator.status, "satisfied");
      assert.deepEqual(evaluator.payload_json, {
        executionStatus: "completed",
        outcomeStatus: "satisfied",
        findings: [],
      });
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
        commandsRun: [{ command: "npm test", status: "passed" }],
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
    assert.equal((evaluator?.payload as { schemaVersion?: string }).schemaVersion, "southstar.requirement_evaluator_result.v2");
    assert.equal((evaluator?.payload as { requirementId?: string }).requirementId, "req-offline");
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
    assert.equal(completion?.status, "unsatisfied");
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
        commandsRun: [{ command: "npm test", status: "passed" }],
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
        commandsRun: [{ command: "npm test", status: "passed" }],
        testResults: [{ note: "no result status" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));

    assert.equal(result.accepted, false);
    const evaluator = await latestRequirementResultPg(db, fixture.runId, "req-offline");
    assert.equal(evaluator?.status, "failed");
  });
});

test("blocking verifier callbacks reject command results without a passing outcome", async () => {
  await withDb(async (db) => {
    for (const [suffix, testResult] of [
      ["missing", { command: "npm test" }],
      ["unknown", { command: "npm test", status: "unknown" }],
      ["failed", { command: "npm test", exitCode: 1 }],
    ] as const) {
      const fixture = await seedRequirementEvidenceRun(db, `run-requirement-command-${suffix}`);
      const result = await ingestTaskRunResultPg(db, verifierCallback({
        runId: fixture.runId,
        artifact: {
          kind: "verification_report",
          pass: true,
          testResults: [testResult],
          verifiedArtifactRefs: [fixture.producerArtifactRefId],
        },
      }));
      assert.equal(result.accepted, false, suffix);
      assert.equal((await latestRequirementResultPg(db, fixture.runId, "req-offline"))?.status, "failed", suffix);
    }
  });
});

test("command-output coverage ignores plans and accepts only structured executed commands", async () => {
  await withDb(async (db) => {
    const planned = await seedRequirementEvidenceRun(db, "run-requirement-command-planned");
    const plannedCoverage = requirementCoverage(["req-offline"], planned.goalContractHash);
    plannedCoverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "command-output"];
    await replaceRequirementCoverage(db, planned.runId, plannedCoverage);
    const plannedResult = await ingestTaskRunResultPg(db, verifierCallback({
      runId: planned.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsToRun: [{ command: "npm test", status: "passed" }],
        verifiedArtifactRefs: [planned.producerArtifactRefId],
      },
    }));
    assert.equal(plannedResult.accepted, false);

    const executed = await seedRequirementEvidenceRun(db, "run-requirement-command-executed");
    const executedCoverage = requirementCoverage(["req-offline"], executed.goalContractHash);
    executedCoverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "command-output"];
    await replaceRequirementCoverage(db, executed.runId, executedCoverage);
    const executedResult = await ingestTaskRunResultPg(db, verifierCallback({
      runId: executed.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: [{ command: ["npm", "test"], exitCode: 0 }],
        verifiedArtifactRefs: [executed.producerArtifactRefId],
      },
    }));
    assert.equal(executedResult.accepted, true);
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
      criterionIds: ["criterion-req-offline", "criterion-req-installable"],
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: [{ command: "npm test", status: "passed" }],
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

test("requirement evaluation returns only failed blocking requirement ids for targeted repair", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-partial-failure", {
      requirementIds: ["req-passed", "req-failed"],
    });
    const coverage = requirementCoverage(["req-passed", "req-failed"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref"];
    coverage.entries[1]!.requiredEvidenceKinds = ["artifact-ref", "screenshot"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);

    const result = await recordRequirementEvaluatorResultsPg(db, {
      runId: fixture.runId,
      taskId: "task-verify",
      artifactRefId: "artifact-ref:partial-verification",
      artifact: {
        kind: "verification_report",
        pass: true,
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
        criteriaResults: ["req-passed", "req-failed"].map((requirementId) => ({
          criterionId: `criterion-${requirementId}`,
          verdict: "passed",
          evidenceRefs: [fixture.producerArtifactRefId],
          findings: [],
        })),
      },
      callbackOk: true,
      rootSessionId: "session-1",
      attemptId: "attempt-1",
      handExecutionId: `hand-execution:${fixture.runId}:task-verify:attempt-1`,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.failedBlockingRequirementIds, ["req-failed"]);
    assert.equal((await latestRequirementResultPg(db, fixture.runId, "req-passed"))?.status, "passed");
    assert.equal((await latestRequirementResultPg(db, fixture.runId, "req-failed"))?.status, "blocked");
  });
});

test("requirement evaluation persists a blocking incompatibility for legacy coverage without frozen criteria", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-legacy-coverage");
    await replaceRequirementCoverage(
      db,
      fixture.runId,
      legacyRequirementCoverage(["req-offline"], fixture.goalContractHash),
    );

    const result = await recordRequirementEvaluatorResultsPg(db, {
      runId: fixture.runId,
      taskId: "task-verify",
      artifactRefId: "artifact-ref:legacy-verification",
      artifact: {
        kind: "verification_report",
        pass: true,
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
      callbackOk: true,
      rootSessionId: "session-1",
      attemptId: "attempt-1",
      handExecutionId: `hand-execution:${fixture.runId}:task-verify:attempt-1`,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.failedBlockingRequirementIds, []);
    assert.deepEqual(result.findings, [
      "canonical_goal_requirement_coverage_invalid: run run-requirement-legacy-coverage frozen Goal Requirement Coverage is incompatible with canonical Goal Design lineage",
    ]);
    const exception = await db.one<{ status: string; payload_json: { providerEvidence: { code: string; message: string } } }>(
      `select status, payload_json
         from southstar.runtime_resources
        where run_id = $1 and task_id = 'task-verify' and resource_type = 'runtime_exception'`,
      [fixture.runId],
    );
    assert.equal(exception.status, "blocked");
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_requirement_coverage_invalid");
    assert.equal(exception.payload_json.providerEvidence.message, result.findings[0]);
  });
});

test("RequirementEvaluatorResultV2 passes only when every frozen criterion has valid evidence", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-criterion-pass");
    await upgradeRequirementCoverageToV2(db, fixture.runId, fixture.goalContractHash, "req-offline");

    const result = await recordRequirementEvaluatorResultsPg(db, {
      runId: fixture.runId,
      taskId: "task-verify",
      artifactRefId: "artifact-ref:criterion-verification",
      artifact: {
        verdict: "passed",
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
        criteriaResults: [{
          criterionId: "criterion-req-offline",
          verdict: "passed",
          evidenceRefs: [fixture.producerArtifactRefId],
          findings: [],
        }],
      },
      callbackOk: true,
      rootSessionId: "session-1",
      attemptId: "attempt-1",
      handExecutionId: `hand-execution:${fixture.runId}:task-verify:attempt-1`,
    });

    assert.equal(result.ok, true);
    const stored = await latestRequirementResultPg(db, fixture.runId, "req-offline");
    assert.equal((stored?.payload as any).schemaVersion, "southstar.requirement_evaluator_result.v2");
    assert.equal((stored?.payload as any).criteriaResults[0].verdict, "passed");
    assert.equal((stored?.payload as any).evaluatorProfileVersionRef, "evaluator.software-verification-quality@2");
  });
});

test("a shared evaluator artifact may report frozen criteria for every covered requirement", async () => {
  await withDb(async (db) => {
    const runId = "run-requirement-shared-criteria-artifact";
    const requirementIds = ["req-membership", "req-authorization"];
    const fixture = await seedRequirementEvidenceRun(db, runId, { requirementIds });
    const coverage = requirementCoverage(requirementIds, fixture.goalContractHash);
    for (const entry of coverage.entries) {
      Object.assign(entry, {
        evaluatorProfileVersionRefs: ["evaluator.software-verification-quality@2"],
        validationBindingId: `binding-${entry.requirementId}`,
        criterionIds: [`criterion-${entry.requirementId}`],
        acceptanceCriteria: [`${entry.requirementId} is independently verified`],
        requiredEvidenceKinds: ["artifact-ref"],
      });
      entry.evaluatorProfileRefs = ["evaluator.software-verification-quality"];
    }
    await replaceRequirementCoverage(db, runId, coverage);
    await db.query(
      `update southstar.workflow_runs
          set workflow_manifest_json = workflow_manifest_json || $2::jsonb
        where id = $1`,
      [runId, JSON.stringify({
        evaluatorPipelines: [{
          id: "software-verification-quality",
          libraryObjectRef: "evaluator.software-verification-quality",
          libraryVersionRef: "evaluator.software-verification-quality@2",
          validationBindingIds: requirementIds.map((requirementId) => `binding-${requirementId}`),
          evaluators: requirementIds.map((requirementId) => ({
            id: `check-${requirementId}`,
            kind: "checker-agent",
            required: true,
            config: {
              validationBindingId: `binding-${requirementId}`,
              requirementId,
              criterionId: `criterion-${requirementId}`,
              acceptanceCriterion: `${requirementId} is independently verified`,
              expectedEvidenceKinds: ["artifact-ref"],
              procedureRef: "procedure.test",
              verificationMode: "deterministic",
            },
          })),
          onFailure: { defaultStrategy: "request-workflow-revision" },
        }],
      })],
    );

    const result = await recordRequirementEvaluatorResultsPg(db, {
      runId,
      taskId: "task-verify",
      artifactRefId: "artifact-ref:shared-criteria-verification",
      artifact: {
        verdict: "passed",
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
        criteriaResults: requirementIds.map((requirementId) => ({
          criterionId: `criterion-${requirementId}`,
          verdict: "passed",
          evidenceRefs: [fixture.producerArtifactRefId],
          findings: [],
        })),
      },
      callbackOk: true,
      rootSessionId: "session-1",
      attemptId: "attempt-1",
      handExecutionId: `hand-execution:${runId}:task-verify:attempt-1`,
    });

    assert.equal(result.ok, true, result.findings.join("\n"));
    assert.equal((await latestRequirementResultPg(db, runId, "req-membership"))?.status, "passed");
    assert.equal((await latestRequirementResultPg(db, runId, "req-authorization"))?.status, "passed");
  });
});

test("frozen coverage scopes a shared evaluator pipeline by validation binding", async () => {
  await withDb(async (db) => {
    const runId = "run-requirement-shared-evaluator";
    const requirementIds = ["req-entry", "req-quiz"];
    const fixture = await seedRequirementEvidenceRun(db, runId, { requirementIds });
    const coverage = requirementCoverage(requirementIds, fixture.goalContractHash);
    for (const entry of coverage.entries) {
      Object.assign(entry, {
        evaluatorProfileVersionRefs: ["evaluator.shared-quality@2"],
        validationBindingId: `binding-${entry.requirementId}`,
        criterionIds: [`criterion-${entry.requirementId}`],
        acceptanceCriteria: [`${entry.requirementId} is independently verified`],
        requiredEvidenceKinds: ["artifact-ref"],
      });
      entry.evaluatorProfileRefs = ["evaluator.shared-quality"];
    }
    await replaceRequirementCoverage(db, runId, coverage);
    await db.query(
      `update southstar.workflow_runs
          set workflow_manifest_json = workflow_manifest_json || $2::jsonb
        where id = $1`,
      [runId, JSON.stringify({
        evaluatorPipelines: [{
          id: "shared-quality",
          libraryObjectRef: "evaluator.shared-quality",
          libraryVersionRef: "evaluator.shared-quality@2",
          validationBindingIds: requirementIds.map((requirementId) => `binding-${requirementId}`),
          evaluators: requirementIds.map((requirementId) => ({
            id: `check-${requirementId}`,
            kind: "checker-agent",
            required: true,
            config: {
              validationBindingId: `binding-${requirementId}`,
              requirementId,
              criterionId: `criterion-${requirementId}`,
              acceptanceCriterion: `${requirementId} is independently verified`,
              expectedEvidenceKinds: ["artifact-ref"],
              procedureRef: "procedure.test",
              verificationMode: "deterministic",
            },
          })),
          onFailure: { defaultStrategy: "request-workflow-revision" },
        }],
      })],
    );
    await db.query(
      `update southstar.workflow_runs
          set workflow_manifest_json = jsonb_set(
            workflow_manifest_json,
            '{tasks,0,evaluatorPipelineRef}',
            to_jsonb('shared-quality'::text)
          )
        where id = $1`,
      [runId],
    );

    const contexts = await loadFrozenCoverageContextsPg(db, [runId]);
    assert.deepEqual(
      contexts.get(runId)?.coverage.entries.map((entry) => entry.criterionIds),
      [["criterion-req-entry"], ["criterion-req-quiz"]],
    );
  });
});

test("an LLM overall passed verdict cannot hide a missing frozen criterion", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-criterion-missing");
    await upgradeRequirementCoverageToV2(db, fixture.runId, fixture.goalContractHash, "req-offline");

    const result = await recordRequirementEvaluatorResultsPg(db, {
      runId: fixture.runId,
      taskId: "task-verify",
      artifactRefId: "artifact-ref:criterion-verification-missing",
      artifact: {
        verdict: "passed",
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
        criteriaResults: [],
      },
      callbackOk: true,
      rootSessionId: "session-1",
      attemptId: "attempt-1",
      handExecutionId: `hand-execution:${fixture.runId}:task-verify:attempt-1`,
    });

    assert.equal(result.ok, false);
    assert.match(result.findings.join("\n"), /missing criterion result criterion-req-offline/);
    assert.equal((await latestRequirementResultPg(db, fixture.runId, "req-offline"))?.status, "blocked");
  });
});

test("malformed frozen requirement coverage persists a blocking canonical diagnostic", async () => {
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

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: { kind: "verification_report", pass: true },
    }));

    assert.equal(result.accepted, false);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [fixture.runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_requirement_coverage_invalid");
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

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        commandsRun: [{ command: "npm test", status: "passed" }],
        testResults: [{ status: "passed" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));
    assert.equal(result.accepted, false);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [fixture.runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_requirement_coverage_invalid");
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
        commandsRun: [{ command: "npm test", status: "passed" }],
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
        commandsRun: [{ command: "npm test", status: "passed" }],
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
    await seedRequirementEvidenceRun(db, runId);
    await db.query(
      "delete from southstar.runtime_resources where resource_type = 'goal_requirement_coverage' and resource_key = $1",
      [runId],
    );

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId,
      artifact: { kind: "verification_report", pass: true },
    }));
    assert.equal(result.accepted, false);
    const evaluator = await db.one<{ status: string; payload_json: { findings: string[] } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'evaluator_result' and resource_key = $1",
      [`completion-gate:${runId}`],
    );
    assert.equal(evaluator.status, "blocked");
    assert.deepEqual(evaluator.payload_json.findings, [
      `canonical_goal_requirement_coverage_missing: run ${runId} has no frozen goal requirement coverage`,
    ]);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_requirement_coverage_missing");
  });
});

test("a callback with no canonical Goal Design lineage fails closed", async () => {
  await withDb(async (db) => {
    const runId = "run-requirement-missing-goal-design-lineage";
    await seedRequirementEvidenceRun(db, runId);
    await db.query(
      `delete from southstar.runtime_resources
        where resource_key = $1
           or (run_id = $2 and resource_type = 'goal_requirement_coverage')`,
      [`draft-${runId}`, runId],
    );
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = '{}'::jsonb where id = $1",
      [runId],
    );

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId,
      artifact: { kind: "verification_report", pass: true },
    }));

    assert.equal(result.accepted, false);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_design_package_required");
  });
});

test("a callback with frozen coverage but missing canonical lineage persists a blocking diagnostic", async () => {
  await withDb(async (db) => {
    const runId = "run-requirement-partial-goal-design-lineage";
    await seedRequirementEvidenceRun(db, runId);
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = '{}'::jsonb where id = $1",
      [runId],
    );

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId,
      artifact: { kind: "verification_report", pass: true },
    }));

    assert.equal(result.accepted, false);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_design_package_required");
  });
});

test("browser criterion blocks evaluator acceptance without runtime-observed Playwright CLI evidence", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-browser-cli-evidence-required", {
      verificationMode: "browser_interaction",
    });
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref"];
    coverage.entries[0]!.criterionBindings[0]!.verificationMode = "browser_interaction";
    coverage.entries[0]!.criterionBindings[0]!.procedureRef = "procedure.browser-interaction";
    await replaceRequirementCoverage(db, fixture.runId, coverage);

    const result = await recordRequirementEvaluatorResultsPg(db, {
      runId: fixture.runId,
      taskId: "task-verify",
      artifactRefId: "artifact-ref:browser-cli-verification",
      artifact: {
        verdict: "passed",
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
        commandsRun: [
          { command: "playwright-cli open http://127.0.0.1:30141", status: "passed", ok: true },
          { command: "playwright-cli snapshot", status: "passed", ok: true },
        ],
        criteriaResults: [{
          criterionId: "criterion-req-offline",
          verificationMode: "browser_interaction",
          verdict: "passed",
          evidenceRefs: [fixture.producerArtifactRefId],
          findings: [],
        }],
      },
      callbackOk: true,
      rootSessionId: "session-1",
      attemptId: "attempt-1",
      handExecutionId: `hand-execution:${fixture.runId}:task-verify:attempt-1`,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.failedBlockingRequirementIds, ["req-offline"]);
    assert.equal(result.findings.includes(
      "browser interaction requires a successful direct playwright-cli navigation command",
    ), true);
    assert.equal(result.findings.includes(
      "browser interaction requires a successful direct playwright-cli observation command",
    ), true);
  });
});

test("browser verifier evidence passes only with valid structured URL and screenshot evidence", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-browser-requirement-evidence", {
      verificationMode: "browser_interaction",
    });
    const workspace = await mkdtemp(join(tmpdir(), "southstar-screenshot-"));
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "url", "screenshot"];
    coverage.entries[0]!.criterionBindings[0]!.verificationMode = "browser_interaction";
    coverage.entries[0]!.criterionBindings[0]!.procedureRef = "procedure.browser-interaction";
    await replaceRequirementCoverage(db, fixture.runId, coverage);
    try {
      const screenshotBytes = ONE_PIXEL_PNG;
      await mkdir(join(workspace, "artifacts"));
      await writeFile(join(workspace, "artifacts/subscription-page.png"), screenshotBytes);
      await db.query(
        "update southstar.workflow_runs set runtime_context_json = jsonb_set(runtime_context_json, '{projectRoot}', to_jsonb($2::text)) where id = $1",
        [fixture.runId, workspace],
      );

      const result = await ingestTaskRunResultPg(db, verifierCallback({
        runId: fixture.runId,
        artifact: {
          kind: "verification_report",
          pass: true,
          verifiedArtifactRefs: [fixture.producerArtifactRefId],
          browserEvidence: {
            url: "https://example.test/subscriptions?view=summary#details",
            screenshots: [{ path: "artifacts/subscription-page.png" }],
          },
          runtimeCommandExecutions: [
            {
              ref: "playwright-cli open https://example.test/subscriptions?view=summary#details --browser chromium",
              command: "playwright-cli open https://example.test/subscriptions?view=summary#details --browser chromium",
              status: "passed",
              ok: true,
            },
            {
              ref: "playwright-cli screenshot --filename artifacts/subscription-page.png",
              command: "playwright-cli screenshot --filename artifacts/subscription-page.png",
              status: "passed",
              ok: true,
            },
          ],
        },
      }));

      assert.equal(result.accepted, true);
      const evidence = (await listResourcesPg(db, { resourceType: "evidence_packet" }))
        .find((resource) => resource.runId === fixture.runId);
      const screenshot = (evidence?.payload as { evidenceItems?: Array<{ kind: string; sha256?: string }> })
        .evidenceItems?.find((item) => item.kind === "screenshot");
      assert.equal(screenshot?.sha256, createHash("sha256").update(screenshotBytes).digest("hex"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

test("image evidence requires complete bounded PNG, JPEG, or WebP structure", () => {
  assert.deepEqual(inspectSupportedImage(ONE_PIXEL_PNG), { format: "png", width: 1, height: 1 });
  assert.deepEqual(inspectSupportedImage(ONE_PIXEL_JPEG), { format: "jpeg", width: 1, height: 1 });
  assert.deepEqual(inspectSupportedImage(ONE_PIXEL_WEBP), { format: "webp", width: 1, height: 1 });
  const pngWithoutIdat = Buffer.concat([ONE_PIXEL_PNG.subarray(0, 33), ONE_PIXEL_PNG.subarray(-12)]);
  const jpegWithoutScan = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  const webpExtendedWithoutImage = Buffer.concat([
    Buffer.from("RIFF"), Buffer.from([22, 0, 0, 0]), Buffer.from("WEBPVP8X"),
    Buffer.from([10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  const webpBadVersion = Buffer.from(ONE_PIXEL_WEBP);
  webpBadVersion[24] = webpBadVersion[24]! | 0xe0;
  const webpBadPadding = Buffer.concat([
    ONE_PIXEL_WEBP.subarray(0, 12),
    Buffer.from("JUNK"), Buffer.from([1, 0, 0, 0, 0, 1]),
    ONE_PIXEL_WEBP.subarray(12),
  ]);
  webpBadPadding.writeUInt32LE(webpBadPadding.length - 8, 4);
  for (const invalid of [
    ONE_PIXEL_PNG.subarray(0, 8),
    Buffer.concat([ONE_PIXEL_PNG, Buffer.from("garbage")]),
    pngWithoutIdat,
    ONE_PIXEL_JPEG.subarray(0, 3),
    jpegWithoutScan,
    Buffer.from([0x52, 0x49, 0x46, 0x46, 0x0c, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0]),
    webpExtendedWithoutImage,
    webpBadVersion,
    webpBadPadding,
  ]) assert.equal(inspectSupportedImage(invalid), undefined);
});

test("workspace screenshot proof reads a contained regular image through one no-follow file descriptor", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "southstar-proof-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "southstar-proof-outside-"));
  try {
    await writeFile(join(workspace, "inside.png"), ONE_PIXEL_PNG);
    await writeFile(join(outside, "outside.png"), ONE_PIXEL_PNG);
    await symlink(join(outside, "outside.png"), join(workspace, "linked.png"));
    const proof = await prepareWorkspaceScreenshotProof(workspace, "inside.png");
    assert.equal(proof?.sha256, createHash("sha256").update(ONE_PIXEL_PNG).digest("hex"));
    assert.deepEqual(proof && { format: proof.format, width: proof.width, height: proof.height }, { format: "png", width: 1, height: 1 });
    assert.equal(await prepareWorkspaceScreenshotProof(workspace, "linked.png"), undefined);
    assert.equal(await prepareWorkspaceScreenshotProof(workspace, "../outside.png"), undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("workspace screenshot proof requires full decoder success, not only valid container headers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "southstar-decoded-proof-"));
  const pngChunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const syntheticPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Buffer.from([0])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const syntheticJpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0,
    0xff, 0xd9,
  ]);
  try {
    for (const [name, content] of [
      ["synthetic.png", syntheticPng],
      ["synthetic.jpg", syntheticJpeg],
      ["synthetic.webp", HEADER_ONLY_WEBP],
    ] as const) {
      assert.ok(inspectSupportedImage(content), name);
      await writeFile(join(workspace, name), content);
      assert.equal(await prepareWorkspaceScreenshotProof(workspace, name), undefined, name);
    }
    for (const [name, content] of [
      ["real.png", ONE_PIXEL_PNG],
      ["real.jpg", ONE_PIXEL_JPEG],
      ["real.webp", ONE_PIXEL_WEBP],
    ] as const) {
      await writeFile(join(workspace, name), content);
      assert.ok(await prepareWorkspaceScreenshotProof(workspace, name), name);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workspace screenshot proof is prepared before the callback run-lock transaction", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-browser-proof-before-lock");
    const workspace = await mkdtemp(join(tmpdir(), "southstar-proof-before-lock-"));
    const screenshotPath = join(workspace, "proof.png");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "screenshot"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);
    await writeFile(screenshotPath, ONE_PIXEL_PNG);
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = jsonb_set(runtime_context_json, '{projectRoot}', to_jsonb($2::text)) where id = $1",
      [fixture.runId, workspace],
    );
    try {
      const instrumented = withBeforeTopLevelTransaction(db, 2, async () => {
        await rm(screenshotPath);
      });
      const result = await ingestTaskRunResultPg(instrumented, verifierCallback({
        runId: fixture.runId,
        artifact: {
          kind: "verification_report",
          pass: true,
          verifiedArtifactRefs: [fixture.producerArtifactRefId],
          screenshot: { path: "proof.png" },
        },
      }));
      assert.equal(result.accepted, true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

test("canonical screenshot artifact_ref written by the production store passes verifier evidence", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-browser-canonical-artifact");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "screenshot"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);
    const screenshot = await acceptOrRejectArtifactRefPg(db, {
      runId: fixture.runId,
      taskId: "task-build",
      sessionId: "session-build",
      attemptId: "attempt-screenshot",
      handExecutionId: `hand-execution:${fixture.runId}:task-build:attempt-screenshot`,
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: "screenshot",
      status: "accepted",
      content: { kind: "screenshot", base64: ONE_PIXEL_PNG.toString("base64") },
      contractRefs: ["screenshot"],
      summary: "Canonical screenshot",
    });
    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
        screenshot: { artifactRef: screenshot.artifactRefId },
      },
    }));
    assert.equal(result.accepted, true);
  });
});

test("canonical screenshot artifact_ref rejects structurally valid but undecodable JSON image content", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-browser-undecodable-artifact");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "screenshot"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);
    const screenshot = await acceptOrRejectArtifactRefPg(db, {
      runId: fixture.runId,
      taskId: "task-build",
      sessionId: "session-build",
      attemptId: "attempt-screenshot",
      handExecutionId: `hand-execution:${fixture.runId}:task-build:attempt-screenshot`,
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: "screenshot",
      status: "accepted",
      content: { kind: "screenshot", base64: HEADER_ONLY_WEBP.toString("base64") },
      contractRefs: ["screenshot"],
      summary: "Undecodable screenshot",
    });
    assert.ok(inspectSupportedImage(HEADER_ONLY_WEBP));
    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      artifact: {
        kind: "verification_report",
        pass: true,
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
        screenshot: { artifactRef: screenshot.artifactRefId },
      },
    }));
    assert.equal(result.accepted, false);
  });
});

test("workspace screenshot evidence rejects a non-image file with an image extension", async () => {
  await withDb(async (db) => {
    const runId = "run-browser-fake-image";
    const fixture = await seedRequirementEvidenceRun(db, runId);
    const workspace = await mkdtemp(join(tmpdir(), "southstar-fake-screenshot-"));
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "screenshot"];
    await replaceRequirementCoverage(db, runId, coverage);
    try {
      await writeFile(join(workspace, "fake.png"), "not an image");
      await db.query(
        "update southstar.workflow_runs set runtime_context_json = jsonb_set(runtime_context_json, '{projectRoot}', to_jsonb($2::text)) where id = $1",
        [runId, workspace],
      );
      const result = await ingestTaskRunResultPg(db, verifierCallback({
        runId,
        artifact: {
          kind: "verification_report",
          pass: true,
          verifiedArtifactRefs: [fixture.producerArtifactRefId],
          screenshot: { path: "fake.png" },
        },
      }));
      assert.equal(result.accepted, false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

test("unverifiable canonical and relative screenshot claims block evaluator acceptance", async () => {
  await withDb(async (db) => {
    for (const [suffix, screenshot] of [
      ["canonical", { artifactRef: `artifact_ref:run-browser-missing-canonical:task-build:attempt-1:${"a".repeat(64)}` }],
      ["relative", { path: "artifacts/does-not-exist.png" }],
    ] as const) {
      const runId = `run-browser-missing-${suffix}`;
      const fixture = await seedRequirementEvidenceRun(db, runId);
      const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
      coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref", "screenshot"];
      await replaceRequirementCoverage(db, runId, coverage);

      const result = await ingestTaskRunResultPg(db, verifierCallback({
        runId,
        artifact: {
          kind: "verification_report",
          pass: true,
          verifiedArtifactRefs: [fixture.producerArtifactRefId],
          screenshot,
        },
      }));

      assert.equal(result.accepted, false, suffix);
      assert.equal((await latestRequirementResultPg(db, runId, "req-offline"))?.status, "failed", suffix);
    }
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
    assert.equal((await latestRequirementResultPg(db, fixture.runId, "req-offline"))?.status, "blocked");
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
        commandsRun: [{ command: "npm test", status: "passed" }],
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
        commandsRun: [{ command: "npm test", status: "passed" }],
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

test("callback receipts distinguish identical artifacts with different identity and result semantics", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-semantic-receipt");
    const callback = validVerifierCallback(fixture);
    const first = await ingestTaskRunResultPg(db, callback);
    assert.equal(first.accepted, true);

    await assert.rejects(
      () => ingestTaskRunResultPg(db, { ...callback, rootSessionId: "session-spoofed" }),
      /evaluator execution identity .*sessionId/,
    );

    for (const changed of [
      { ...callback, ok: false },
      { ...callback, events: [{ eventType: "agent.note", actorType: "hand" as const, payload: { note: "changed" } }] },
      { ...callback, metrics: { durationMs: 9 } },
    ]) {
      const result = await ingestTaskRunResultPg(db, changed);
      assert.notEqual(result.duplicate, true);
      assert.equal(result.accepted, false);
    }
  });
});

test("second callback transaction checks a concurrently committed receipt before current attempt identity", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-receipt-race");
    const callback = validVerifierCallback(fixture);
    const attemptId = callback.attemptId!;
    const handExecutionId = `hand-execution:${fixture.runId}:task-verify:${attemptId}`;
    const artifactHash = createHash("sha256").update(stableStringify(callback.artifact)).digest("hex");
    const receiptKey = `${handExecutionId}:callback:${callbackSemanticHash(callback)}`;
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

test("frozen coverage with mismatched Goal Contract hash or task membership persists blocking diagnostics", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-hash-mismatch");
    await db.query(
      `update southstar.runtime_resources
          set payload_json = jsonb_set(payload_json, '{goalContractHash}', to_jsonb('wrong-hash'::text))
        where resource_type = 'goal_requirement_coverage' and resource_key = $1`,
      [fixture.runId],
    );
    const result = await ingestTaskRunResultPg(db, validVerifierCallback(fixture));
    assert.equal(result.accepted, false);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [fixture.runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_requirement_coverage_invalid");
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
    const result = await ingestTaskRunResultPg(db, validVerifierCallback(fixture));
    assert.equal(result.accepted, false);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [fixture.runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_requirement_coverage_invalid");
  });
});

test("frozen coverage with phantom producer tasks persists a blocking diagnostic", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-phantom-producer");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.producerTaskIds = ["task-phantom"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);
    const result = await ingestTaskRunResultPg(db, validVerifierCallback(fixture));
    assert.equal(result.accepted, false);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [fixture.runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_requirement_coverage_invalid");
  });
});

test("frozen coverage with undeclared producer artifact contracts persists a blocking diagnostic", async () => {
  await withDb(async (db) => {
    const fixture = await seedRequirementEvidenceRun(db, "run-requirement-undeclared-artifact");
    const coverage = requirementCoverage(["req-offline"], fixture.goalContractHash);
    coverage.entries[0]!.artifactRefs = ["artifact.not-declared-by-producer"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);
    const result = await ingestTaskRunResultPg(db, validVerifierCallback(fixture));
    assert.equal(result.accepted, false);
    const exception = await db.one<{ payload_json: { providerEvidence: { code: string } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'runtime_exception' and run_id = $1",
      [fixture.runId],
    );
    assert.equal(exception.payload_json.providerEvidence.code, "canonical_goal_requirement_coverage_invalid");
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
      artifactContractRefs: [],
      evaluatorTaskIds: [],
      evaluatorProfileRefs: [],
      evaluatorProfileVersionRefs: [],
      criterionIds: [],
      criterionBindings: [],
      acceptanceCriteria: [],
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
    const coverage = requirementCoverage(["req-blocking", "req-optional"], fixture.goalContractHash, undefined, ["req-blocking"]);
    coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref"];
    coverage.entries[1]!.requiredEvidenceKinds = ["artifact-ref", "screenshot"];
    await replaceRequirementCoverage(db, fixture.runId, coverage);

    const result = await ingestTaskRunResultPg(db, verifierCallback({
      runId: fixture.runId,
      criterionIds: ["criterion-req-blocking", "criterion-req-optional"],
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
        commandsRun: [{ command: "npm test", status: "passed" }],
        testResults: [{ status: "passed" }],
        verifiedArtifactRefs: [fixture.producerArtifactRefId],
      },
    }));
    assert.equal(retry.accepted, true);
  });
});

async function seedRunTask(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  const goalContract = requirementGoalContract(["req-callback"], ["req-callback"]);
  const contractHash = goalContractHash(goalContract);
  const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract, undefined, {
    evaluatorProfileRef: "evaluator.software-verification-quality",
    evaluatorProfileVersionRef: "evaluator.software-verification-quality@2",
  });
  const draftId = `draft-${runId}`;
  await upsertRuntimeResourcePg(db, {
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    payload: { goalContract, goalContractHash: contractHash, goalDesignPackage },
  });
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
    runtimeContextJson: JSON.stringify({
      draftId,
      goalContractHash: contractHash,
      goalDesignPackageHash: goalDesignPackage.packageHash,
    }),
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
  await upsertRuntimeResourcePg(db, {
    resourceType: "goal_requirement_coverage",
    resourceKey: runId,
    runId,
    scope: "run",
    status: "frozen",
    payload: {
      schemaVersion: "southstar.goal_requirement_coverage.v1",
      goalContractHash: contractHash,
      entries: [],
    },
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
    manifestArtifactContracts?: Array<{
      id: string;
      artifactType: string;
      requiredFields: string[];
      evidenceFields: string[];
      libraryObjectRef?: string;
      libraryVersionRef?: string;
    }>;
    verificationMode?: "deterministic" | "browser_interaction";
  } = {},
): Promise<{ runId: string; producerArtifactRefId: string; goalContractHash: string }> {
  await seedRunTask(db, runId, "task-verify");
  const requirementIds = options.requirementIds ?? ["req-offline"];
  const goalContract = requirementGoalContract(
    requirementIds,
    options.nonBlockingRequirementIds,
    options.verificationMode,
  );
  const contractHash = goalContractHash(goalContract);
  const goalDesignPackage = canonicalGoalDesignPackageFixture(goalContract, undefined, {
    evaluatorProfileRef: "evaluator.software-verification-quality",
    evaluatorProfileVersionRef: "evaluator.software-verification-quality@2",
  });
  const draftId = `draft-${runId}`;
  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: `Planner draft ${runId}`,
    payload: {
      goalContract,
      goalContractHash: contractHash,
      goalDesignPackage,
    },
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
      JSON.stringify({
        draftId,
        goalContractHash: contractHash,
        goalDesignPackageHash: goalDesignPackage.packageHash,
      }),
      JSON.stringify({
        artifactContracts: options.manifestArtifactContracts ?? [{
          id: "artifact.implementation_report",
          artifactType: "implementation_report",
          requiredFields: ["summary"],
          evidenceFields: [],
          libraryObjectRef: "artifact.implementation_report",
          libraryVersionRef: "artifact.implementation_report@2",
        }],
      }),
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
    contractVersionRefs: [options.manifestArtifactContracts?.[0]?.libraryVersionRef ?? "artifact.implementation_report@2"],
    summary: "Build artifact",
    producedAt: "2026-07-10T00:00:00.000Z",
  });
  await replaceRequirementCoverage(
    db,
    runId,
    requirementCoverage(
      requirementIds,
      contractHash,
      options.coverageArtifactRefs,
      requirementIds.filter((requirementId) => !(options.nonBlockingRequirementIds ?? []).includes(requirementId)),
    ),
  );
  await seedEvaluatorAttempt(db, {
    runId,
    taskId: "task-verify",
    sessionId: "session-1",
    attemptId: "attempt-1",
    evaluatorPipelineRef: "software-verification-quality",
  });
  return { runId, producerArtifactRefId: producerArtifact.artifactRefId, goalContractHash: contractHash };
}

function requirementCoverage(
  requirementIds: string[],
  contractHash: string,
  artifactRefs = ["artifact.implementation_report"],
  blockingRequirementIds = requirementIds,
) {
  const blockingIds = new Set(blockingRequirementIds);
  return {
    schemaVersion: "southstar.goal_requirement_coverage.v1",
    goalContractHash: contractHash,
    entries: requirementIds.map((requirementId) => ({
      requirementId,
      producerTaskIds: ["task-build"],
      artifactRefs,
      artifactContractRefs: ["artifact.implementation_report"],
      evaluatorTaskIds: ["task-verify"],
      evaluatorProfileRefs: ["evaluator.software-verification-quality"],
      evaluatorProfileVersionRefs: ["evaluator.software-verification-quality@2"],
      validationBindingId: `binding-${requirementId}`,
      criterionBindings: [{
        criterionId: `criterion-${requirementId}`,
        criterionVersion: 1,
        blocking: blockingIds.has(requirementId),
        artifactContractRef: "artifact.implementation_report",
        artifactContractVersionRef: "artifact.implementation_report@2",
        evaluatorProfileRef: "evaluator.software-verification-quality",
        evaluatorProfileVersionRef: "evaluator.software-verification-quality@2",
        verificationMode: "deterministic",
        procedureRef: "procedure.test",
        expectedEvidenceKinds: ["artifact-ref", "command-output", "test-result"],
      }],
      criterionIds: [`criterion-${requirementId}`],
      acceptanceCriteria: [`${requirementId} is independently verified`],
      requiredEvidenceKinds: ["artifact-ref", "command-output", "test-result"],
    })),
  };
}

function legacyRequirementCoverage(
  requirementIds: string[],
  contractHash: string,
  artifactRefs = ["artifact.implementation_report"],
) {
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

async function upgradeRequirementCoverageToV2(
  db: SouthstarDb,
  runId: string,
  contractHash: string,
  requirementId: string,
): Promise<void> {
  const coverage = requirementCoverage([requirementId], contractHash);
  coverage.entries[0]!.requiredEvidenceKinds = ["artifact-ref"];
  await replaceRequirementCoverage(db, runId, coverage);
}

function requirementGoalContract(
  requirementIds: string[],
  nonBlockingIds: string[] = [],
  verificationMode: "deterministic" | "browser_interaction" = "deterministic",
): GoalContractV1 {
  const prompt = "Build and independently verify the requested feature";
  return {
    schemaVersion: "southstar.goal_contract.v2",
    originalPrompt: prompt,
    promptHash: createHash("sha256").update(prompt).digest("hex"),
    revision: 1,
    workspace: { cwd: "/workspace" },
    domain: "software",
    intent: "implement_feature",
    workType: "general",
    summary: "Build and verify the requested feature",
    requirements: requirementIds.map((id) => ({
      id,
      statement: `Satisfy ${id}`,
      acceptanceCriteria: [{
        id: `criterion-${id}`,
        version: 1,
        observableClaim: `${id} is independently verified`,
        blocking: !nonBlockingIds.includes(id),
        verificationIntent: ["Verify the accepted artifact with the independent evaluator."],
        requiredAssurance: [verificationMode],
      }],
      blocking: !nonBlockingIds.includes(id),
      source: "explicit",
      expectedArtifacts: [],
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
  const entries = (payload as { entries?: Array<ReturnType<typeof requirementCoverage>["entries"][number]> }).entries;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!Array.isArray(entry.criterionBindings) || entry.criterionBindings.length === 0) continue;
      entry.criterionBindings = entry.criterionBindings.map((binding) => ({
        ...binding,
        artifactContractRef: entry.artifactContractRefs?.[0] ?? binding.artifactContractRef,
        evaluatorProfileRef: entry.evaluatorProfileRefs[0] ?? binding.evaluatorProfileRef,
        evaluatorProfileVersionRef: entry.evaluatorProfileVersionRefs[0] ?? binding.evaluatorProfileVersionRef,
        expectedEvidenceKinds: [...entry.requiredEvidenceKinds],
      }));
    }
  }
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
  if (!Array.isArray(entries)) return;
  const grouped = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (
      !Array.isArray(entry.criterionIds)
      || entry.criterionIds.length === 0
      || entry.evaluatorProfileRefs.length !== 1
      || entry.evaluatorProfileVersionRefs.length !== 1
      || !entry.validationBindingId
    ) continue;
    const key = `${entry.evaluatorProfileRefs[0]}\u0000${entry.evaluatorProfileVersionRefs[0]}`;
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }
  if (grouped.size === 0) return;
  const evaluatorPipelines = [...grouped.values()].map((group) => {
    const profileRef = group[0]!.evaluatorProfileRefs[0]!;
    const profileVersionRef = group[0]!.evaluatorProfileVersionRefs[0]!;
    return {
      id: profileRef.replace(/^evaluator[.:]/, ""),
      libraryObjectRef: profileRef,
      libraryVersionRef: profileVersionRef,
      validationBindingIds: group.map((entry) => entry.validationBindingId!),
      evaluators: group.flatMap((entry) => entry.criterionBindings.map((criterionBinding, index) => ({
        id: `check-${criterionBinding.criterionId}`,
        kind: "checker-agent",
        required: criterionBinding.blocking,
        config: {
          validationBindingId: entry.validationBindingId,
          requirementId: entry.requirementId,
          criterionId: criterionBinding.criterionId,
          acceptanceCriterion: entry.acceptanceCriteria[index],
          expectedEvidenceKinds: criterionBinding.expectedEvidenceKinds,
          procedureRef: criterionBinding.procedureRef,
          verificationMode: criterionBinding.verificationMode,
        },
      }))),
      onFailure: { defaultStrategy: "request-workflow-revision" },
    };
  });
  await db.query(
    `update southstar.workflow_runs
        set workflow_manifest_json = workflow_manifest_json || $2::jsonb
      where id = $1`,
    [runId, JSON.stringify({ evaluatorPipelines })],
  );
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
        and (
          payload_json -> 'requirementIds' @> $2::jsonb
          or payload_json ->> 'requirementId' = $3
        )
      order by created_at desc, resource_key desc
      limit 1`,
    [runId, JSON.stringify([requirementId]), requirementId],
  );
  return row ? await getResourceByKeyPg(db, "requirement_evaluator_result", row.resource_key) : null;
}

function validVerifierCallback(fixture: { runId: string; producerArtifactRefId: string }): PostgresTaskRunCallbackResult {
  return verifierCallback({
    runId: fixture.runId,
    artifact: {
      kind: "verification_report",
      pass: true,
      commandsRun: [{ command: "npm test", status: "passed" }],
      testResults: [{ status: "passed" }],
      verifiedArtifactRefs: [fixture.producerArtifactRefId],
    },
  });
}

function verifierCallback(input: {
  runId: string;
  artifact: Record<string, unknown>;
  criterionIds?: string[];
  ok?: boolean;
  sessionId?: string;
  attemptId?: string;
  attempts?: number;
}): PostgresTaskRunCallbackResult {
  const artifact = withExplicitEvidenceRefs(input.artifact, input.runId);
  if (!Array.isArray(artifact.criteriaResults)) {
    const evidenceRefs = artifactEvidenceClaims(artifact, input.runId).map((claim) => claim.ref);
    const verdict = input.ok === false || artifact.pass === false ? "failed" : "passed";
    artifact.criteriaResults = (input.criterionIds ?? ["criterion-req-offline"]).map((criterionId) => ({
      criterionId,
      verdict,
      evidenceRefs,
      findings: [],
    }));
  }
  return {
    runId: input.runId,
    taskId: "task-verify",
    rootSessionId: input.sessionId ?? "session-1",
    ok: input.ok ?? true,
    attempts: input.attempts ?? 1,
    attemptId: input.attemptId ?? "attempt-1",
    artifact,
    metrics: {},
    events: [],
    receivedAt: "2026-07-10T00:05:00.000Z",
  };
}

function withExplicitEvidenceRefs(artifact: Record<string, unknown>, runId: string): Record<string, unknown> {
  const result = structuredClone(artifact);
  for (const [field, prefix] of [
    ["commandsRun", "command-output"],
    ["testResults", "test-result"],
    ["tests", "test-result"],
    ["filesChanged", "file-diff"],
    ["filesToInspect", "workspace-snapshot"],
    ["approvals", "human-approval"],
    ["policyDecisions", "policy-decision"],
  ] as const) {
    const values = result[field];
    if (!Array.isArray(values)) continue;
    result[field] = values.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const record = value as Record<string, unknown>;
      if (["evidenceRef", "artifactRef", "ref", "id", "resourceKey", "path", "url"]
        .some((key) => typeof record[key] === "string" && record[key] !== "")) return value;
      return { ...record, ref: `${prefix}:${runId}:${index}` };
    });
  }
  return result;
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

function callbackSemanticHash(callback: PostgresTaskRunCallbackResult): string {
  return createHash("sha256").update(stableStringify({
    runId: callback.runId,
    taskId: callback.taskId,
    rootSessionId: callback.rootSessionId,
    attemptId: callback.attemptId ?? `attempt-${callback.attempts}`,
    ok: callback.ok,
    attempts: callback.attempts,
    artifact: callback.artifact,
    events: callback.events,
    metrics: callback.metrics,
  })).digest("hex");
}

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const db = await createTestPostgresDb();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}
