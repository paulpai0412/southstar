import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningEdge, createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import {
  approveWikiLink,
  findOrphanKnowledgeCards,
  findStaleWikiLinks,
  getWikiPage,
  normalizeWikiAliases,
  openWikiConflict,
  resolveWikiConflict,
  rewireStaleWikiLinks,
  listBacklinks,
  listForwardLinks,
  proposeWikiLink,
  rejectWikiLink,
} from "../../src/v2/evolution/wiki.ts";

test("wiki page exposes forward links and backlinks from learning_edges", async () => {
  await withDb(async (db) => {
    const card = await createLearningNode(db, {
      nodeType: "knowledge_card",
      scope: "software",
      status: "active",
      payload: { topicKey: "artifact-self-check", title: "Artifact self-check", aliases: ["report checklist"] },
      summaryText: "Artifact self-check",
    });
    const failure = await createLearningNode(db, {
      nodeType: "failure_kind",
      scope: "software",
      status: "active",
      payload: { failureKind: "missing_required_field" },
      summaryText: "Missing required field",
    });

    const link = await proposeWikiLink(db, {
      fromNodeId: card.id,
      toNodeId: failure.id,
      relation: "supports",
      actor: "test-operator",
      reason: "Card claim cites repeated missing required field evidence.",
      confidence: 0.9,
      evidenceNodeRefs: [failure.id],
    });
    await approveWikiLink(db, { edgeId: link.edgeId, actor: "test-operator", reason: "Evidence node exists and relation is bounded." });

    const pageA = await getWikiPage(db, card.id);
    const pageB = await getWikiPage(db, failure.id);
    assert.equal(pageA.topicKey, "artifact-self-check");
    assert.deepEqual(pageA.aliases, ["report checklist"]);
    assert.equal(pageA.forwardLinks.some((item) => item.toNodeId === failure.id && item.relation === "supports" && item.status === "active"), true);
    assert.equal(pageB.backlinks.some((item) => item.fromNodeId === card.id && item.relation === "supports" && item.status === "active"), true);

    const forward = await listForwardLinks(db, card.id);
    const back = await listBacklinks(db, failure.id);
    assert.equal(forward.length, 1);
    assert.equal(back.length, 1);

    const dedicatedWikiTables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'southstar' and table_name like 'knowledge_wiki%'",
    );
    assert.deepEqual(dedicatedWikiTables.rows, []);
  });
});

test("wiki link moderation rejects links without deleting audit edge", async () => {
  await withDb(async (db) => {
    const a = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "a" }, summaryText: "A" });
    const b = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "b" }, summaryText: "B" });
    const link = await proposeWikiLink(db, {
      fromNodeId: a.id,
      toNodeId: b.id,
      relation: "related_topic",
      actor: "test-operator",
      reason: "Topics are adjacent but not proven enough.",
      confidence: 0.4,
      evidenceNodeRefs: [a.id],
    });
    await rejectWikiLink(db, { edgeId: link.edgeId, actor: "test-operator", reason: "Insufficient evidence." });

    const page = await getWikiPage(db, a.id);
    assert.equal(page.forwardLinks.some((item) => item.edgeId === link.edgeId && item.status === "rejected"), true);
  });
});

test("wiki validation rejects missing evidence, unknown nodes, raw transcripts, and secret payloads", async () => {
  await withDb(async (db) => {
    const a = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "a" }, summaryText: "A" });
    const b = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "b" }, summaryText: "B" });

    await assert.rejects(() => proposeWikiLink(db, {
      fromNodeId: a.id,
      toNodeId: "missing-node",
      relation: "supports",
      actor: "test-operator",
      reason: "target missing",
      confidence: 0.8,
      evidenceNodeRefs: [a.id],
    }), /target node not found/i);

    await assert.rejects(() => proposeWikiLink(db, {
      fromNodeId: a.id,
      toNodeId: b.id,
      relation: "supports",
      actor: "test-operator",
      reason: "missing evidence",
      confidence: 0.8,
      evidenceNodeRefs: [],
    }), /evidence/i);

    await assert.rejects(() => proposeWikiLink(db, {
      fromNodeId: a.id,
      toNodeId: b.id,
      relation: "supports",
      actor: "test-operator",
      reason: "raw transcript should be rejected",
      confidence: 0.8,
      evidenceNodeRefs: [a.id],
    }), /raw transcript/i);

    await assert.rejects(() => proposeWikiLink(db, {
      fromNodeId: a.id,
      toNodeId: b.id,
      relation: "supports",
      actor: "test-operator",
      reason: "secret ghp_abcdefghijklmnopqrstuvwxyz1234567890 should be rejected",
      confidence: 0.8,
      evidenceNodeRefs: [a.id],
    }), /secret/i);
  });
});

test("wiki maintenance normalizes aliases, rewires stale backlinks, and tracks conflict resolution", async () => {
  await withDb(async (db) => {
    const oldCard = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "superseded", payload: { topicKey: "Old Topic", aliases: [" Report Checklist ", "report-checklist", "REPORT checklist"] }, summaryText: "Old" });
    const newCard = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "new-topic", aliases: [] }, summaryText: "New" });
    const evidence = await createLearningNode(db, { nodeType: "failure_kind", scope: "software", status: "active", payload: { topicKey: "missing-field" }, summaryText: "Missing field" });
    const consumer = await createLearningNode(db, { nodeType: "run", scope: "software", status: "completed", payload: { title: "consumer" }, summaryText: "Consumer" });
    const staleLink = await createLearningEdge(db, { fromNodeId: consumer.id, edgeType: "SUPPORTED_BY", toNodeId: oldCard.id, evidence: { wikiRelation: "supports", status: "active", reason: "old card supported the run", evidenceNodeRefs: [evidence.id] } });
    await createLearningEdge(db, { fromNodeId: oldCard.id, edgeType: "SUPERSEDES", toNodeId: newCard.id, evidence: { wikiRelation: "supersedes", status: "active", reason: "new card replaces old" } });

    const aliases = await normalizeWikiAliases(db, { nodeId: oldCard.id, actor: "operator", reason: "dedupe aliases" });
    assert.deepEqual(aliases.aliases, ["report checklist"]);
    const rewired = await rewireStaleWikiLinks(db, { actor: "operator", reason: "rewire superseded backlinks" });
    assert.equal(rewired.rewiredEdges.length, 1);
    assert.equal(rewired.rewiredEdges[0]?.oldEdgeId, staleLink.id);
    assert.equal(rewired.rewiredEdges[0]?.toNodeId, newCard.id);

    const oldPage = await getWikiPage(db, oldCard.id);
    assert.equal(oldPage.backlinks.some((link) => link.edgeId === staleLink.id && link.status === "stale"), true);
    const newPage = await getWikiPage(db, newCard.id);
    assert.equal(newPage.backlinks.some((link) => link.fromNodeId === consumer.id && link.relation === "supports" && link.status === "active"), true);

    const conflict = await openWikiConflict(db, { fromNodeId: oldCard.id, toNodeId: newCard.id, actor: "operator", reason: "claims conflict during migration", evidenceNodeRefs: [evidence.id] });
    await resolveWikiConflict(db, { conflictId: conflict.conflictId, resolution: "superseded", actor: "operator", reason: "new card has stronger evidence" });
    const conflictResource = await db.one<{ status: string; payload_json: { resolution?: string } }>("select status, payload_json from southstar.runtime_resources where resource_key = $1", [conflict.conflictId]);
    assert.equal(conflictResource.status, "resolved");
    assert.equal(conflictResource.payload_json.resolution, "superseded");
  });
});

test("wiki maintenance finds orphan cards and stale links after supersession", async () => {
  await withDb(async (db) => {
    const orphan = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "orphan-topic" }, summaryText: "Orphan" });
    const oldCard = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "superseded", payload: { topicKey: "old-topic" }, summaryText: "Old" });
    const newCard = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "new-topic" }, summaryText: "New" });
    await createLearningEdge(db, { fromNodeId: oldCard.id, edgeType: "SUPERSEDES", toNodeId: newCard.id, evidence: { wikiRelation: "supersedes", status: "active", reason: "new card replaces old" } });

    const orphans = await findOrphanKnowledgeCards(db);
    assert.equal(orphans.some((item) => item.nodeId === orphan.id && item.topicKey === "orphan-topic"), true);

    const stale = await findStaleWikiLinks(db);
    assert.equal(stale.some((item) => item.reason.includes("superseded")), true);
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
