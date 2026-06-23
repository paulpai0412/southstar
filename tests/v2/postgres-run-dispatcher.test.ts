import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { dispatchPostgresRunExecutionPg } from "../../src/v2/executor/postgres-run-dispatcher.ts";
import { listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";

test("legacy Postgres whole-run dispatcher fails closed without executor submission", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, { goalPrompt: "implement bounded CLI evidence" });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const submissions: unknown[] = [];

    await assert.rejects(
      () => dispatchPostgresRunExecutionPg(db, {
        runId: run.runId,
        callbackUrl: "http://127.0.0.1/callback",
        heartbeatUrl: "http://127.0.0.1/heartbeat",
        executorProvider: {
          executorType: "tork",
          submit: async (request) => {
            submissions.push(request);
            return {
              executorType: "tork",
              externalJobId: "job-legacy-should-not-submit",
              status: "queued",
              projectionFingerprint: "fingerprint-legacy",
              executionProjection: { job: { tasks: request.workflow.tasks.map((task) => task.id) } },
            };
          },
        },
      }),
      /whole-run dispatcher is removed; use run scheduling and RunnableTaskScheduler/,
    );

    assert.equal(submissions.length, 0);
    const runRow = await db.one<{ status: string; execution_projection_json: { externalJobId?: string } }>(
      "select status, execution_projection_json from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    assert.equal(runRow.status, "created");
    assert.equal(runRow.execution_projection_json.externalJobId, undefined);

    const envelopeResources = await listResourcesPg(db, { resourceType: "task_envelope" });
    assert.equal(envelopeResources.filter((resource) => resource.runId === run.runId).length, 0);
    const history = await listHistoryForRunPg(db, run.runId);
    assert.equal(history.some((event) => event.eventType === "run.execution_submitted"), false);
    assert.equal(history.some((event) => event.eventType === "executor.submitted"), false);
  });
});

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
