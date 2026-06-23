import test from "node:test";
import assert from "node:assert/strict";
import { initializeSouthstarSchema } from "../../../src/v2/db/init.ts";
import { openSouthstarDb } from "../../../src/v2/db/postgres.ts";
import { SOUTHSTAR_SCHEMA_VERSION } from "../../../src/v2/db/schema.ts";
import { createRealPostgresE2E, probeRealPostgresTorkPi, requireRealPostgresInfra } from "../postgres-real-harness.ts";

// This case is intentionally real and fail-closed. It proves the minimum shared
// infrastructure contract before any workflow, recovery, or evolution scenario runs.
test("00 infra preflight: real Postgres schema, Tork, and Pi endpoints are reachable", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);

  const env = await createRealPostgresE2E();
  try {
    await initializeSouthstarSchema(env.databaseUrl);
    const db = await openSouthstarDb(env.databaseUrl);
    try {
      const metadata = await db.one<{ schema_name: string; version: string }>(
        "select schema_name, version from southstar.schema_metadata where schema_name = $1",
        ["southstar"],
      );
      assert.equal(metadata.schema_name, "southstar");
      assert.equal(metadata.version, SOUTHSTAR_SCHEMA_VERSION);
    } finally {
      await db.close();
    }
  } finally {
    await env.close();
  }
});
