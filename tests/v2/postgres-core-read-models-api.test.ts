import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg, appendHistoryEventPg } from "../../src/v2/stores/postgres-runtime-store.ts";

const runId = "run-core-read-models";

test("Postgres read-model API exposes workflow canvas, runtime monitor, executor ops, task detail, sessions memory, and vault MCP", async () => {
  await withDb(async (db) => {
    await seedRuntime(db);
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const canvas = await readModel<{ data: { runId: string; nodes: Array<{ id: string; status: string }> } }>(server.url, "workflow-canvas", runId);
      assert.equal(canvas.data.runId, runId);
      assert.deepEqual(canvas.data.nodes.map((node) => node.id), ["task-1"]);

      const monitor = await readModel<{ data: { runtime: { status: string; latestProgress?: string; executorJobIds: string[]; runningTaskIds: string[] } } }>(server.url, "runtime-monitor", runId);
      assert.equal(monitor.data.runtime.status, "running");
      assert.equal(monitor.data.runtime.latestProgress, "agent working");
      assert.deepEqual(monitor.data.runtime.executorJobIds, ["job-1"]);
      assert.deepEqual(monitor.data.runtime.runningTaskIds, ["task-1"]);

      const executor = await readModel<{ data: { bindings: Array<{ id: string; status: string; externalJobId?: string }> } }>(server.url, "executor-ops", runId);
      assert.equal(executor.data.bindings[0]?.externalJobId, "job-1");

      const detail = await readModel<{ data: { taskId: string; taskKey: string; contextPacket?: { id: string } } }>(server.url, "task-detail", runId, "task-1");
      assert.equal(detail.data.taskId, "task-1");
      assert.equal(detail.data.taskKey, "implement-feature");
      assert.equal(detail.data.contextPacket?.id, "ctx-1");

      const sessions = await readModel<{ data: { sessions: unknown[]; memory: unknown[] } }>(server.url, "sessions-memory", runId);
      assert.equal(sessions.data.sessions.length, 1);
      assert.equal(sessions.data.memory.length, 1);

      const vault = await readModel<{ data: { vaultLeases: unknown[]; mcpGrants: unknown[] } }>(server.url, "vault-mcp", runId);
      assert.equal(vault.data.vaultLeases.length, 1);
      assert.equal(vault.data.mcpGrants.length, 1);
    } finally {
      await server.close();
    }
  });
});

async function seedRuntime(db: SouthstarDb): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "inspect core read models",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-core", tasks: [] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: "task-1",
    runId,
    taskKey: "implement-feature",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
  await appendHistoryEventPg(db, { runId, taskId: "task-1", eventType: "progress.commentary", actorType: "agent", payload: { message: "agent working" } });
  await upsertRuntimeResourcePg(db, { resourceType: "executor_binding", resourceKey: "binding-1", runId, taskId: "task-1", scope: "executor", status: "running", payload: { executorType: "tork", externalJobId: "job-1" } });
  await upsertRuntimeResourcePg(db, { resourceType: "context_packet", resourceKey: "ctx-1", runId, taskId: "task-1", scope: "software", status: "created", payload: { id: "ctx-1", selectedKnowledgeCards: [] } });
  await upsertRuntimeResourcePg(db, { resourceType: "session", resourceKey: "session-1", runId, taskId: "task-1", sessionId: "session-1", scope: "task", status: "active", payload: { summary: "root" } });
  await upsertRuntimeResourcePg(db, { resourceType: "memory_item", resourceKey: "memory-1", runId, scope: "software", status: "approved", payload: { preference: "minimal" } });
  await upsertRuntimeResourcePg(db, { resourceType: "vault_lease", resourceKey: "lease-1", runId, taskId: "task-1", scope: "task", status: "active", payload: { secretRef: "github-token" } });
  await upsertRuntimeResourcePg(db, { resourceType: "mcp_grant", resourceKey: "mcp-1", runId, taskId: "task-1", scope: "task", status: "active", payload: { serverId: "github" } });
}

async function readModel<T>(baseUrl: string, kind: string, runId: string, taskId?: string): Promise<T> {
  const path = `/api/v2/read-models/${encodeURIComponent(kind)}/${encodeURIComponent(runId)}${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
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
