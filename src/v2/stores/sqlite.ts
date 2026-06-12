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
  db.exec(SOUTHSTAR_V2_SCHEMA);
  return db;
}
