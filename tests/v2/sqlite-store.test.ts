import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";

test("creates centralized v2 runtime + design-library tables in SQLite", () => {
  const db = openSouthstarDb(":memory:");
  const rows = db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;

  assert.deepEqual(rows.map((row) => row.name).sort(), [
    "artifact_blobs",
    "library_history",
    "library_objects",
    "library_similarity_index",
    "runtime_resources",
    "secure_blobs",
    "workflow_history",
    "workflow_runs",
    "workflow_tasks",
  ]);
});

test("opens sqlite with busy timeout and durable journal mode", () => {
  const db = openSouthstarDb(":memory:");
  const mode = db.prepare("pragma journal_mode").get() as { journal_mode: string };
  const busy = db.prepare("pragma busy_timeout").get() as { timeout?: number; busy_timeout?: number };
  assert.ok(["wal", "memory"].includes(mode.journal_mode.toLowerCase()));
  assert.ok((busy.busy_timeout ?? busy.timeout ?? 0) >= 5000);
});
