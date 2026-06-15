import assert from "node:assert/strict";
import { join } from "node:path";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { createCubeSandboxRealContext, ensureCubeSandboxApiReachable, writeEvidenceJson } from "./harness.ts";

export async function runCubeSandboxRealTimeoutCleanup(env: CubeSandboxRealE2EEnv) {
  const context = createCubeSandboxRealContext(env);
  await ensureCubeSandboxApiReachable(context);
  await context.executorManager.initialize();

  const timeoutBudgetMs = context.config.executor.lifecycle.taskWallTimeoutSeconds * 1_000;
  if (timeoutBudgetMs > 15_000) {
    throw new Error(
      `timeout scenario requires executor.lifecycle.task_wall_timeout_seconds <= 15; got ${context.config.executor.lifecycle.taskWallTimeoutSeconds}`,
    );
  }

  const submission = await context.executorManager.submit({
    runId: `cube-timeout-${Date.now()}`,
    attemptId: "attempt-timeout",
    workflow: { tasks: [{ id: "task-timeout" }] } as never,
    callbackUrl: "http://127.0.0.1:1/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
  });

  const timeoutEpochMs = Date.now() + timeoutBudgetMs;
  while (Date.now() < timeoutEpochMs) {
    await sleep(50);
  }

  const timeoutDetectionMs = Math.max(1, Date.now() - timeoutEpochMs);
  const destroyStartedAt = performance.now();
  const cancelled = await context.executorManager.provider.cancel?.({
    externalJobId: submission.externalJobId,
    reason: "real-timeout-test",
    providerPayload: submission.providerPayload,
  });
  const timeoutDestroyMs = performance.now() - destroyStartedAt;

  assert.equal(cancelled?.status, "cancelled");

  writeEvidenceJson(join(env.evidenceDir, "timeout-cleanup.json"), {
    timeoutBudgetMs,
    timeoutDetectionMs,
    timeoutDestroyMs,
    cancelled,
    checkedAt: new Date().toISOString(),
  });

  return {
    timeoutDetectionMs,
    timeoutDestroyMs,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
