import assert from "node:assert/strict";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { createCubeSandboxRealContext } from "./harness.ts";

export async function runCubeSandboxRealOrphanReconcile(env: CubeSandboxRealE2EEnv) {
  const context = createCubeSandboxRealContext(env);
  await context.executorManager.initialize();

  const detectStartedAt = Date.now();
  const reconcile = await context.executorManager.reconcile({ reason: "orphan-detect" });
  const orphanDetectionMs = Date.now() - detectStartedAt;

  const destroyStartedAt = Date.now();
  const shutdown = await context.executorManager.shutdown({ reason: "orphan-cleanup", graceSeconds: 20 });
  const orphanDestroyMs = Date.now() - destroyStartedAt;

  assert.equal(typeof reconcile.reconciled, "number");
  assert.equal(shutdown.status === "completed" || shutdown.status === "degraded", true);

  return {
    orphanDetectionMs,
    orphanDestroyMs,
    managedResidueCount: Number((reconcile.providerPayload as { managedResidueCount?: number } | undefined)?.managedResidueCount ?? 0),
  };
}
