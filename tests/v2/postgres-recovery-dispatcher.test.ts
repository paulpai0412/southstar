import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { dispatchRecoveryExecutionPg } from "../../src/v2/session-recovery/postgres-dispatcher.ts";
import { listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { getExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";

test("Postgres recovery dispatcher checkpoints failed sessions, rebuilds envelopes, submits executor, and records bindings", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, { goalPrompt: "repair implementation" });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    await db.query("update southstar.workflow_tasks set status = 'failed' where run_id = $1 and id = 'implement-feature'", [run.runId]);

    const submissions: unknown[] = [];
    const result = await dispatchRecoveryExecutionPg(db, {
      runId: run.runId,
      failedTaskId: "implement-feature",
      plan: {
        strategy: "retry-same-agent",
        failedTaskId: "implement-feature",
        baseTaskId: "implement-feature",
        targetTaskIds: ["implement-feature"],
        attemptNumber: 2,
        requiresOperatorApproval: false,
        reason: "retry after evaluator failure",
        diagnostics: [],
      },
      executorProvider: {
        executorType: "tork",
        submit: async (request) => {
          submissions.push(request);
          return { executorType: "tork", externalJobId: "job-recovery-pg", status: "queued", executionProjection: { recovered: true } };
        },
      },
      callbackUrl: "http://127.0.0.1/callback",
      heartbeatUrl: "http://127.0.0.1/heartbeat",
    });

    assert.equal(result.recoveryExecutionId, `recovery-execution-${run.runId}-implement-feature-attempt-2`);
    assert.equal(result.externalJobId, "job-recovery-pg");
    assert.deepEqual(result.targetTaskIds, ["implement-feature"]);
    assert.equal(result.attemptId, "attempt-2");
    assert.equal(submissions.length, 1);

    const task = await db.one<{ status: string; root_session_id: string }>("select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = 'implement-feature'", [run.runId]);
    assert.equal(task.status, "running");
    assert.equal(task.root_session_id, `root-${run.runId}-implement-feature-recovery-2`);

    const binding = await getExecutorBindingPg(db, `executor-${run.runId}-implement-feature-attempt-2`);
    assert.equal(binding?.payload.torkJobId, "job-recovery-pg");
    assert.equal(binding?.status, "queued");

    const checkpoints = await listResourcesPg(db, { resourceType: "session_checkpoint" });
    assert.equal(checkpoints.length, 1);
    assert.equal((checkpoints[0]?.payload as { kind?: string; summaries?: { checkpointSummary?: string } }).kind, "before-recovery");
    assert.match((checkpoints[0]?.payload as { summaries?: { checkpointSummary?: string } }).summaries?.checkpointSummary ?? "", /retry after evaluator failure/);

    const envelopes = await listResourcesPg(db, { resourceType: "task_envelope" });
    assert.equal(envelopes.length, 1);
    assert.equal((envelopes[0]?.payload as { envelope?: { session?: { sessionId?: string } } }).envelope?.session?.sessionId, `root-${run.runId}-implement-feature-recovery-2`);

    const executions = await listResourcesPg(db, { resourceType: "recovery_execution" });
    assert.equal(executions.length, 1);
    assert.equal((executions[0]?.payload as { strategy?: string }).strategy, "retry-same-agent");

    const history = await listHistoryForRunPg(db, run.runId);
    assert.equal(history.some((event) => event.eventType === "checkpoint.created"), true);
    assert.equal(history.some((event) => event.eventType === "recovery.execution_submitted"), true);
    assert.equal(history.some((event) => event.eventType === "executor.submitted"), true);
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
