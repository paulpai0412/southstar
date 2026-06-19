import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createLearningEdge, createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { createAssetVersion } from "../../src/v2/evolution/assets.ts";
import { recordAssetRegressionObservation, runRegressionMonitor } from "../../src/v2/evolution/regression-monitor.ts";

test("Evolution HTTP API records signals, synthesizes cards, exposes wiki links, and creates deltas", async () => {
  await withDb(async (db) => {
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used by evolution API test"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by evolution API test"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const overviewBefore = await api<{ data: { health: { status: string } } }>(server.url, "/api/v2/read-models/evolution-control-center/_global");
      assert.equal(overviewBefore.data.health.status, "ready");

      const signals = await api<{ nodeIds: string[] }>(server.url, "/api/v2/evolution/signals", {
        method: "POST",
        body: JSON.stringify({
          actor: "test-operator",
          reason: "API records repeated repair signals",
          signals: [repairSignal("run-api-1", "eval-api-1"), repairSignal("run-api-2", "eval-api-2")],
        }),
      });
      assert.equal(signals.nodeIds.length, 2);

      const cards = await api<{ cardIds: string[] }>(server.url, "/api/v2/evolution/cards/synthesize", {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "API synthesizes repeated signals" }),
      });
      assert.equal(cards.cardIds.length, 1);

      const cardList = await api<Array<{ id: string; status: string }>>(server.url, "/api/v2/evolution/cards");
      assert.equal(cardList.some((card) => card.id === cards.cardIds[0] && card.status === "active"), true);

      const wiki = await api<{ nodeId: string; evidenceLinks: unknown[] }>(server.url, `/api/v2/evolution/wiki/${encodeURIComponent(cards.cardIds[0]!)}`);
      assert.equal(wiki.nodeId, cards.cardIds[0]);
      assert.equal(wiki.evidenceLinks.length >= 1, true);

      await api<{ assetId: string }>(server.url, "/api/v2/evolution/assets/register", {
        method: "POST",
        body: JSON.stringify({
          actor: "test-operator",
          reason: "register prompt target for delta validation",
          assetKind: "prompt_template",
          assetRef: "prompt-software-maker",
          version: "v1",
          status: "active",
          payload: { sections: ["baseline"] },
        }),
      });
      const delta = await api<{ deltaIds: string[] }>(server.url, "/api/v2/evolution/deltas/synthesize", {
        method: "POST",
        body: JSON.stringify({
          actor: "test-operator",
          reason: "API creates prompt delta from active card",
          sourceCardRefs: cards.cardIds,
          targetRef: "prompt-software-maker",
          targetVersion: "v1",
        }),
      });
      assert.equal(delta.deltaIds.length, 1);

      const approved = await api<{ deltaId: string; status: string }>(
        server.url,
        `/api/v2/evolution/deltas/${encodeURIComponent(delta.deltaIds[0]!)}/approve`,
        { method: "POST", body: JSON.stringify({ actor: "test-operator", reason: "approve bounded prompt delta" }) },
      );
      assert.equal(approved.status, "validated");

      const graph = await api<{ nodes: Array<{ id: string }>; edges: Array<{ type: string }> }>(
        server.url,
        `/api/v2/evolution/graph?nodeId=${encodeURIComponent(delta.deltaIds[0]!)}`,
      );
      assert.equal(graph.nodes.some((node) => node.id === cards.cardIds[0]), true);
      assert.equal(graph.edges.some((edge) => edge.type === "BASED_ON"), true);
    } finally {
      await server.close();
    }
  });
});

test("Evolution HTTP API registers assets, rolls back assets, and runs sandbox decision rules", async () => {
  await withDb(async (db) => {
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const baseline = await api<{ assetId: string }>(server.url, "/api/v2/evolution/assets/register", {
        method: "POST",
        body: JSON.stringify({
          actor: "test-operator",
          reason: "register baseline prompt",
          assetKind: "prompt_template",
          assetRef: "prompt-software-maker",
          version: "v1",
          status: "active",
          payload: { sections: ["baseline"] },
        }),
      });
      const candidate = await api<{ assetId: string }>(server.url, "/api/v2/evolution/assets/register", {
        method: "POST",
        body: JSON.stringify({
          actor: "test-operator",
          reason: "register candidate prompt",
          assetKind: "prompt_template",
          assetRef: "prompt-software-maker",
          version: "v2",
          parentVersion: "v1",
          status: "candidate",
          payload: { sections: ["baseline", "self-check"] },
        }),
      });
      await api<{ assetId: string }>(server.url, `/api/v2/evolution/assets/${encodeURIComponent(candidate.assetId)}/promote`, {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "sandbox passed", targetStatus: "active" }),
      });
      const rollback = await api<{ activeAssetId: string; rolledBackFromAssetId: string }>(
        server.url,
        `/api/v2/evolution/assets/${encodeURIComponent(candidate.assetId)}/rollback`,
        { method: "POST", body: JSON.stringify({ actor: "test-operator", reason: "regression detected" }) },
      );
      assert.equal(rollback.activeAssetId, baseline.assetId);
      assert.equal(rollback.rolledBackFromAssetId, candidate.assetId);

      const signals = await api<{ nodeIds: string[] }>(server.url, "/api/v2/evolution/signals", {
        method: "POST",
        body: JSON.stringify({
          actor: "test-operator",
          reason: "seed card for sandbox delta",
          signals: [repairSignal("run-sandbox-api-1", "eval-sandbox-api-1"), repairSignal("run-sandbox-api-2", "eval-sandbox-api-2")],
        }),
      });
      assert.equal(signals.nodeIds.length, 2);
      const cards = await api<{ cardIds: string[] }>(server.url, "/api/v2/evolution/cards/synthesize", {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "synthesize card for sandbox" }),
      });
      const delta = await api<{ deltaIds: string[] }>(server.url, "/api/v2/evolution/deltas/synthesize", {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "create delta for sandbox", sourceCardRefs: cards.cardIds, targetRef: "prompt-software-maker", targetVersion: "v1" }),
      });
      const experiment = await api<{ experimentId: string; decision: string }>(
        server.url,
        `/api/v2/evolution/deltas/${encodeURIComponent(delta.deltaIds[0]!)}/run-sandbox`,
        {
          method: "POST",
          body: JSON.stringify({
            actor: "test-operator",
            reason: "run deterministic sandbox decision",
            baselineAssetRefs: ["prompt@v1"],
            candidateAssetRefs: ["prompt@v2"],
            regressionSuiteRefs: ["software-core-regression"],
            replayRunRefs: ["run-sandbox-api-1"],
            baselineTrial: { status: "failed", targetedReplayFixed: false, metrics: { durationMs: 1000, costMicrosUsd: 1000, repairCount: 1, tokens: 1000, toolCalls: 4 } },
            candidateTrial: { status: "passed", targetedReplayFixed: true, metrics: { durationMs: 1050, costMicrosUsd: 1050, repairCount: 0, tokens: 1000, toolCalls: 4 } },
          }),
        },
      );
      assert.equal(experiment.decision, "passed");
      const experiments = await api<Array<{ id: string; status: string }>>(server.url, "/api/v2/evolution/experiments");
      assert.equal(experiments.some((item) => item.id === experiment.experimentId && item.status === "passed"), true);
    } finally {
      await server.close();
    }
  });
});

test("Evolution HTTP API handles wiki maintenance and regression alert commands", async () => {
  await withDb(async (db) => {
    const oldCard = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "superseded", payload: { topicKey: "old", aliases: [" Report Checklist ", "report-checklist"] }, summaryText: "Old" });
    const newCard = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "new" }, summaryText: "New" });
    const run = await createLearningNode(db, { nodeType: "run", scope: "software", status: "completed", payload: { title: "consumer" }, summaryText: "Consumer" });
    await createLearningEdge(db, { fromNodeId: run.id, edgeType: "SUPPORTED_BY", toNodeId: oldCard.id, evidence: { wikiRelation: "supports", status: "active", reason: "old support", evidenceNodeRefs: [run.id] } });
    await createLearningEdge(db, { fromNodeId: oldCard.id, edgeType: "SUPERSEDES", toNodeId: newCard.id, evidence: { wikiRelation: "supersedes", status: "active", reason: "replacement" } });

    const v1 = await createAssetVersion(db, { assetKind: "prompt_template", assetRef: "prompt-alert", version: "v1", status: "active", payload: { prompt: "old" } });
    const v2 = await createAssetVersion(db, { assetKind: "prompt_template", assetRef: "prompt-alert", version: "v2", parentVersion: "v1", status: "active", payload: { prompt: "new" } });
    await recordAssetRegressionObservation(db, { assetId: v2.id, riskTier: "high", evaluatorFailureRateDelta: 0.2, repairCountDelta: 2, costRegressionPercent: 1, durationRegressionPercent: 1, observedRunRefs: ["run-regressed"] });
    const monitor = await runRegressionMonitor(db, { actor: "test-operator", reason: "detect high-risk regression" });
    assert.equal(monitor.alerts.length, 1);

    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const aliases = await api<{ aliases: string[] }>(server.url, `/api/v2/evolution/wiki/${encodeURIComponent(oldCard.id)}/normalize-aliases`, {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "normalize aliases" }),
      });
      assert.deepEqual(aliases.aliases, ["report checklist"]);
      const rewired = await api<{ rewiredEdges: unknown[] }>(server.url, "/api/v2/evolution/wiki/maintenance/rewire-stale", {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "rewire old backlinks" }),
      });
      assert.equal(rewired.rewiredEdges.length, 1);
      const conflict = await api<{ conflictId: string }>(server.url, "/api/v2/evolution/wiki/conflicts", {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "open conflict", fromNodeId: oldCard.id, toNodeId: newCard.id, evidenceNodeRefs: [run.id] }),
      });
      const resolved = await api<{ conflictId: string; status: string }>(server.url, `/api/v2/evolution/wiki/conflicts/${encodeURIComponent(conflict.conflictId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "resolve conflict", resolution: "superseded" }),
      });
      assert.equal(resolved.status, "resolved");
      const acknowledged = await api<{ alertId: string; status: string }>(server.url, `/api/v2/evolution/regression-alerts/${encodeURIComponent(monitor.alerts[0]!.alertId)}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "acknowledged regression" }),
      });
      assert.equal(acknowledged.status, "acknowledged");
      const dismissed = await api<{ alertId: string; status: string }>(server.url, `/api/v2/evolution/regression-alerts/${encodeURIComponent(monitor.alerts[0]!.alertId)}/dismiss`, {
        method: "POST",
        body: JSON.stringify({ actor: "test-operator", reason: "dismiss duplicate" }),
      });
      assert.equal(dismissed.status, "dismissed");
    } finally {
      await server.close();
    }
  });
});

test("Evolution mutating APIs require actor and reason", async () => {
  await withDb(async (db) => {
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/evolution/cards/synthesize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "test-operator" }),
      });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /reason is required/);
    } finally {
      await server.close();
    }
  });
});

function repairSignal(runId: string, sourceRef: string) {
  return {
    signalKind: "repair_success",
    scope: "software",
    runId,
    taskId: "implement-feature",
    roleRef: "maker",
    intent: "implement_feature",
    agentProfileRef: "software-maker-pi",
    artifactType: "implementation_report",
    failureKind: "missing_required_field",
    missingFields: ["commandsRun", "risks"],
    repairInstruction: "include commandsRun and risks",
    outcome: "passed_after_repair",
    sourceRefs: [sourceRef],
  };
}

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
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
