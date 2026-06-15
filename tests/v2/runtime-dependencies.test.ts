import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildRuntimeDependencies, loadRuntimeConfigForV2 } from "../../src/v2/runtime/dependencies.ts";

const fixture = join(import.meta.dirname, "../fixtures/southstar/config/.southstar.yaml");

test("runtime dependencies load config and create executor manager", () => {
  const config = loadRuntimeConfigForV2(fixture);
  assert.equal(config.executor.provider, "tork");

  const deps = buildRuntimeDependencies({ configPath: fixture, resolveCredential: () => "secret" });
  assert.equal(deps.executorManager.provider.executorType, "tork");
});
