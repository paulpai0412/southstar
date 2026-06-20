import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string { return readFileSync(join(root, path), "utf8"); }

const implementedCases = [
  "00-infra-preflight.test.ts",
  "01-db-schema-init.test.ts",
  "02-runtime-api-contract.test.ts",
  "03-normal-software-run.test.ts",
  "04-artifact-repair-recovery.test.ts",
  "05-session-recovery.test.ts",
  "06-executor-reconcile.test.ts",
  "07-evolution-learning.test.ts",
  "08-evolution-sandbox-baseline-candidate.test.ts",
  "09-regression-rollback.test.ts",
];

test("canonical real E2E entrypoint is a static manifest and real cases run one at a time", () => {
  const pkg = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["test:e2e:real"], "tsx tests/e2e-postgres/index.test.ts");
  assert.equal(pkg.scripts["test:e2e:postgres"], "tsx tests/e2e-postgres/index.test.ts");
  assert.equal(source("tests/e2e-postgres/index.test.ts"), "await import(\"./postgres-real-matrix-static.test.ts\");\n");

  for (const caseFile of implementedCases) {
    const caseId = caseFile.slice(0, 2);
    assert.equal(pkg.scripts[`test:e2e:postgres:${caseId}`], `tsx tests/e2e-postgres/cases/${caseFile}`);
  }
});

test("Postgres real E2E cases are explicitly ordered and contain no UI/browser cases", () => {
  const actual = readdirSync(join(root, "tests/e2e-postgres/cases")).filter((entry) => entry.endsWith(".test.ts")).sort();
  assert.deepEqual(actual, implementedCases);
  assert.match(source("tests/e2e-postgres/README.md"), /Run \*\*one case at a time\*\*/);
  assert.match(source("tests/e2e-postgres/README.md"), /Do \*\*not\*\* add UI\/browser flows here/);
  assert.equal(existsSync(join(root, "tests/e2e-postgres/ui")), false);
});

test("Postgres real E2E suite contains no SQLite/local API coupling or fake shortcuts", () => {
  const executablePaths = [
    "tests/e2e-postgres/index.test.ts",
    "tests/e2e-postgres/postgres-real-harness.ts",
    ...implementedCases.map((caseFile) => `tests/e2e-postgres/cases/${caseFile}`),
  ];
  for (const path of ["tests/e2e-postgres/README.md", ...executablePaths]) {
    const text = source(path);
    assert.doesNotMatch(text, /stores\/sqlite|ui-api\/local-api|openSouthstarDb\(\":memory:\"|assertSqliteEvidence|node:sqlite/);
  }
  for (const path of executablePaths) {
    assert.doesNotMatch(source(path), /fake|mock|smoke|test-only/i);
  }
});

test("legacy SQLite real E2E suite is physically isolated and explicitly non-canonical", () => {
  assert.equal(existsSync(join(root, "tests/e2e-real")), false);
  assert.match(source("tests/e2e-legacy-sqlite/README.md"), /not canonical/i);
  assert.match(source("tests/e2e-legacy-sqlite/index.test.ts"), /@legacy-sqlite-quarantine/);
});
