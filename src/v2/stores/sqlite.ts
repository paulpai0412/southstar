// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SOUTHSTAR_V2_SCHEMA } from "./schema.ts";

export type SouthstarDb = DatabaseSync;

export function openSouthstarDb(path: string): SouthstarDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("pragma foreign_keys = on;");
  db.exec("pragma journal_mode = WAL;");
  db.exec("pragma busy_timeout = 5000;");
  db.exec(SOUTHSTAR_V2_SCHEMA);
  return db;
}
