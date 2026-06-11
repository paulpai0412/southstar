import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

test("coverage config scopes runtime control-plane sources with 85 percent thresholds", async () => {
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));

  assert.equal(packageJson.c8["check-coverage"], true);
  assert.equal(packageJson.c8.lines, 85);
  assert.equal(packageJson.c8.branches, 85);
  assert.equal(packageJson.c8.functions, 85);
  assert.equal(packageJson.c8.statements, 85);
  assert.deepEqual(packageJson.c8.include, [
    "src/runtime/**/*.ts",
    "src/adapters/**/*.ts",
    "src/cli/**/*.ts",
    "src/config/**/*.ts",
    "src/intake/**/*.ts",
    "src/types/**/*.ts",
  ]);
});
