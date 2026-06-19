import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createRealPostgresE2E, runSouthstar } from "./postgres-real-harness.ts";
import { openSouthstarDb } from "../../src/v2/db/postgres.ts";

test("db:init creates southstar schema and runtime refuses uninitialized databases", async () => {
  const env = await createRealPostgresE2E();
  try {
    await assert.rejects(() => openSouthstarDb(env.databaseUrl), /db:init has not run|schema_metadata|schema/i);

    const output = runSouthstar(["db:init", "--config", env.configPath]);
    assert.match(output, /"type":"db:init"/);
    const db = await openSouthstarDb(env.databaseUrl);
    const metadata = await db.one<{ schema_name: string; version: string }>(
      "select schema_name, version from southstar.schema_metadata where schema_name = $1",
      ["southstar"],
    );
    assert.equal(metadata.schema_name, "southstar");
    assert.match(metadata.version, /^2026_06_17/);
    await db.close();

    const client = new Client({ connectionString: env.databaseUrl });
    await client.connect();
    const tables = await client.query<{ table_schema: string; table_name: string }>(
      "select table_schema, table_name from information_schema.tables where table_schema = 'southstar' order by table_name",
    );
    await client.end();
    assert.equal(tables.rows.some((row) => row.table_name === "workflow_runs"), true);
    assert.equal(tables.rows.some((row) => row.table_name === "learning_nodes"), true);
    assert.equal(tables.rows.some((row) => row.table_name === "learning_edges"), true);
    assert.equal(tables.rows.some((row) => row.table_name === "asset_versions"), false);
  } finally {
    await env.close();
  }
});
