import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildRuntimeDependencies, loadRuntimeConfigForV2 } from "../../src/v2/runtime/dependencies.ts";

const fixture = join(import.meta.dirname, "../fixtures/southstar/config/.southstar.yaml");
const cubesandboxFixture = join(import.meta.dirname, "../fixtures/southstar/config/.southstar.cubesandbox.yaml");

test("runtime dependencies load config and create executor manager", () => {
  const config = loadRuntimeConfigForV2(fixture);
  assert.equal(config.executor.provider, "tork");

  const deps = buildRuntimeDependencies({ configPath: fixture, resolveCredential: () => "secret" });
  assert.equal(deps.executorManager.provider.executorType, "tork");
});

test("runtime dependencies resolve cubesandbox credential from SOUTHSTAR_SECRET_<ref> only", () => {
  withEnv({
    SOUTHSTAR_SECRET_cubesandbox_api_key: "top-secret",
    cubesandbox_api_key: "raw-env-should-not-be-used",
  }, () => {
    const deps = buildRuntimeDependencies({ configPath: cubesandboxFixture });
    assert.equal(deps.executorManager.provider.executorType, "cubesandbox");
  });
});

test("runtime dependencies reject raw credential env fallback without SOUTHSTAR_SECRET_<ref>", () => {
  withEnv({
    SOUTHSTAR_SECRET_cubesandbox_api_key: undefined,
    cubesandbox_api_key: "raw-env-should-not-be-used",
  }, () => {
    assert.throws(
      () => buildRuntimeDependencies({ configPath: cubesandboxFixture }),
      /missing credential for cubesandbox-api-key; set SOUTHSTAR_SECRET_cubesandbox_api_key/,
    );
  });
});

function withEnv(input: Record<string, string | undefined>, callback: () => void): void {
  const before = new Map<string, string | undefined>();
  for (const key of Object.keys(input)) {
    before.set(key, process.env[key]);
    if (input[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = input[key];
    }
  }
  try {
    callback();
  } finally {
    for (const [key, value] of before.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
