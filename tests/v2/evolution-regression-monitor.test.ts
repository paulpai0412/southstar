import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createAssetVersion, promoteAssetVersion } from "../../src/v2/evolution/assets.ts";
import { recordAssetRegressionObservation, runRegressionMonitor } from "../../src/v2/evolution/regression-monitor.ts";

test("regression monitor auto-rolls back low-risk promoted asset", async () => {
  await withDb(async (db) => {
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
      payload: { sections: ["baseline", "checklist"] },
      status: "candidate",
    });
    await promoteAssetVersion(db, { assetId: v2.id, actor: "test-operator", reason: "sandbox passed", targetStatus: "active" });
    await recordAssetRegressionObservation(db, {
      assetId: v2.id,
      riskTier: "low",
      evaluatorFailureRateDelta: 0.25,
      repairCountDelta: 3,
      costRegressionPercent: 5,
      durationRegressionPercent: 5,
      observedRunRefs: ["run-regressed-1"],
    });

    const result = await runRegressionMonitor(db, { actor: "monitor", reason: "scheduled regression check" });
    assert.equal(result.rollbacks.length, 1);
    assert.equal(result.rollbacks[0]?.activeAssetId, v1.id);
    assert.equal(result.alerts.length, 0);

    const statuses = await db.query<{ resource_key: string; status: string }>(
      "select resource_key, status from southstar.runtime_resources where resource_type = 'asset_version' order by resource_key",
    );
    assert.equal(statuses.rows.some((row) => row.resource_key === v1.id && row.status === "active"), true);
    assert.equal(statuses.rows.some((row) => row.resource_key === v2.id && row.status === "rolled_back"), true);
  });
});

test("regression monitor creates approval alert for high-risk regressed asset", async () => {
  await withDb(async (db) => {
    const v1 = await createAssetVersion(db, {
      assetKind: "agent_profile",
      assetRef: "software-maker-pi",
      version: "v1",
      payload: { model: "pi-agent-default" },
      status: "active",
    });
    const v2 = await createAssetVersion(db, {
      assetKind: "agent_profile",
      assetRef: "software-maker-pi",
      version: "v2",
      parentVersion: "v1",
      payload: { model: "new-provider" },
      status: "candidate",
    });
    await promoteAssetVersion(db, { assetId: v2.id, actor: "test-operator", reason: "approved high-risk profile", targetStatus: "active" });
    await recordAssetRegressionObservation(db, {
      assetId: v2.id,
      riskTier: "high",
      evaluatorFailureRateDelta: 0.3,
      repairCountDelta: 4,
      costRegressionPercent: 50,
      durationRegressionPercent: 20,
      observedRunRefs: ["run-regressed-2"],
    });

    const result = await runRegressionMonitor(db, { actor: "monitor", reason: "scheduled regression check" });
    assert.equal(result.rollbacks.length, 0);
    assert.equal(result.alerts.length, 1);

    const active = await db.one<{ status: string }>(
      "select status from southstar.runtime_resources where resource_type = 'asset_version' and resource_key = $1",
      [v2.id],
    );
    assert.equal(active.status, "active");
    const alert = await db.one<{ resource_type: string; status: string; payload_json: { assetId: string } }>(
      "select resource_type, status, payload_json from southstar.runtime_resources where resource_type = 'approval_alert'",
    );
    assert.equal(alert.status, "pending");
    assert.equal(alert.payload_json.assetId, v2.id);
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
