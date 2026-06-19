import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { createAssetVersion } from "../../src/v2/evolution/assets.ts";
import { evaluateDeltaPromotionPolicyPg } from "../../src/v2/evolution/promotion-policy.ts";

test("promotion policy auto-promotes low-risk prompt deltas and records lineage", async () => {
  await withDb(async (db) => {
    await seedDelta(db, { id: "delta-low-prompt", deltaKind: "prompt_delta", riskTier: "low", targetRef: "prompt-x", targetVersion: "v1" });
    await createAssetVersion(db, { assetKind: "prompt_template", assetRef: "prompt-x", version: "v1", status: "active", payload: { template: "old" } });
    const candidate = await createAssetVersion(db, { assetKind: "prompt_template", assetRef: "prompt-x", version: "v2", status: "candidate", payload: { template: "new" }, promotedByDeltaId: "delta-low-prompt" });

    const result = await evaluateDeltaPromotionPolicyPg(db, { deltaId: "delta-low-prompt", candidateAssetId: candidate.id, actor: "operator", reason: "sandbox passed" });

    assert.equal(result.status, "promoted");
    assert.equal(result.decisionMode, "auto");
    const asset = await db.one<{ status: string; payload_json: { promotedByDeltaId?: string } }>("select status, payload_json from southstar.runtime_resources where resource_key = $1", [candidate.id]);
    assert.equal(asset.status, "active");
    assert.equal(asset.payload_json.promotedByDeltaId, "delta-low-prompt");
    const delta = await db.one<{ status: string }>("select status from southstar.runtime_resources where resource_key = 'delta-low-prompt'");
    assert.equal(delta.status, "promoted");
    const edge = await db.one<{ edge_type: string }>("select edge_type from southstar.learning_edges where from_node_id = 'delta-low-prompt' and to_node_id = $1", [candidate.id]);
    assert.equal(edge.edge_type, "PROMOTED_TO");
  });
});

test("promotion policy routes profile and flow deltas to approval before asset promotion", async () => {
  await withDb(async (db) => {
    await seedDelta(db, { id: "delta-profile-medium", deltaKind: "agent_profile_delta", riskTier: "medium", targetRef: "software-maker-pi", targetVersion: "v1" });
    const profile = await createAssetVersion(db, { assetKind: "agent_profile", assetRef: "software-maker-pi", version: "v2", status: "candidate", payload: { profile: "candidate" }, promotedByDeltaId: "delta-profile-medium" });
    const profileDecision = await evaluateDeltaPromotionPolicyPg(db, { deltaId: "delta-profile-medium", candidateAssetId: profile.id, actor: "operator", reason: "needs canary approval" });
    assert.equal(profileDecision.status, "pending_approval");
    assert.equal(profileDecision.targetStatus, "canary");
    assert.match(profileDecision.approvalId ?? "", /^approval-/);

    await seedDelta(db, { id: "delta-flow-high", deltaKind: "flow_delta", riskTier: "low", targetRef: "software.flow", targetVersion: "v1" });
    const flow = await createAssetVersion(db, { assetKind: "flow_policy", assetRef: "software.flow", version: "v2", status: "candidate", payload: { flow: "candidate" }, promotedByDeltaId: "delta-flow-high" });
    const flowDecision = await evaluateDeltaPromotionPolicyPg(db, { deltaId: "delta-flow-high", candidateAssetId: flow.id, actor: "operator", reason: "flow requires manual review" });
    assert.equal(flowDecision.status, "pending_approval");
    assert.equal(flowDecision.targetStatus, "active");

    const approvals = await db.query<{ resource_type: string; status: string; payload_json: { deltaId?: string; actionType?: string; targetStatus?: string } }>(
      "select resource_type, status, payload_json from southstar.runtime_resources where resource_type = 'approval' order by resource_key",
    );
    assert.equal(approvals.rows.length, 2);
    assert.deepEqual(approvals.rows.map((row) => row.payload_json.actionType), ["deltaPromotion", "deltaPromotion"]);
    assert.equal(approvals.rows.some((row) => row.payload_json.deltaId === "delta-profile-medium" && row.payload_json.targetStatus === "canary"), true);
    assert.equal(approvals.rows.some((row) => row.payload_json.deltaId === "delta-flow-high" && row.payload_json.targetStatus === "active"), true);
    const profileAsset = await db.one<{ status: string }>("select status from southstar.runtime_resources where resource_key = $1", [profile.id]);
    assert.equal(profileAsset.status, "candidate");
  });
});

async function seedDelta(db: SouthstarDb, input: { id: string; deltaKind: "prompt_delta" | "skill_delta" | "agent_profile_delta" | "flow_delta"; riskTier: "low" | "medium" | "high"; targetRef: string; targetVersion: string }): Promise<void> {
  const payload = {
    id: input.id,
    deltaKind: input.deltaKind,
    targetRef: input.targetRef,
    targetVersion: input.targetVersion,
    sourceCardRefs: [],
    sourceNodeRefs: [],
    evidenceSubgraphHash: "seeded",
    hypothesis: input.id,
    patch: {},
    riskTier: input.riskTier,
    validationPlan: { regressionSuiteRefs: [], replayRunRefs: [], maxCostRegressionPercent: 10, maxDurationRegressionPercent: 10 },
    rollbackPlan: { strategy: "manual" },
    status: "validated",
  };
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values ($1, 'delta_proposal', $1, 'evolution', 'validated', $1, $2::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
    [input.id, JSON.stringify(payload)],
  );
  await createLearningNode(db, { id: input.id, nodeType: "delta_proposal", scope: "evolution", status: "validated", payload, summaryText: input.id });
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
