import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CATALOG_CANONICAL_DOMAIN_KEYS } from "../../src/v2/design-library/canonical-domains.ts";

const root = join(import.meta.dirname, "../..");

test("imported agency agents use canonical CATALOG domains instead of software", async () => {
  const agentRoot = join(root, "library", "agents");
  const files = (await readdir(agentRoot)).filter((file) => file.endsWith(".agent.md")).sort();
  const allowed = new Set(CATALOG_CANONICAL_DOMAIN_KEYS);
  const counts = new Map<string, number>();

  for (const file of files) {
    const content = await readFile(join(agentRoot, file), "utf8");
    const scope = content.match(/^scope:\s*"?([^"\n]+)"?\s*$/m)?.[1];
    assert.notEqual(scope, "software", `${file} should not be scoped to software`);
    assert.ok(scope && allowed.has(scope), `${file} should use a canonical catalog domain, got ${scope}`);
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }

  assert.equal(files.length, 266);
  assert.equal(counts.get("engineering"), 41);
  assert.equal(counts.get("marketing"), 42);
  assert.equal(counts.get("specialized"), 58);
  assert.equal(counts.size, 19);
});

test("runtime UI APIs do not auto-seed the legacy software library graph", async () => {
  const runApi = await readFile(join(root, "src/v2/ui-api/postgres-run-api.ts"), "utf8");
  const taskEnvelope = await readFile(join(root, "src/v2/ui-api/postgres-task-envelope.ts"), "utf8");

  assert.doesNotMatch(runApi, /seedSoftwareLibraryGraph/);
  assert.doesNotMatch(taskEnvelope, /seedSoftwareLibraryGraph/);
});
