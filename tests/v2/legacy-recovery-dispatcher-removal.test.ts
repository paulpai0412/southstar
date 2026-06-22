import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

test("legacy recovery direct-submit dispatcher is removed from production runtime", () => {
  assert.equal(existsSync(join(root, "src/v2/session-recovery/postgres-dispatcher.ts")), false);
  assert.equal(existsSync(join(root, "tests/v2/postgres-recovery-dispatcher.test.ts")), false);
  for (const path of [
    "src/v2/server/routes.ts",
    "tests/e2e-postgres/cases/04-artifact-repair-recovery.test.ts",
    "tests/e2e-postgres/cases/05-session-recovery.test.ts",
  ]) {
    const text = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(text, /dispatchRecoveryExecutionPg|recovery\/dispatch|postgres-recovery-dispatcher/);
  }
});
