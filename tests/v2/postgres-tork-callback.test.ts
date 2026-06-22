import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createExecutorBindingPg, getExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../../src/v2/artifacts/types.ts";
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

      const artifactRefs = await listResourcesPg(db, { resourceType: ARTIFACT_REF_RESOURCE_TYPE });
      assert.equal(artifactRefs.length, 1);
      assert.equal(artifactRefs[0]?.taskId, "task-1");
      assert.equal(artifactRefs[0]?.status, "accepted");
      assert.equal((artifactRefs[0]?.payload as { artifactType?: string }).artifactType, "implementation_report");
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

async function seedRunTask(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "callback ingestion",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-callback", tasks: [{ id: taskId }] }),
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
