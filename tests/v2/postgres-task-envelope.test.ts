import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { getPostgresTaskEnvelope } from "../../src/v2/ui-api/postgres-task-envelope.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";

test("Postgres task envelope API builds TaskEnvelopeV2 from Postgres run, task, and context packet", async () => {
  await withDb(async (db) => {
    await seedKnowledgeCard(db);
    const draft = await createPostgresPlannerDraft(db, { goalPrompt: "implement calc sum" });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });

    const envelope = await getPostgresTaskEnvelope(db, { runId: run.runId, taskId: "implement-feature" });

    assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
    assert.equal(envelope.runId, run.runId);
    assert.equal(envelope.taskId, "implement-feature");
    assert.equal(envelope.role.id, "maker");
    assert.equal(envelope.agentProfile.id, "software-maker-pi");
    assert.equal(envelope.contextPacket.selectedKnowledgeCards[0]?.sourceRef, "card-envelope-self-check");
    assert.match(envelope.agentPrompt, /Knowledge Cards/);
    assert.match(envelope.agentPrompt, /commandsRun and risks/);
    assert.equal(envelope.artifactContracts.some((contract) => contract.id === "implementation_report"), true);
    assert.equal(envelope.evaluatorPipeline.id, "software-feature-quality");
  });
});

test("Postgres task envelope API returns the latest persisted task envelope before fallback building", async () => {
  await withDb(async (db) => {
    await seedKnowledgeCard(db);
    const draft = await createPostgresPlannerDraft(db, { goalPrompt: "implement calc sum" });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const fallbackEnvelope = await getPostgresTaskEnvelope(db, { runId: run.runId, taskId: "implement-feature" });
    const persistedEnvelope = {
      ...fallbackEnvelope,
      contextPacket: {
        ...fallbackEnvelope.contextPacket,
        id: "ctx-persisted-envelope",
      },
      session: {
        ...fallbackEnvelope.session,
        sessionId: "session-persisted-envelope",
      },
    };

    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "task-envelope-persisted",
      runId: run.runId,
      taskId: "implement-feature",
      sessionId: "session-persisted-envelope",
      scope: "task",
      status: "materialized",
      payload: { envelope: persistedEnvelope },
      summary: { contextPacketId: "ctx-persisted-envelope" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "task-envelope-legacy-metadata-only",
      runId: run.runId,
      taskId: "implement-feature",
      sessionId: "session-legacy",
      scope: "task",
      status: "materialized",
      payload: { envelopePath: "/tmp/legacy-envelope.json", taskDir: "/tmp/legacy-task", attemptId: "legacy-attempt" },
      summary: { contextPacketId: "ctx-legacy-metadata-only" },
    });

    const envelope = await getPostgresTaskEnvelope(db, { runId: run.runId, taskId: "implement-feature" });

    assert.equal(envelope.contextPacket.id, "ctx-persisted-envelope");
    assert.equal(envelope.session.sessionId, "session-persisted-envelope");
  });
});

test("Postgres server task envelope route uses new TaskEnvelope API", async () => {
  await withDb(async (db) => {
    await seedKnowledgeCard(db);
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const draft = await api<{ draftId: string }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "implement calc sum" }),
      });
      const run = await api<{ runId: string }>(server.url, "/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({ draftId: draft.draftId }),
      });
      const envelope = await api<{ schemaVersion: string; taskId: string; contextPacket: { selectedKnowledgeCards: Array<{ sourceRef: string }> } }>(
        server.url,
        `/api/v2/runs/${encodeURIComponent(run.runId)}/tasks/implement-feature/envelope`,
      );
      assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
      assert.equal(envelope.taskId, "implement-feature");
      assert.equal(envelope.contextPacket.selectedKnowledgeCards[0]?.sourceRef, "card-envelope-self-check");
    } finally {
      await server.close();
    }
  });
});

async function seedKnowledgeCard(db: SouthstarDb): Promise<void> {
  await createLearningNode(db, {
    id: "card-envelope-self-check",
    nodeType: "knowledge_card",
    scope: "software",
    status: "active",
    payload: {
      cardType: "failure_lesson",
      topicKey: "envelope-self-check",
      scope: "software",
      title: "Envelope self-check",
      summary: "Implementation reports should include commandsRun and risks.",
      appliesTo: { intents: ["implement_feature"], roles: ["maker"], artifactTypes: ["implementation-report"], agentProfiles: ["software-maker-pi"] },
      claims: [{ text: "Self-check reduces repair loops.", evidenceNodeRefs: ["card-envelope-self-check"] }],
      confidence: 0.9,
      successScore: 0.8,
      status: "active",
      riskTier: "low",
    },
    summaryText: "Implementation reports should include commandsRun and risks.",
  });
}

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
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
