import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const CANONICAL_FILES = [
  "src/v2/session/postgres-session-store.ts",
  "src/v2/session-recovery/postgres-controller.ts",
  "src/v2/scheduler/runnable-task-scheduler.ts",
  "src/v2/meta-harness/postgres-bindings.ts",
  "src/v2/read-models/managed-agents.ts",
  "src/v2/tool-proxy/tool-proxy.ts",
];

test("managed-agent canonical files do not import legacy SQLite surfaces", () => {
  for (const file of CANONICAL_FILES) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.doesNotMatch(text, /stores\/sqlite|ui-api\/local-api|session-graph\/sqlite-provider|legacy\/sqlite/);
  }
});
