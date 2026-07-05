import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

test("V2 is the only runtime source surface", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    scripts: Record<string, string>;
  };

  assert.equal(pkg.bin.southstar, "src/v2/cli.ts");
  assert.equal(pkg.scripts.southstar, "tsx src/v2/cli.ts");

  for (const legacyPath of [
    "src/adapters",
    "src/cli",
    "src/config",
    "src/intake",
    "src/operator-dashboard",
    "src/orchestrator",
    "src/runtime",
    "src/types",
  ]) {
    assert.equal(existsSync(join(ROOT, legacyPath)), false, `${legacyPath} should be removed`);
  }
});

test("V2 source and real Postgres harness do not carry Northstar or SQLite runtime contracts", () => {
  const checkedFiles = [
    "src/v2/design-library/runtime-types.ts",
    "tests/e2e-postgres/postgres-real-harness.ts",
  ];

  for (const file of checkedFiles) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.doesNotMatch(text, /\.northstar|northstar/i, file);
    assert.doesNotMatch(text, /providerRef:\s*"sqlite"|"sqlite"\s*\|/, file);
  }
});
