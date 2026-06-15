import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfig } from "../../src/config/schema.ts";
import { createExecutorProviderFromConfig } from "../../src/v2/executor/factory.ts";

const lifecycle = {
  cleanupMode: "strict" as const,
  healthCheckIntervalSeconds: 10,
  reconcileIntervalSeconds: 30,
  orphanScanIntervalSeconds: 30,
  orphanGraceSeconds: 60,
  shutdownGraceSeconds: 20,
  maxRestartAttempts: 3,
  maxCleanupAttempts: 5,
  sdkCallTimeoutSeconds: 15,
  sandboxCreateTimeoutSeconds: 60,
  commandStartTimeoutSeconds: 30,
  commandIdleTimeoutSeconds: 120,
  taskWallTimeoutSeconds: 1800,
  callbackWaitTimeoutSeconds: 30,
  destroyTimeoutSeconds: 20,
  lockTtlSeconds: 60,
};

function base(provider: "tork" | "cubesandbox"): RuntimeConfig {
  return {
    schemaVersion: "1",
    project: { name: "test", root: "." },
    runtime: {
      dbPath: ":memory:",
      heartbeatIntervalSeconds: 15,
      lockTimeoutSeconds: 120,
      taskTimeoutSeconds: 1800,
      maxRetryAttempts: 2,
    },
    intake: { mode: "local" },
    sources: { local: { enabled: true } },
    projection: { local: { enabled: true, blocksRuntime: false } },
    packs: { searchPaths: [".southstar/packs"] },
    workflow: { id: "wf", version: "1", path: ".southstar/workflows/wf.yaml" },
    agents: { path: ".southstar/agents.yaml" },
    executor: {
      provider,
      lifecycle,
      tork: { baseUrl: "http://127.0.0.1:8000", submitPath: "/jobs" },
      cubesandbox: {
        sdk: "e2b-compatible",
        apiUrl: "http://127.0.0.1:3000",
        apiKeyRef: "cube-key",
        templateId: "tmpl",
        defaultTimeoutSeconds: 1800,
        destroyOnCompletion: true,
        hostMounts: [],
      },
    },
  };
}

test("provider factory creates exactly Tork when tork is active", () => {
  const provider = createExecutorProviderFromConfig(base("tork"), {
    resolveCredential: () => "secret",
  });
  assert.equal(provider.executorType, "tork");
});

test("provider factory creates exactly CubeSandbox when cubesandbox is active", () => {
  const provider = createExecutorProviderFromConfig(base("cubesandbox"), {
    resolveCredential: () => "e2b_000000",
  });
  assert.equal(provider.executorType, "cubesandbox");
});
