import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import {
  appendHistoryEventOncePg,
  appendHistoryEventPg,
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  getWorkflowRunPg,
  listHistoryForRunPg,
  listResourcesPg,
  updateWorkflowManifestPg,
  updateWorkflowRunStatusPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";

test("Postgres runtime store persists runs, tasks, resources, and ordered history", async () => {
  await withDb(async (db) => {
    await createWorkflowRunPg(db, minimalRun());
    await createWorkflowTaskPg(db, {
      id: "task-1",
      runId: "run-1",
      taskKey: "implement-feature",
      status: "pending",
      sortOrder: 1,
      dependsOn: [],
      snapshot: { status: "pending" },
      metrics: {},
    });

    const first = await appendHistoryEventPg(db, {
      runId: "run-1",
      taskId: "task-1",
      eventType: "task.created",
      actorType: "orchestrator",
      payload: { ok: true },
    });
    const second = await appendHistoryEventPg(db, {
      runId: "run-1",
      eventType: "run.updated",
      actorType: "orchestrator",
      payload: { status: "running" },
    });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.deepEqual((await listHistoryForRunPg(db, "run-1")).map((event) => event.eventType), ["task.created", "run.updated"]);

    const onceFirst = await appendHistoryEventOncePg(db, {
      runId: "run-1",
      taskId: "task-1",
      eventType: "memory.writeback_recorded",
      actorType: "memory-service",
      idempotencyKey: "run-1:task-1:writeback",
      payload: { ok: true },
    });
    const onceDuplicate = await appendHistoryEventOncePg(db, {
      runId: "run-1",
      taskId: "task-1",
      eventType: "memory.writeback_recorded",
      actorType: "memory-service",
      idempotencyKey: "run-1:task-1:writeback",
      payload: { ok: false },
    });
    assert.equal(onceFirst.sequence, 3);
    assert.equal(onceDuplicate.sequence, 3);
    assert.equal(onceDuplicate.duplicate, true);
    assert.equal((await listHistoryForRunPg(db, "run-1")).filter((event) => event.eventType === "memory.writeback_recorded").length, 1);

    await upsertRuntimeResourcePg(db, {
      resourceType: "context_packet",
      resourceKey: "ctx-1",
      runId: "run-1",
      taskId: "task-1",
      scope: "software",
      status: "created",
      payload: { selectedKnowledgeCards: [] },
      summary: { tokenEstimate: 1 },
    });
    const resource = await getResourceByKeyPg(db, "context_packet", "ctx-1");
    assert.equal(resource?.runId, "run-1");
    assert.deepEqual(resource?.payload, { selectedKnowledgeCards: [] });
    assert.equal((await listResourcesPg(db, { resourceType: "context_packet", scope: "software" })).length, 1);

    await updateWorkflowManifestPg(db, "run-1", JSON.stringify({ revision: "v2" }));
    await updateWorkflowRunStatusPg(db, "run-1", "completed");
    const run = await getWorkflowRunPg(db, "run-1");
    assert.equal(run?.workflowManifestJson, JSON.stringify({ revision: "v2" }));
    assert.equal(run?.status, "completed");
    assert.equal(typeof run?.completedAt, "string");
  });
});

function minimalRun() {
  return {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({ scope: "software" }),
    metricsJson: JSON.stringify({}),
  };
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
