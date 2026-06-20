import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";

test("new read-model run-inspection API uses Postgres runtime store", async () => {
  await withDb(async (db) => {
    await createWorkflowRunPg(db, {
      id: "run-inspect-pg-1",
      status: "completed",
      domain: "software",
      goalPrompt: "inspect postgres run",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", compiledFrom: { objectKey: "software.workflow.feature" } }),
      executionProjectionJson: JSON.stringify({ executor: "tork" }),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "task-1",
      runId: "run-inspect-pg-1",
      taskKey: "implement-feature",
      status: "completed",
      sortOrder: 1,
      dependsOn: [],
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact",
      resourceKey: "artifact-1",
      runId: "run-inspect-pg-1",
      taskId: "task-1",
      scope: "software",
      status: "accepted",
      payload: { artifactType: "implementation_report" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "evidence_packet",
      resourceKey: "evidence-1",
      runId: "run-inspect-pg-1",
      taskId: "task-1",
      scope: "software",
      status: "complete",
      payload: { evidence: [{ kind: "test-result" }] },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "validator_result",
      resourceKey: "validator-1",
      runId: "run-inspect-pg-1",
      taskId: "task-1",
      scope: "software",
      status: "passed",
      payload: { blocking: true },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "stop_condition_result",
      resourceKey: "stop-1",
      runId: "run-inspect-pg-1",
      scope: "software",
      status: "passed",
      payload: { ok: true },
    });

    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const model = await api<{ schemaVersion: string; kind: string; data: { runId: string; health: string; counts: { tasks: { completed: number } }; tasks: Array<{ taskId: string; artifact: { accepted: number } }> } }>(
        server.url,
        "/api/v2/read-models/run-inspection/run-inspect-pg-1",
      );
      assert.equal(model.schemaVersion, "southstar.read_model.run_inspection.v1");
      assert.equal(model.kind, "run-inspection");
      assert.equal(model.data.runId, "run-inspect-pg-1");
      assert.equal(model.data.health, "healthy");
      assert.equal(model.data.counts.tasks.completed, 1);
      assert.equal(model.data.tasks[0]?.artifact.accepted, 1);
    } finally {
      await server.close();
    }
  });
});

test("new read-model run-inspection API reports missing Postgres runs", async () => {
  await withDb(async (db) => {
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const model = await api<{ data: { runId: string; status: string; health: string; primaryCause: { code: string } } }>(
        server.url,
        "/api/v2/read-models/run-inspection/missing-run",
      );
      assert.equal(model.data.status, "missing");
      assert.equal(model.data.health, "unknown");
      assert.equal(model.data.primaryCause.code, "run_missing");
    } finally {
      await server.close();
    }
  });
});

async function api<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${text}`);
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
