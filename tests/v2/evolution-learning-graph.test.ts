import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import {
  createLearningEdge,
  createLearningNode,
  getEvidenceSubgraph,
  getImpactGraph,
  getKnowledgeCardEvidence,
  getLineage,
} from "../../src/v2/evolution/learning-graph.ts";

test("learning graph persists nodes and typed edges in Postgres", async () => {
  await withDb(async (db) => {
    const evidence = await createLearningNode(db, {
      id: "eval-node-1",
      nodeType: "evaluator_result",
      scope: "software",
      status: "accepted",
      runId: "run-1",
      taskId: "task-1",
      payload: { ok: true },
      summaryText: "Evaluator accepted implementation report",
    });
    const card = await createLearningNode(db, {
      id: "card-node-1",
      nodeType: "knowledge_card",
      scope: "software",
      status: "active",
      payload: { topicKey: "implementation-report-self-check" },
      summaryText: "Implementation report self-check",
    });
    const edge = await createLearningEdge(db, {
      fromNodeId: card.id,
      edgeType: "SUPPORTED_BY",
      toNodeId: evidence.id,
      weight: 0.9,
      evidence: { reason: "card cites evaluator evidence" },
    });

    assert.match(edge.id, /.+/);
    const row = await db.one<{ edge_type: string; weight: number; evidence_jsonb: { reason: string } }>(
      "select edge_type, weight, evidence_jsonb from southstar.learning_edges where id = $1",
      [edge.id],
    );
    assert.equal(row.edge_type, "SUPPORTED_BY");
    assert.equal(row.weight, 0.9);
    assert.equal(row.evidence_jsonb.reason, "card cites evaluator evidence");
  });
});

test("graph read models expose bounded evidence, lineage, and impact neighborhoods", async () => {
  await withDb(async (db) => {
    const artifact = await createLearningNode(db, { nodeType: "artifact", scope: "software", status: "accepted", payload: { artifactType: "implementation_report" }, summaryText: "Implementation artifact" });
    const evalResult = await createLearningNode(db, { nodeType: "evaluator_result", scope: "software", status: "accepted", payload: { ok: true }, summaryText: "Evaluator result" });
    const card = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "self-check" }, summaryText: "Self-check card" });
    const delta = await createLearningNode(db, { nodeType: "delta_proposal", scope: "software", status: "promoted", payload: { deltaKind: "prompt_delta" }, summaryText: "Prompt delta" });
    const asset = await createLearningNode(db, { nodeType: "prompt_version", scope: "software", status: "active", payload: { version: "v2" }, summaryText: "Prompt v2" });

    await createLearningEdge(db, { fromNodeId: evalResult.id, edgeType: "EVALUATED_BY", toNodeId: artifact.id, evidence: { relation: "evaluated artifact" } });
    await createLearningEdge(db, { fromNodeId: card.id, edgeType: "SUPPORTED_BY", toNodeId: evalResult.id, evidence: { relation: "cited evaluator" } });
    await createLearningEdge(db, { fromNodeId: delta.id, edgeType: "BASED_ON", toNodeId: card.id, evidence: { relation: "generated from card" } });
    await createLearningEdge(db, { fromNodeId: delta.id, edgeType: "PROMOTED_TO", toNodeId: asset.id, evidence: { relation: "promoted asset" } });

    const evidence = await getKnowledgeCardEvidence(db, card.id);
    assert.equal(evidence.centerNodeId, card.id);
    assert.equal(evidence.nodes.some((node) => node.id === evalResult.id && node.type === "evaluator_result"), true);
    assert.equal(evidence.edges.some((edge) => edge.type === "SUPPORTED_BY"), true);

    const lineage = await getLineage(db, asset.id);
    assert.equal(lineage.nodes.some((node) => node.id === delta.id), true);
    assert.equal(lineage.nodes.some((node) => node.id === card.id), true);

    const impact = await getImpactGraph(db, card.id);
    assert.equal(impact.nodes.some((node) => node.id === delta.id), true);
    assert.equal(impact.nodes.some((node) => node.id === asset.id), true);

    const subgraph = await getEvidenceSubgraph(db, card.id, 2);
    assert.equal(subgraph.nodes.length <= 200, true);
    assert.equal(subgraph.edges.every((edge) => ["SUPPORTED_BY", "BASED_ON", "PROMOTED_TO", "EVALUATED_BY"].includes(edge.type)), true);
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
