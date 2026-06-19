import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string { return readFileSync(join(root, path), "utf8"); }

test("canonical real E2E scripts point at Postgres/Tork/Pi suite, not legacy SQLite", () => {
  const pkg = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["test:e2e:real"], "tsx tests/e2e-postgres/index.test.ts");
  assert.equal(pkg.scripts["test:e2e:postgres"], "tsx tests/e2e-postgres/index.test.ts");
});

test("Postgres real E2E suite contains no SQLite/local API coupling", () => {
  for (const path of [
    "tests/e2e-postgres/index.test.ts",
    "tests/e2e-postgres/postgres-real-harness.ts",
    "tests/e2e-postgres/evolution-control-plane-real.test.ts",
    "tests/e2e-postgres/postgres-tork-pi-real-matrix.test.ts",
    "tests/e2e-postgres/sandbox-baseline-candidate-real.test.ts",
  ]) {
    const text = source(path);
    assert.doesNotMatch(text, /stores\/sqlite|ui-api\/local-api|openSouthstarDb\(\":memory:\"|assertSqliteEvidence|node:sqlite/);
    assert.doesNotMatch(text, /fake|mock|smoke|test-only/i);
  }
});

test("legacy SQLite real E2E suite is physically isolated and explicitly non-canonical", () => {
  assert.equal(existsSync(join(root, "tests/e2e-real")), false);
  assert.match(source("tests/e2e-legacy-sqlite/README.md"), /not canonical/i);
  assert.match(source("tests/e2e-legacy-sqlite/index.test.ts"), /@legacy-sqlite-quarantine/);
});
