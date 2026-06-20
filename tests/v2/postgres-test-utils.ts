import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";

export type TestPostgresDb = SouthstarDb & {
  databaseUrl: string;
  drop(): Promise<void>;
};

export async function createTestPostgresDb(): Promise<TestPostgresDb> {
  const fixture = await createTestDatabase();
  let db: SouthstarDb | undefined;
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    db = await openSouthstarDb(fixture.databaseUrl);
    const originalClose = db.close.bind(db);
    let closed = false;
    async function closeAndDrop() {
      if (closed) return;
      closed = true;
      try {
        await originalClose();
      } finally {
        await fixture.drop();
      }
    }
    return Object.assign(db, {
      databaseUrl: fixture.databaseUrl,
      close: closeAndDrop,
      drop: closeAndDrop,
    });
  } catch (error) {
    try {
      await db?.close();
    } finally {
      await fixture.drop();
    }
    throw error;
  }
}

export async function initSouthstarSchema(_db: SouthstarDb): Promise<void> {
  // createTestPostgresDb initializes schema before opening because openSouthstarDb validates metadata.
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  let adminConnected = false;
  try {
    await admin.connect();
    adminConnected = true;
    await admin.query(`create database ${quoteIdent(databaseName)}`);
  } finally {
    if (adminConnected) await admin.end();
  }
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      let cleanupConnected = false;
      try {
        await cleanup.connect();
        cleanupConnected = true;
        await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
        await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      } finally {
        if (cleanupConnected) await cleanup.end();
      }
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
