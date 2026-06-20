import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { getWikiPage } from "../../src/v2/evolution/wiki.ts";
import { persistKnowledgeCardInjectionTrace, selectKnowledgeCardsForTask } from "../../src/v2/evolution/context-cards.ts";

test("selects active Knowledge Cards deterministically from typed task metadata", async () => {
  await withDb(async (db) => {
    const first = await seedCard(db, {
      id: "card-implementation-report-self-check",
      topicKey: "implementation-report-self-check",
      status: "active",
      confidence: 0.86,
      successScore: 0.81,
      summary: "Implementation agents should include commandsRun and risks self-checks.",
      appliesTo: {
        intents: ["implement_feature"],
        roles: ["maker"],
        artifactTypes: ["implementation_report"],
        agentProfiles: ["software-maker-pi"],
      },
    });
    const second = await seedCard(db, {
      id: "card-maker-minimal-change",
      topicKey: "maker-minimal-change",
      status: "active",
      confidence: 0.75,
      successScore: 0.7,
      summary: "Maker tasks should keep patches minimal and test-backed.",
      appliesTo: {
        intents: ["implement_feature"],
        roles: ["maker"],
      },
    });
    await seedCard(db, {
      id: "card-superseded",
      topicKey: "old-card",
      status: "superseded",
      confidence: 1,
      successScore: 1,
      summary: "Superseded cards must not inject.",
      appliesTo: { intents: ["implement_feature"], roles: ["maker"] },
    });
    await seedCard(db, {
      id: "card-do-not-inject",
      topicKey: "blocked-card",
      status: "do_not_inject",
      confidence: 1,
      successScore: 1,
      summary: "Do-not-inject cards must not inject.",
      appliesTo: { intents: ["implement_feature"], roles: ["maker"] },
    });

    const selection = await selectKnowledgeCardsForTask(db, {
      scope: "software",
      intent: "implement_feature",
      roleRef: "maker",
      artifactTypes: ["implementation_report"],
      agentProfileRef: "software-maker-pi",
      promptTemplateRef: "software-maker-pi",
      skillRefs: ["software.minimal-patch"],
      flowTemplateRef: "software.workflow.feature-implementation",
      maxCards: 5,
    });

    assert.deepEqual(selection.selectedCardRefs, [first.id, second.id]);
    assert.equal(selection.selectedCards[0]?.sourceType, "knowledge_card");
    assert.match(selection.selectedCards[0]?.text ?? "", /commandsRun and risks/);
    assert.equal(selection.excludedCards.some((item) => item.cardRef === "card-superseded" && item.reason === "status-superseded"), true);
    assert.equal(selection.excludedCards.some((item) => item.cardRef === "card-do-not-inject" && item.reason === "status-do_not_inject"), true);

    const repeated = await selectKnowledgeCardsForTask(db, {
      scope: "software",
      intent: "implement_feature",
      roleRef: "maker",
      artifactTypes: ["implementation_report"],
      agentProfileRef: "software-maker-pi",
      promptTemplateRef: "software-maker-pi",
      skillRefs: ["software.minimal-patch"],
      flowTemplateRef: "software.workflow.feature-implementation",
      maxCards: 5,
    });
    assert.deepEqual(repeated.selectedCardRefs, selection.selectedCardRefs);
  });
});

test("persists Knowledge Card injection trace and runtime usage backlinks", async () => {
  await withDb(async (db) => {
    await seedRunAndTask(db, "run-context-1", "implement-feature");
    const card = await seedCard(db, {
      id: "card-runtime-usage",
      topicKey: "runtime-usage",
      status: "active",
      confidence: 0.9,
      successScore: 0.8,
      summary: "Injected card should create runtime usage backlink.",
      appliesTo: { intents: ["implement_feature"], roles: ["maker"] },
    });
    const selection = await selectKnowledgeCardsForTask(db, {
      scope: "software",
      intent: "implement_feature",
      roleRef: "maker",
      artifactTypes: ["implementation_report"],
      agentProfileRef: "software-maker-pi",
      promptTemplateRef: "software-maker-pi",
      skillRefs: [],
      flowTemplateRef: "software.workflow.feature-implementation",
      maxCards: 3,
    });

    const trace = await persistKnowledgeCardInjectionTrace(db, {
      contextPacketId: "ctx-run-context-1-implement-feature-attempt-1",
      runId: "run-context-1",
      taskId: "implement-feature",
      sessionId: "root-session-1",
      scope: "software",
      matchedTaskMetadata: selection.matchedTaskMetadata,
      selectedCards: selection.selectedCards,
      selectedCardRefs: selection.selectedCardRefs,
      excludedCards: selection.excludedCards,
      tokenEstimate: selection.tokenEstimate,
    });
    assert.match(trace.traceId, /^card-trace-/);

    const resource = await db.one<{ resource_type: string; payload_json: Record<string, unknown> }>(
      "select resource_type, payload_json from southstar.runtime_resources where resource_key = $1",
      [trace.traceId],
    );
    assert.equal(resource.resource_type, "knowledge_card_injection_trace");
    assert.deepEqual(resource.payload_json.selectedCardRefs, [card.id]);

    const wiki = await getWikiPage(db, card.id);
    assert.equal(wiki.runtimeUsageLinks.some((link) => link.fromNodeId === "ctx-run-context-1-implement-feature-attempt-1" && link.toNodeId === card.id), true);
  });
});

async function seedCard(db: SouthstarDb, input: {
  id: string;
  topicKey: string;
  status: string;
  confidence: number;
  successScore: number;
  summary: string;
  appliesTo: Record<string, string[]>;
}): Promise<{ id: string }> {
  return await createLearningNode(db, {
    id: input.id,
    nodeType: "knowledge_card",
    scope: "software",
    status: input.status,
    payload: {
      cardType: "failure_lesson",
      topicKey: input.topicKey,
      scope: "software",
      title: input.topicKey,
      summary: input.summary,
      appliesTo: input.appliesTo,
      claims: [{ text: input.summary, evidenceNodeRefs: [input.id] }],
      confidence: input.confidence,
      successScore: input.successScore,
      status: input.status,
      riskTier: "low",
    },
    summaryText: input.summary,
  });
}

async function seedRunAndTask(db: SouthstarDb, runId: string, taskId: string): Promise<void> {
  await db.query(
    `insert into southstar.workflow_runs (
      id, status, domain, goal_prompt, workflow_manifest_json, execution_projection_json,
      snapshot_json, runtime_context_json, metrics_json, created_at, updated_at
    ) values ($1, 'running', 'software', 'goal', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
    [runId],
  );
  await db.query(
    `insert into southstar.workflow_tasks (
      id, run_id, task_key, status, sort_order, depends_on_json, subagent_session_ids_json,
      snapshot_json, metrics_json, created_at, updated_at
    ) values ($1, $2, $1, 'running', 1, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
    [taskId, runId],
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
