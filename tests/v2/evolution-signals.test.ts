import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { recordLearningSignal, recordLearningSignals } from "../../src/v2/evolution/signals.ts";

test("records structured learning signals as graph nodes and run history", async () => {
  await withDb(async (db) => {
    await seedRun(db, "run-signal-1");
    const result = await recordLearningSignal(db, {
      signalKind: "repair_success",
      scope: "software",
      runId: "run-signal-1",
      taskId: "implement-feature",
      roleRef: "maker",
      intent: "implement_feature",
      agentProfileRef: "software-maker-pi",
      artifactType: "implementation_report",
      failureKind: "missing_required_field",
      missingFields: ["commandsRun", "risks"],
      repairInstruction: "include commandsRun and risks",
      outcome: "passed_after_repair",
      sourceRefs: ["artifact-1", "eval-1"],
      confidence: 0.9,
      successScore: 1,
    });

    assert.match(result.nodeId, /^learning_signal-/);
    const node = await db.one<{ node_type: string; status: string; payload_jsonb: Record<string, unknown> }>(
      "select node_type, status, payload_jsonb from southstar.learning_nodes where id = $1",
      [result.nodeId],
    );
    assert.equal(node.node_type, "learning_signal");
    assert.equal(node.status, "recorded");
    assert.equal(node.payload_jsonb.signalKind, "repair_success");

    const history = await db.one<{ event_type: string; payload_json: { nodeId: string; signalKind: string } }>(
      "select event_type, payload_json from southstar.workflow_history where run_id = $1",
      ["run-signal-1"],
    );
    assert.equal(history.event_type, "evolution.learning_signal_recorded");
    assert.equal(history.payload_json.nodeId, result.nodeId);
    assert.equal(history.payload_json.signalKind, "repair_success");
  });
});

test("records multiple signals and redacts token-shaped payload values", async () => {
  await withDb(async (db) => {
    const result = await recordLearningSignals(db, {
      actor: "test-operator",
      reason: "batch capture repeated repair evidence",
      signals: [
        {
          signalKind: "evaluator_failure",
          scope: "software",
          artifactType: "implementation_report",
          failureKind: "missing_required_field",
          sourceRefs: ["eval-1"],
          confidence: 0.8,
          successScore: 0,
          secretLikeValue: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        },
        {
          signalKind: "repair_success",
          scope: "software",
          artifactType: "implementation_report",
          failureKind: "missing_required_field",
          sourceRefs: ["eval-2"],
          confidence: 0.9,
          successScore: 1,
        },
      ],
    });
    assert.equal(result.nodeIds.length, 2);
    const row = await db.one<{ payload_jsonb: Record<string, unknown> }>(
      "select payload_jsonb from southstar.learning_nodes where id = $1",
      [result.nodeIds[0]],
    );
    assert.equal(row.payload_jsonb.secretLikeValue, "[REDACTED]");
  });
});

test("rejects raw transcript and oversized learning signal payloads", async () => {
  await withDb(async (db) => {
    await assert.rejects(() => recordLearningSignal(db, {
      signalKind: "missing_scope",
      sourceRefs: ["evidence-1"],
      confidence: 0.5,
      successScore: 0.5,
    } as never), /scope is required/i);

    await assert.rejects(() => recordLearningSignal(db, {
      signalKind: "missing_confidence",
      scope: "software",
      sourceRefs: ["evidence-2"],
      successScore: 0.5,
    } as never), /confidence must be a number between 0 and 1/i);

    await assert.rejects(() => recordLearningSignal(db, {
      signalKind: "session_checkpoint",
      scope: "software",
      rawTranscript: "user: full transcript should not enter long-term learning memory",
      sourceRefs: ["checkpoint-1"],
      confidence: 0.5,
      successScore: 0,
    }), /raw transcript/i);

    await assert.rejects(() => recordLearningSignal(db, {
      signalKind: "artifact_summary",
      scope: "software",
      summary: "x".repeat(70_000),
      sourceRefs: ["artifact-big"],
      confidence: 0.5,
      successScore: 0,
    }), /too large/i);
  });
});

async function seedRun(db: SouthstarDb, runId: string): Promise<void> {
  await db.query(
    `insert into southstar.workflow_runs (
      id, status, domain, goal_prompt, workflow_manifest_json, execution_projection_json,
      snapshot_json, runtime_context_json, metrics_json, created_at, updated_at
    ) values ($1, 'running', 'software', 'goal', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
    [runId],
  );
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
