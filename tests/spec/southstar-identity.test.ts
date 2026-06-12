import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/load-config.ts";
import { runPlanningCommand } from "../../src/cli/planning-command.ts";

const repoRoot = join(import.meta.dirname, "../..");
const configPath = join(repoRoot, "tests/fixtures/southstar/config/.southstar.yaml");

test("package identity is Southstar only", async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@southstar/runtime");
  assert.deepEqual(pkg.bin, {
    southstar: "src/cli/entrypoint.ts",
    "southstar-agent-runner": "src/v2/agent-runner/cli.ts",
  });
  assert.equal(pkg.scripts.southstar, "tsx src/cli/entrypoint.ts");
  assert.equal(pkg.scripts.northstar, undefined);
});

test("source files do not expose Northstar CLI naming", async () => {
  const entrypoint = await readFile(join(repoRoot, "src/cli/entrypoint.ts"), "utf8");
  assert.match(entrypoint, /southstar/);
  assert.doesNotMatch(entrypoint, /northstar/i);
});

test("production source does not import Northstar CLI shell", async () => {
  for (const path of [
    "src/cli/entrypoint.ts",
    "src/cli/planning-command.ts",
    "src/operator-dashboard/local-api.ts",
  ]) {
    const source = await readFile(join(repoRoot, path), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*northstar\.ts["']/i, path);
  }
});

test("config loader accepts project root override", () => {
  const config = loadConfig(configPath, "/tmp/southstar-project");
  assert.equal(config.project.root, "/tmp/southstar-project");
});

test("planning commands are parsed outside Southstar top-level command list", async () => {
  await assert.rejects(
    () => runPlanningCommand(["plan-grill", "--config", configPath]),
    /--brief is required/,
  );
});

test("operator dashboard uses planning command availability for plan issue gate", async () => {
  const source = await readFile(join(repoRoot, "src/operator-dashboard/local-api.ts"), "utf8");
  assert.match(source, /isPlanningCommand\("plan-issues"\)/);
});
