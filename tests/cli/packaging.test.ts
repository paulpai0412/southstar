import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "../../src/cli/entrypoint.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

test("package exposes southstar binary and supported node range", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  assert.equal(pkg.bin.southstar, "src/cli/entrypoint.ts");
  assert.equal(pkg.bin.northstar, undefined);
  assert.match(pkg.engines.node, />=22\.22\.2/);
});

test("entrypoint prints version and help through local executable dispatcher", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    output.push(String(value ?? ""));
  };
  try {
    assert.equal(await main(["--version"]), 0);
    assert.equal(await main(["--help"]), 0);
  } finally {
    console.log = originalLog;
  }

  assert.match(output.join("\n"), /0\.1\.0/);
  assert.match(output.join("\n"), /southstar watch/);
});

test("package inputs include CLI source and workflow fixtures", () => {
  assert.equal(existsSync(join(repoRoot, "src/cli/entrypoint.ts")), true);
  assert.equal(existsSync(join(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml")), true);
});
