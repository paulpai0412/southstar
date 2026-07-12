import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  createExecutorBindingPg,
  getExecutorBindingPg,
  listExecutorBindingsForRunPg,
  updateExecutorBindingStatusPg,
} from "../../src/v2/executor/postgres-bindings.ts";

test("Postgres executor binding store persists bindings, status updates, and audit history", async () => {
  await withDb(async (db) => {
    await seedRunTask(db);
    const submittedAt = "2026-06-19T10:00:00.000Z";

    const created = await createExecutorBindingPg(db, {
      runId: "run-bindings-pg",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-1",
      torkTaskId: "tork-task-1",
      status: "queued",
      now: submittedAt,
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });

    assert.equal(created.id, "executor-run-bindings-pg-task-1-attempt-1");
    assert.equal(created.payload.queueTimeoutAt, "2026-06-19T10:01:00.000Z");
    assert.equal(created.payload.hardTimeoutAt, "2026-06-19T10:10:00.000Z");

    const loaded = await getExecutorBindingPg(db, created.id);
    assert.equal(loaded?.payload.torkJobId, "job-1");
    assert.equal(loaded?.status, "queued");

    const updated = await updateExecutorBindingStatusPg(db, {
      bindingId: created.id,
      status: "running",
      eventType: "executor.running",
      payloadPatch: { torkObservedStatus: "RUNNING", lastReconcileAt: "2026-06-19T10:00:30.000Z" },
      eventPayload: { observed: true },
    });

    assert.equal(updated.status, "running");
    assert.equal(updated.payload.southstarExecutorStatus, "running");
    assert.equal(updated.payload.torkObservedStatus, "RUNNING");

    const bindings = await listExecutorBindingsForRunPg(db, "run-bindings-pg");
    assert.deepEqual(bindings.map((binding) => binding.id), [created.id]);
    assert.deepEqual(bindings.map((binding) => binding.status), ["running"]);

    const history = await listHistoryForRunPg(db, "run-bindings-pg");
    assert.deepEqual(history.map((event) => event.eventType), ["executor.submitted", "executor.running"]);
    assert.equal(history[0]?.idempotencyKey, "executor-binding:run-bindings-pg:task-1:attempt-1");
  });
});

test("executor binding updates lock the run first and ignore heartbeat downgrades after terminal callback state", async () => {
  const source = readFileSync(new URL("../../src/v2/executor/postgres-bindings.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function updateExecutorBindingStatusPg");
  const end = source.indexOf("\nfunction toRecord", start);
  const helper = source.slice(start, end);
  const runLock = helper.indexOf("southstar.workflow_runs");
  const bindingLock = helper.indexOf("resource_type = 'executor_binding'");
  assert.ok(runLock >= 0 && bindingLock >= 0 && runLock < bindingLock);

  await withDb(async (db) => {
    await seedRunTask(db);
    const binding = await createExecutorBindingPg(db, {
      runId: "run-bindings-pg",
      taskId: "task-1",
      attemptId: "attempt-1",
      torkJobId: "job-1",
      status: "completed",
      now: "2026-06-19T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });

    const updated = await updateExecutorBindingStatusPg(db, {
      bindingId: binding.id,
      status: "running",
      eventType: "executor.heartbeat",
      payloadPatch: { lastHeartbeatAt: "2026-06-19T10:00:30.000Z", heartbeatSeq: 2 },
    });

    assert.equal(updated.status, "completed");
    assert.equal(updated.payload.lastHeartbeatAt, undefined);
    assert.deepEqual((await listHistoryForRunPg(db, "run-bindings-pg")).map((event) => event.eventType), ["executor.submitted"]);
  });
});

test("executor binding update fails closed when the locked binding moved after the observed run lock", async () => {
  await withDb(async (db) => {
    await seedRunTask(db);
    const binding = await createExecutorBindingPg(db, {
      runId: "run-bindings-pg",
      taskId: "task-1",
      attemptId: "attempt-race",
      torkJobId: "job-race",
      status: "running",
      now: "2026-06-19T10:00:00.000Z",
      queueTimeoutSeconds: 60,
      hardTimeoutSeconds: 600,
    });
    const historyBefore = await listHistoryForRunPg(db, "run-bindings-pg");

    await assert.rejects(
      () => updateExecutorBindingStatusPg(withBindingRunRace(db, binding.id, "run-moved"), {
        bindingId: binding.id,
        status: "completed",
        eventType: "executor.callback_completed",
      }),
      /changed run while acquiring locks/,
    );

    assert.equal((await getExecutorBindingPg(db, binding.id))?.status, "running");
    assert.deepEqual(await listHistoryForRunPg(db, "run-bindings-pg"), historyBefore);
  });
});

async function seedRunTask(db: SouthstarDb): Promise<void> {
  await createWorkflowRunPg(db, {
    id: "run-bindings-pg",
    status: "running",
    domain: "software",
    goalPrompt: "executor bindings",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-bindings", tasks: [] }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: "task-1",
    runId: "run-bindings-pg",
    taskKey: "implement-feature",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
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

function withBindingRunRace(db: SouthstarDb, bindingId: string, movedRunId: string): SouthstarDb {
  return {
    query: db.query.bind(db),
    one: db.one.bind(db),
    maybeOne: db.maybeOne.bind(db),
    tx: async (run) => await db.tx(async (tx) => {
      let bindingReads = 0;
      const racedTx: SouthstarDb = {
        query: tx.query.bind(tx),
        one: tx.one.bind(tx),
        maybeOne: async <T>(sql: string, params?: unknown[]) => {
          const row = await tx.maybeOne<T>(sql, params);
          if (
            row
            && sql.includes("from southstar.runtime_resources")
            && params?.[0] === "executor_binding"
            && params?.[1] === bindingId
            && ++bindingReads === 2
          ) return { ...(row as object), run_id: movedRunId } as T;
          return row;
        },
        tx: tx.tx.bind(tx),
        close: async () => {},
      };
      return await run(racedTx);
    }),
    close: async () => {},
  };
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
