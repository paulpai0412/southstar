import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";

test("creates centralized v2 runtime tables in SQLite", () => {
  const db = openSouthstarDb(":memory:");
  const rows = db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name).sort(), [
    "artifact_blobs",
    "runtime_resources",
    "secure_blobs",
    "workflow_history",
    "workflow_runs",
    "workflow_tasks",
  ]);
});
