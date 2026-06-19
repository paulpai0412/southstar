import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createExecutorBindingPg, getExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";

test("Postgres executor reconcile route classifies executor drift and records findings", async () => {
  await withDb(async (db) => {
    await seedRunTask(db);
    const binding = await createExecutorBindingPg(db, {
      runId: "run-reconcile-pg",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-orphan",
      status: "running",
      now: "2026-06-19T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });
    await db.query("update southstar.workflow_tasks set status = 'completed' where run_id = 'run-reconcile-pg' and id = 'task-1'");

    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      torkObservationClient: {
        capabilities: () => ({ supportsJobInspect: true, supportsTaskInspect: false, supportsJobCancel: true, supportsTaskCancel: false, supportsJobLogs: true, supportsTaskLogs: false, supportsWorkerHealth: false }),
        getJob: async (jobId: string) => ({ jobId, status: "RUNNING" }),
        getJobLogs: async () => "token=secret-value\nworker still running",
        cancelJob: async () => {},
      },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const result = await post<{ findings: Array<{ bindingId: string; classification: string; actions: string[] }> }>(server.url, "/api/v2/executor/reconcile", {});
      assert.deepEqual(result.findings, [{ bindingId: binding.id, runId: "run-reconcile-pg", taskId: "task-1", classification: "orphaned", actions: ["cancel-executor", "alert-operator"] }]);

      const updated = await getExecutorBindingPg(db, binding.id);
      assert.equal(updated?.status, "orphaned");
      assert.equal(updated?.payload.torkObservedStatus, "RUNNING");
      assert.equal(updated?.payload.reconcileGeneration, 1);

      const reconcileResources = await listResourcesPg(db, { resourceType: "executor_reconcile_result" });
      assert.equal(reconcileResources.length, 1);
      assert.equal((reconcileResources[0]?.payload as { classification?: string }).classification, "orphaned");
      const logs = await listResourcesPg(db, { resourceType: "executor_log_ref" });
      assert.equal((logs[0]?.payload as { summary?: string }).summary?.includes("token=<redacted>"), true);

      const history = await listHistoryForRunPg(db, "run-reconcile-pg");
      assert.equal(history.some((event) => event.eventType === "executor.orphaned"), true);
      assert.equal(history.some((event) => event.eventType === "executor.reconcile_completed"), true);
    } finally {
      await server.close();
    }
  });
});

async function seedRunTask(db: SouthstarDb): Promise<void> {
  await createWorkflowRunPg(db, {
    id: "run-reconcile-pg",
    status: "running",
    domain: "software",
    goalPrompt: "executor reconcile",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-reconcile", tasks: [{ id: "task-1" }] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: "task-1",
    runId: "run-reconcile-pg",
    taskKey: "implement-feature",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
}

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
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
