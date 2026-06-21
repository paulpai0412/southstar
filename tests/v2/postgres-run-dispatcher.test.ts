import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { dispatchPostgresRunExecutionPg } from "../../src/v2/executor/postgres-run-dispatcher.ts";
import { getExecutorBindingPg, listExecutorBindingsForRunPg } from "../../src/v2/executor/postgres-bindings.ts";
import { listManagedBindingsForRunPg } from "../../src/v2/meta-harness/postgres-bindings.ts";
import { listHistoryForRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";

test("Postgres run dispatcher materializes envelopes, submits executor, and records bindings", async () => {
  await withDb(async (db) => {
    const runRoot = await mkdtemp(join(tmpdir(), "southstar-run-dispatcher-"));
    try {
      const draft = await createPostgresPlannerDraft(db, { goalPrompt: "implement bounded CLI evidence" });
      const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
      const submissions: unknown[] = [];

      const result = await dispatchPostgresRunExecutionPg(db, {
        runId: run.runId,
        runRoot,
        callbackUrl: "http://127.0.0.1/callback",
        heartbeatUrl: "http://127.0.0.1/heartbeat",
        harnessEndpoint: "http://127.0.0.1:7890/harness",
        contextRefreshUrl: "http://127.0.0.1:7890/context/refresh",
        executorProvider: {
          executorType: "tork",
          submit: async (request) => {
            submissions.push(request);
            return {
              executorType: "tork",
              externalJobId: "job-normal-run-pg",
              status: "queued",
              projectionFingerprint: "fingerprint-normal",
              executionProjection: { job: { tasks: request.workflow.tasks.map((task) => task.id) } },
            };
          },
        },
      });

      assert.equal(result.externalJobId, "job-normal-run-pg");
      assert.deepEqual(result.taskIds, run.taskIds);
      assert.equal(submissions.length, 1);
      const submitted = submissions[0] as {
        workflow: {
          tasks: Array<{
            id: string;
            execution: {
              env: Record<string, string>;
              mounts: Array<{ source: string; target: string; readonly: boolean }>;
            };
          }>;
        };
      };
      const understandTask = submitted.workflow.tasks.find((task) => task.id === "understand-repo");
      const understandMounts = understandTask?.execution.mounts ?? [];
      assert.equal(understandMounts.some((mount) => mount.source === runRoot && mount.target === "/southstar-runs" && mount.readonly), true);
      assert.equal(understandTask?.execution.env.SOUTHSTAR_HARNESS_ENDPOINT, "http://127.0.0.1:7890/harness");
      assert.equal(understandTask?.execution.env.PI_HARNESS_ENDPOINT, "http://127.0.0.1:7890/harness");
      assert.equal(understandTask?.execution.env.SOUTHSTAR_CONTEXT_REFRESH_URL, "http://127.0.0.1:7890/context/refresh");
      assert.equal(understandTask?.execution.env.SOUTHSTAR_MATERIALIZATION_ROOT, runRoot);
      assert.equal(result.materializedEnvelopePaths.length, run.taskIds.length);
      for (const envelopePath of result.materializedEnvelopePaths) assert.equal(existsSync(envelopePath), true);

      const runRow = await db.one<{ status: string; execution_projection_json: { externalJobId?: string } }>(
        "select status, execution_projection_json from southstar.workflow_runs where id = $1",
        [run.runId],
      );
      assert.equal(runRow.status, "running");
      assert.equal(runRow.execution_projection_json.externalJobId, "job-normal-run-pg");

      const taskRows = await db.query<{ id: string; status: string }>(
        "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order",
        [run.runId],
      );
      assert.equal(taskRows.rows.every((row) => row.status === "pending"), true);
      const understandTaskRow = await db.one<{ root_session_id: string | null }>(
        "select root_session_id from southstar.workflow_tasks where run_id = $1 and id = 'understand-repo'",
        [run.runId],
      );
      assert.equal(understandTaskRow.root_session_id, null);

      const bindings = await listExecutorBindingsForRunPg(db, run.runId);
      assert.equal(bindings.length, run.taskIds.length);
      const binding = await getExecutorBindingPg(db, `executor-${run.runId}-implement-feature-attempt-1`);
      assert.equal(binding?.payload.torkJobId, "job-normal-run-pg");
      assert.equal(binding?.status, "queued");

      const managedBindings = await listManagedBindingsForRunPg(db, run.runId);
      assert.deepEqual(managedBindings.brainBindings, []);
      assert.deepEqual(managedBindings.handBindings, []);

      const envelopeResources = await listResourcesPg(db, { resourceType: "task_envelope" });
      assert.equal(envelopeResources.filter((resource) => resource.runId === run.runId).length, run.taskIds.length);
      const understandEnvelope = envelopeResources.find((resource) => resource.runId === run.runId && resource.taskId === "understand-repo");
      assert.equal(understandEnvelope?.sessionId?.startsWith(`root-${run.runId}-understand-repo`), true);

      const history = await listHistoryForRunPg(db, run.runId);
      assert.equal(history.some((event) => event.eventType === "run.execution_submitted"), true);
      assert.equal(history.some((event) => event.eventType === "executor.submitted"), true);
      assert.equal(history.some((event) => event.eventType === "task.dispatch_submitted"), false);
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
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
