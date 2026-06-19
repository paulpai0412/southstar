import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { validateSouthstarSchema } from "./init.ts";

export type SouthstarDb = {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  one<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<T>(fn: (db: SouthstarDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export async function openSouthstarDb(databaseUrl: string): Promise<SouthstarDb> {
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error("Southstar v2 requires a Postgres database URL; SQLite paths are not supported");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let validationError: unknown;
  try {
    await validateSouthstarSchema(client);
  } catch (error) {
    validationError = error;
  } finally {
    client.release();
  }
  if (validationError) {
    await pool.end();
    throw validationError;
  }
  return poolDb(pool);
}

function poolDb(pool: Pool): SouthstarDb {
  return {
    async query(sql, params = []) {
      return await pool.query(sql, params);
    },
    async one(sql, params = []) {
      const result = await pool.query(sql, params);
      if (result.rows.length !== 1) throw new Error(`expected exactly one row, got ${result.rows.length}`);
      return result.rows[0];
    },
    async maybeOne(sql, params = []) {
      const result = await pool.query(sql, params);
      if (result.rows.length > 1) throw new Error(`expected zero or one row, got ${result.rows.length}`);
      return result.rows[0] ?? null;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(clientDb(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function clientDb(client: PoolClient): SouthstarDb {
  return {
    async query(sql, params = []) {
      return await client.query(sql, params);
    },
    async one(sql, params = []) {
      const result = await client.query(sql, params);
      if (result.rows.length !== 1) throw new Error(`expected exactly one row, got ${result.rows.length}`);
      return result.rows[0];
    },
    async maybeOne(sql, params = []) {
      const result = await client.query(sql, params);
      if (result.rows.length > 1) throw new Error(`expected zero or one row, got ${result.rows.length}`);
      return result.rows[0] ?? null;
    },
    tx: (fn) => fn(clientDb(client)),
    close: async () => {},
  };
}
