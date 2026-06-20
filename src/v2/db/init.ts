import { Client } from "pg";
import { SOUTHSTAR_SCHEMA_SQL, SOUTHSTAR_SCHEMA_VERSION } from "./schema.ts";

export async function initializeSouthstarSchema(databaseUrl: string): Promise<{ version: string }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(SOUTHSTAR_SCHEMA_SQL);
    await client.query("commit");
    return { version: SOUTHSTAR_SCHEMA_VERSION };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

export async function validateSouthstarSchema(client: Pick<Client, "query">): Promise<void> {
  const result = await client.query<{ version: string }>(
    "select version from southstar.schema_metadata where schema_name = $1",
    ["southstar"],
  ).catch((error) => {
    throw new Error(`Southstar Postgres schema is not initialized; run db:init first. ${error.message}`);
  });
  const version = result.rows[0]?.version;
  if (version !== SOUTHSTAR_SCHEMA_VERSION) {
    throw new Error(`Southstar schema version mismatch: expected ${SOUTHSTAR_SCHEMA_VERSION}, got ${version ?? "missing"}`);
  }
}
