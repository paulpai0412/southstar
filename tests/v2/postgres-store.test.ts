import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb } from "../../src/v2/db/postgres.ts";
import { SOUTHSTAR_SCHEMA_VERSION } from "../../src/v2/db/schema.ts";

type TestDatabase = {
  databaseName: string;
  databaseUrl: string;
  drop(): Promise<void>;
};

test("schema version marks library edges migration", () => {
  assert.equal(SOUTHSTAR_SCHEMA_VERSION, "2026_06_23_library_edges_v2");
});

test("db:init creates simplified southstar Postgres schema without dedicated wiki/evolution tables", async () => {
  const fixture = await createTestDatabase();
  try {
    const init = await initializeSouthstarSchema(fixture.databaseUrl);
    assert.equal(init.version, SOUTHSTAR_SCHEMA_VERSION);

    const client = new Client({ connectionString: fixture.databaseUrl });
    await client.connect();
    const tables = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'southstar' order by table_name",
    );
    const tableNames = tables.rows.map((row) => row.table_name);
    assert.deepEqual(tableNames, [
      "artifact_blobs",
      "learning_edges",
      "learning_nodes",
      "library_edges",
      "library_history",
      "library_objects",
      "library_similarity_index",
      "runtime_resources",
      "schema_metadata",
      "secure_blobs",
      "work_items",
      "workflow_history",
      "workflow_runs",
      "workflow_tasks",
    ]);
    assert.equal(tableNames.includes("knowledge_wiki_pages"), false);
    assert.equal(tableNames.includes("knowledge_wiki_links"), false);
    assert.equal(tableNames.includes("asset_versions"), false);
    assert.equal(tableNames.includes("delta_proposals"), false);
    assert.equal(tableNames.includes("sandbox_experiments"), false);
    await client.end();
  } finally {
    await fixture.drop();
  }
});

test("db:init creates library_edges indexes and endpoint FKs with cascade delete", async () => {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const client = new Client({ connectionString: fixture.databaseUrl });
    await client.connect();

    const indexes = await client.query<{ indexname: string }>(
      `select indexname
         from pg_catalog.pg_indexes
        where schemaname = 'southstar'
          and tablename = 'library_edges'
          and indexname in ('idx_library_edges_from', 'idx_library_edges_to', 'idx_library_edges_scope')
        order by indexname`,
    );
    assert.deepEqual(
      indexes.rows.map((row) => row.indexname),
      ["idx_library_edges_from", "idx_library_edges_scope", "idx_library_edges_to"],
    );

    const constraints = await client.query<{ conname: string; definition: string }>(
      `select con.conname, pg_catalog.pg_get_constraintdef(con.oid) as definition
         from pg_catalog.pg_constraint con
         join pg_catalog.pg_class rel on rel.oid = con.conrelid
         join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
        where nsp.nspname = 'southstar'
          and rel.relname = 'library_edges'
          and con.contype = 'f'
        order by con.conname`,
    );
    assert.equal(constraints.rows.some((row) => row.conname === "fk_library_edges_from_object_key"), true);
    assert.equal(constraints.rows.some((row) => row.conname === "fk_library_edges_to_object_key"), true);
    assert.equal(
      constraints.rows.some((row) => row.definition === "FOREIGN KEY (from_object_key) REFERENCES southstar.library_objects(object_key) ON DELETE CASCADE"),
      true,
    );
    assert.equal(
      constraints.rows.some((row) => row.definition === "FOREIGN KEY (to_object_key) REFERENCES southstar.library_objects(object_key) ON DELETE CASCADE"),
      true,
    );

    await client.query(
      `insert into southstar.library_objects(id, object_key, object_kind, status, state_json)
       values
         ('obj-1', 'object/A', 'doc', 'active', '{}'::jsonb),
         ('obj-2', 'object/B', 'doc', 'active', '{}'::jsonb),
         ('obj-3', 'object/C', 'doc', 'active', '{}'::jsonb)`,
    );
    await client.query(
      `insert into southstar.library_edges(from_object_key, edge_type, to_object_key)
       values ('object/A', 'RELATED_TO', 'object/B')`,
    );
    await assert.rejects(
      () =>
        client.query(
          `insert into southstar.library_edges(from_object_key, edge_type, to_object_key)
           values ('missing/object', 'RELATED_TO', 'object/C')`,
        ),
      /foreign key|violates/,
    );
    await client.query("delete from southstar.library_objects where object_key = $1", ["object/A"]);
    const remainingEdges = await client.query<{ count: string }>("select count(*) as count from southstar.library_edges");
    assert.equal(remainingEdges.rows[0]?.count, "0");

    await client.end();
  } finally {
    await fixture.drop();
  }
});

test("runtime open validates schema metadata and rejects uninitialized databases", async () => {
  const fixture = await createTestDatabase();
  try {
    await assert.rejects(() => openSouthstarDb(fixture.databaseUrl), /db:init|schema/i);
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    const metadata = await db.one<{ schema_name: string; version: string }>(
      "select schema_name, version from southstar.schema_metadata where schema_name = $1",
      ["southstar"],
    );
    assert.equal(metadata.schema_name, "southstar");
    assert.equal(metadata.version, SOUTHSTAR_SCHEMA_VERSION);
    await db.close();
  } finally {
    await fixture.drop();
  }
});

test("runtime open rejects SQLite paths instead of falling back", async () => {
  await assert.rejects(() => openSouthstarDb(":memory:"), /Postgres database URL|SQLite paths are not supported/);
  await assert.rejects(() => openSouthstarDb(".southstar/southstar-v2.sqlite3"), /Postgres database URL|SQLite paths are not supported/);
});

async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  }
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  const databaseUrl = replaceDatabase(adminUrl, databaseName);
  return {
    databaseName,
    databaseUrl,
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
