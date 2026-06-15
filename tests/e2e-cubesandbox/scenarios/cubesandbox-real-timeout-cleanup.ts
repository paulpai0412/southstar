import assert from "node:assert/strict";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { createCubeSandboxRealContext } from "./harness.ts";

export async function runCubeSandboxRealTimeoutCleanup(env: CubeSandboxRealE2EEnv) {
  const context = createCubeSandboxRealContext(env);
  await context.executorManager.initialize();
  const submission = await context.executorManager.submit({
    runId: `cube-timeout-${Date.now()}`,
    attemptId: "attempt-timeout",
    workflow: { tasks: [{ id: "task-timeout" }] } as never,
    callbackUrl: "http://127.0.0.1:1/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
  });

  const timeoutDetectedAt = Date.now();
  const cancelled = await context.executorManager.provider.cancel?.({
    externalJobId: submission.externalJobId,
    reason: "real-timeout-test",
    providerPayload: submission.providerPayload,
  });
  const timeoutDestroyMs = Date.now() - timeoutDetectedAt;

  assert.equal(cancelled?.status, "cancelled");
  return {
    timeoutDetectionMs: 0,
    timeoutDestroyMs,
  };
}
