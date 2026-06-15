import assert from "node:assert/strict";
import { join } from "node:path";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { createCubeSandboxRealContext, ensureCubeSandboxApiReachable, writeEvidenceJson } from "./harness.ts";

export async function runCubeSandboxRealOrphanReconcile(env: CubeSandboxRealE2EEnv) {
  const producer = createCubeSandboxRealContext(env);
  await ensureCubeSandboxApiReachable(producer);
  await producer.executorManager.initialize();
  const orphan = await producer.executorManager.submit({
    runId: `cube-orphan-${Date.now()}`,
    attemptId: "attempt-orphan",
    workflow: { tasks: [{ id: "task-orphan" }] } as never,
    callbackUrl: "http://127.0.0.1:1/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
  });

  const reconciler = createCubeSandboxRealContext(env);
  await ensureCubeSandboxApiReachable(reconciler);
  await reconciler.executorManager.initialize();

  const startedAt = performance.now();
  const reconcile = await reconciler.executorManager.reconcile({ reason: "orphan-detect" });
  const reconcileElapsedMs = performance.now() - startedAt;

  const timingPayload = (reconcile.providerPayload as {
    managedResidueCount?: number;
    timings?: { orphanDetectionMs?: number; orphanDestroyMs?: number };
  } | undefined);

  const orphanDetectionMs = Number(timingPayload?.timings?.orphanDetectionMs ?? reconcileElapsedMs);
  const orphanDestroyMs = Number(timingPayload?.timings?.orphanDestroyMs ?? reconcileElapsedMs);
  const managedResidueCount = Number(timingPayload?.managedResidueCount ?? 0);

  assert.equal(reconcile.reconciled >= 1, true, "orphan scenario must detect at least one managed sandbox");
  assert.equal(reconcile.cleaned >= 1, true, "orphan scenario must cleanup at least one managed sandbox");

  const shutdown = await reconciler.executorManager.shutdown({ reason: "orphan-cleanup", graceSeconds: 20 });
  assert.equal(shutdown.status === "completed" || shutdown.status === "degraded", true);

  writeEvidenceJson(join(env.evidenceDir, "orphan-reconcile.json"), {
    orphanSubmission: orphan,
    reconcile,
    shutdown,
    orphanDetectionMs,
    orphanDestroyMs,
    managedResidueCount,
    checkedAt: new Date().toISOString(),
  });

  return {
    orphanDetectionMs,
    orphanDestroyMs,
    managedResidueCount,
  };
}
