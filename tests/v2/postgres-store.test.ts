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
      "library_history",
      "library_objects",
      "library_similarity_index",
      "runtime_resources",
      "schema_metadata",
      "secure_blobs",
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
