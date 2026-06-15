import test from "node:test";
import assert from "node:assert/strict";
import { ExecutorRuntimeManager } from "../../src/v2/executor/runtime-manager.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";

function provider(): ExecutorProvider & { initialized: boolean; submitted: number } {
  return {
    executorType: "cubesandbox",
    initialized: false,
    submitted: 0,
    async initialize() {
      this.initialized = true;
    },
    async health() {
      return {
        executorType: "cubesandbox",
        status: "healthy" as const,
        checkedAt: new Date(0).toISOString(),
        capabilities: { status: true, cleanup: true },
      };
    },
    async submit() {
      this.submitted += 1;
      return {
        executorType: "cubesandbox",
        externalJobId: "cube-exec-1",
        status: "running",
        providerPayload: { sandboxId: "sbx_1" },
      };
    },
    async cleanup() {
      return {
        executorType: "cubesandbox",
        externalJobId: "cube-exec-1",
        status: "destroyed" as const,
      };
    },
  };
}

test("runtime manager initializes provider and exposes health", async () => {
  const active = provider();
  const manager = new ExecutorRuntimeManager({ provider: active });
  await manager.initialize();
  const health = await manager.health();
  assert.equal(active.initialized, true);
  assert.equal(health.status, "healthy");
});

test("runtime manager cleanup calls provider cleanup", async () => {
  const manager = new ExecutorRuntimeManager({ provider: provider() });
  const result = await manager.cleanup({
    externalJobId: "cube-exec-1",
    reason: "test",
    providerPayload: { sandboxId: "sbx_1" },
  });
  assert.equal(result.status, "destroyed");
});

test("executor lock is reclaimable after ttl expiry", () => {
  const now = new Date("2026-06-15T00:00:10.000Z");
  const expired = { ownerId: "old", operation: "cleanup" as const, expiresAt: "2026-06-15T00:00:00.000Z" };
  const active = { ownerId: "old", operation: "cleanup" as const, expiresAt: "2026-06-15T00:01:00.000Z" };
  assert.equal(ExecutorRuntimeManager.isLockExpired(expired, now), true);
  assert.equal(ExecutorRuntimeManager.isLockExpired(active, now), false);
});
