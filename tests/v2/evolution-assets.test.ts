import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { createAssetVersion, promoteAssetVersion, rollbackAssetVersion, routeAgentProfileCanary } from "../../src/v2/evolution/assets.ts";

test("asset promotion creates active resource, supersedes previous active version, and records graph lineage", async () => {
  await withDb(async (db) => {
    await createLearningNode(db, {
      id: "delta-prompt-1",
      nodeType: "delta_proposal",
      scope: "evolution",
      status: "validated",
      payload: { deltaKind: "prompt_delta" },
      summaryText: "Prompt delta",
    });
    const v1 = await createAssetVersion(db, {
      assetKind: "prompt_template",
      assetRef: "prompt-software-maker",
      version: "v1",
      payload: { sections: ["baseline"] },
      status: "active",
    });
    const v2 = await createAssetVersion(db, {
      assetKind: "prompt_template",
      assetRef: "prompt-software-maker",
      version: "v2",
      parentVersion: "v1",
      payload: { sections: ["baseline", "final artifact self-check"] },
      status: "candidate",
    });

    await promoteAssetVersion(db, {
      assetId: v2.id,
      promotedByDeltaId: "delta-prompt-1",
      actor: "test-operator",
      reason: "sandbox passed",
      targetStatus: "active",
    });

    const assets = await db.query<{ resource_key: string; status: string; payload_json: { promotedByDeltaId?: string } }>(
      "select resource_key, status, payload_json from southstar.runtime_resources where resource_type = 'asset_version' order by resource_key",
    );
    assert.equal(assets.rows.some((row) => row.resource_key === v1.id && row.status === "superseded"), true);
    assert.equal(assets.rows.some((row) => row.resource_key === v2.id && row.status === "active" && row.payload_json.promotedByDeltaId === "delta-prompt-1"), true);

    const node = await db.one<{ node_type: string; status: string }>(
      "select node_type, status from southstar.learning_nodes where id = $1",
      [v2.id],
    );
    assert.equal(node.node_type, "prompt_version");
    assert.equal(node.status, "active");

    const promotion = await db.one<{ edge_type: string }>(
      "select edge_type from southstar.learning_edges where from_node_id = $1 and to_node_id = $2",
      ["delta-prompt-1", v2.id],
    );
    assert.equal(promotion.edge_type, "PROMOTED_TO");

    const tables = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'southstar' and table_name = 'asset_versions'",
    );
    assert.deepEqual(tables.rows, []);
  });
});

test("medium-risk profile promotion canary routes deterministically without changing baseline active asset", async () => {
  await withDb(async (db) => {
    const baseline = await createAssetVersion(db, {
      assetKind: "agent_profile",
      assetRef: "software-maker-pi",
      version: "v1",
      payload: { model: "pi-agent-default", skillRefs: ["software.minimal-patch"] },
      status: "active",
    });
    const candidate = await createAssetVersion(db, {
      assetKind: "agent_profile",
      assetRef: "software-maker-pi",
      version: "v2",
      parentVersion: "v1",
      payload: { model: "pi-agent-default", skillRefs: ["software.minimal-patch", "software.test-evidence"] },
      status: "candidate",
    });

    await promoteAssetVersion(db, {
      assetId: candidate.id,
      actor: "test-operator",
      reason: "medium-risk profile sandbox passed, enter canary",
      targetStatus: "canary",
      canaryPercent: 25,
    });

    const after = await db.query<{ resource_key: string; status: string }>(
      "select resource_key, status from southstar.runtime_resources where resource_type = 'asset_version' order by resource_key",
    );
    assert.equal(after.rows.some((row) => row.resource_key === baseline.id && row.status === "active"), true);
    assert.equal(after.rows.some((row) => row.resource_key === candidate.id && row.status === "canary"), true);

    const first = routeAgentProfileCanary({ runId: "run-123", taskId: "task-maker", percentage: 25 });
    const second = routeAgentProfileCanary({ runId: "run-123", taskId: "task-maker", percentage: 25 });
    assert.equal(first, second);
    assert.equal(["baseline", "candidate"].includes(first), true);
  });
});

test("rollback restores previous active asset version without deleting history", async () => {
  await withDb(async (db) => {
    const v1 = await createAssetVersion(db, {
      assetKind: "skill",
      assetRef: "software.test-evidence",
      version: "v1",
      payload: { checklist: ["run tests"] },
      status: "active",
    });
    const v2 = await createAssetVersion(db, {
      assetKind: "skill",
      assetRef: "software.test-evidence",
      version: "v2",
      parentVersion: "v1",
      payload: { checklist: ["run tests", "collect evidence"] },
      status: "candidate",
    });
    await promoteAssetVersion(db, {
      assetId: v2.id,
      actor: "test-operator",
      reason: "sandbox passed",
      targetStatus: "active",
    });

    const rollback = await rollbackAssetVersion(db, {
      assetId: v2.id,
      actor: "test-operator",
      reason: "regression monitor found higher repair rate",
    });
    assert.equal(rollback.activeAssetId, v1.id);
    assert.equal(rollback.rolledBackFromAssetId, v2.id);

    const statuses = await db.query<{ resource_key: string; status: string }>(
      "select resource_key, status from southstar.runtime_resources where resource_type = 'asset_version' order by resource_key",
    );
    assert.equal(statuses.rows.some((row) => row.resource_key === v1.id && row.status === "active"), true);
    assert.equal(statuses.rows.some((row) => row.resource_key === v2.id && row.status === "rolled_back"), true);

    const rollbackNode = await db.one<{ node_type: string; status: string }>(
      "select node_type, status from southstar.learning_nodes where node_type = 'rollback'",
    );
    assert.equal(rollbackNode.status, "completed");

    const edge = await db.one<{ edge_type: string }>(
      "select edge_type from southstar.learning_edges where edge_type = 'ROLLED_BACK_TO'",
    );
    assert.equal(edge.edge_type, "ROLLED_BACK_TO");
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
