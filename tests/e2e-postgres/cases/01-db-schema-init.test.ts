import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createRealPostgresE2E, runSouthstar } from "../postgres-real-harness.ts";
import { openSouthstarDb } from "../../../src/v2/db/postgres.ts";
import { SOUTHSTAR_SCHEMA_VERSION } from "../../../src/v2/db/schema.ts";

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
    assert.equal(metadata.version, SOUTHSTAR_SCHEMA_VERSION);
    await db.close();

    const client = new Client({ connectionString: env.databaseUrl });
    await client.connect();
    const tables = await client.query<{ table_schema: string; table_name: string }>(
      "select table_schema, table_name from information_schema.tables where table_schema = 'southstar' order by table_name",
    );
    const edgeIndexes = await client.query<{ indexname: string }>(
      `select indexname
         from pg_catalog.pg_indexes
        where schemaname = 'southstar'
          and tablename = 'library_edges'
          and indexname in ('idx_library_edges_from', 'idx_library_edges_to', 'idx_library_edges_scope')
        order by indexname`,
    );
    const edgeFks = await client.query<{ conname: string }>(
      `select con.conname
         from pg_catalog.pg_constraint con
         join pg_catalog.pg_class rel on rel.oid = con.conrelid
         join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
        where nsp.nspname = 'southstar'
          and rel.relname = 'library_edges'
          and con.contype = 'f'
        order by con.conname`,
    );
    await client.end();
    assert.equal(tables.rows.some((row) => row.table_name === "workflow_runs"), true);
    assert.equal(tables.rows.some((row) => row.table_name === "learning_nodes"), true);
    assert.equal(tables.rows.some((row) => row.table_name === "learning_edges"), true);
    assert.equal(tables.rows.some((row) => row.table_name === "library_edges"), true);
    assert.equal(tables.rows.some((row) => row.table_name === "asset_versions"), false);
    assert.deepEqual(
      edgeIndexes.rows.map((row) => row.indexname),
      ["idx_library_edges_from", "idx_library_edges_scope", "idx_library_edges_to"],
    );
    assert.deepEqual(
      edgeFks.rows.map((row) => row.conname),
      ["fk_library_edges_from_object_key", "fk_library_edges_to_object_key"],
    );
  } finally {
    await env.close();
  }
});
