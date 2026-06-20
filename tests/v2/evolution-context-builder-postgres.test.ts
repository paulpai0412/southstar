import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { getWikiPage } from "../../src/v2/evolution/wiki.ts";
import { buildContextPacketWithKnowledgeCards } from "../../src/v2/context/postgres-builder.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";

test("Postgres ContextBuilder injects deterministic Knowledge Cards and persists card trace", async () => {
  await withDb(async (db) => {
    await seedRunAndTask(db, "run-builder-1", "implement-feature");
    await createLearningNode(db, {
      id: "card-builder-self-check",
      nodeType: "knowledge_card",
      scope: softwareDomainPack.id,
      status: "active",
      payload: {
        cardType: "failure_lesson",
        topicKey: "builder-self-check",
        scope: softwareDomainPack.id,
        title: "Builder self-check",
        summary: "Implementation reports should include commandsRun and risks.",
        appliesTo: { intents: ["implement_feature"], roles: ["maker"], artifactTypes: ["implementation-report"], agentProfiles: ["software-maker-pi"] },
        claims: [{ text: "Self-check reduces repair loops.", evidenceNodeRefs: ["card-builder-self-check"] }],
        confidence: 0.9,
        successScore: 0.8,
        status: "active",
        riskTier: "low",
      },
      summaryText: "Implementation reports should include commandsRun and risks.",
    });

    const packet = await buildContextPacketWithKnowledgeCards(db, {
      runId: "run-builder-1",
      taskId: "implement-feature",
      rootSessionId: "root-builder-1",
      goalPrompt: "implement feature and return implementation_report",
      domainPack: softwareDomainPack,
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      artifactContractRefs: ["implementation_report"],
      priorArtifactRefs: [],
      checkpointRef: "checkpoint-builder-1",
      checkpointSummary: "Recovered from checkpoint.",
      intent: "implement_feature",
      flowTemplateRef: "software.workflow.feature-implementation",
    });

    assert.equal(packet.selectedKnowledgeCards.length, 1);
    assert.equal(packet.selectedKnowledgeCards[0]?.sourceRef, "card-builder-self-check");
    assert.equal(packet.selectedMemories.length, 0);
    assert.equal(packet.tokenEstimate.bySourceType.knowledge_card > 0, true);
    assert.deepEqual(packet.managedSourceRefs?.checkpointRefs, ["checkpoint-builder-1"]);

    const trace = await db.one<{ payload_json: { selectedCardRefs: string[] } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'knowledge_card_injection_trace'",
    );
    assert.deepEqual(trace.payload_json.selectedCardRefs, ["card-builder-self-check"]);

    const wiki = await getWikiPage(db, "card-builder-self-check");
    assert.equal(wiki.runtimeUsageLinks.some((link) => link.fromNodeId === packet.id), true);
    const persistedContext = await db.one<{ payload_json: { managedSourceRefs?: { checkpointRefs?: string[] } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'context_packet' and resource_key = $1",
      [packet.id],
    );
    assert.deepEqual(persistedContext.payload_json.managedSourceRefs?.checkpointRefs, ["checkpoint-builder-1"]);
  });
});

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
