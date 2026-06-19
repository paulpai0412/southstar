import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createExecutorBindingPg, getExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";

test("Postgres Tork callback route ingests task result, artifacts, binding status, and audit history idempotently", async () => {
  await withDb(async (db) => {
    await seedRunTask(db);
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

      const artifacts = await listResourcesPg(db, { resourceType: "artifact" });
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0]?.resourceKey, "artifact-run-callback-pg-task-1-attempt-1");
      assert.equal((artifacts[0]?.payload as { kind?: string }).kind, "implementation_report");

      const history = await listHistoryForRunPg(db, "run-callback-pg");
      assert.deepEqual(history.map((event) => event.eventType), [
        "executor.submitted",
        "executor.callback_received",
        "session.entry",
        "artifact.created",
        "executor.callback_completed",
        "run.completed",
        "evolution.knowledge_cards_synthesized",
      ]);
      assert.equal(history.filter((event) => event.eventType === "executor.callback_received").length, 1);
    } finally {
      await server.close();
    }
  });
});

async function seedRunTask(db: SouthstarDb): Promise<void> {
  await createWorkflowRunPg(db, {
    id: "run-callback-pg",
    status: "running",
    domain: "software",
    goalPrompt: "callback ingestion",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-callback", tasks: [{ id: "task-1" }] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: "task-1",
    runId: "run-callback-pg",
    taskKey: "implement-feature",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-1",
  });
}

async function post(baseUrl: string, path: string, body: unknown): Promise<{ ok: true; kind: string; result: { accepted?: boolean; duplicate?: boolean } }> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; kind: string; result: { accepted?: boolean; duplicate?: boolean } } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope;
}

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await fixture.drop();
  }
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
