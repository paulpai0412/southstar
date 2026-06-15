import assert from "node:assert/strict";
import { join } from "node:path";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { createCubeSandboxRealContext, ensureCubeSandboxApiReachable, pollUntil, writeEvidenceJson } from "./harness.ts";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export async function runCubeSandboxRealCallbackMissing(env: CubeSandboxRealE2EEnv) {
  const context = createCubeSandboxRealContext(env);
  await ensureCubeSandboxApiReachable(context);
  await context.executorManager.initialize();

  const callbackWaitTimeoutMs = context.config.executor.lifecycle.callbackWaitTimeoutSeconds * 1_000;
  if (callbackWaitTimeoutMs > 45_000) {
    throw new Error(
      `callback-missing scenario requires executor.lifecycle.callback_wait_timeout_seconds <= 45; got ${context.config.executor.lifecycle.callbackWaitTimeoutSeconds}`,
    );
  }

  const submission = await context.executorManager.submit({
    runId: `cube-callback-missing-${Date.now()}`,
    attemptId: "attempt-callback-missing",
    workflow: { tasks: [{ id: "task-callback-missing" }] } as never,
    callbackUrl: "http://127.0.0.1:1/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
  });

  const terminal = await pollUntil(
    async () => await context.executorManager.provider.status?.({
      externalJobId: submission.externalJobId,
      providerPayload: submission.providerPayload,
    }),
    {
      timeoutMs: 5 * 60_000,
      intervalMs: 2_000,
      stop: (value) => Boolean(value && TERMINAL_STATUSES.has(String(value.status))),
      description: "terminal executor status for callback-missing scenario",
    },
  );

  const detectionStartedAt = performance.now();
  await sleep(callbackWaitTimeoutMs);
  const callbackMissingDetectionMs = performance.now() - detectionStartedAt;

  assert.notEqual(terminal.value?.status, "completed", "executor terminal status without callback should not represent workflow completion");

  const cleanup = await context.executorManager.cleanup({
    externalJobId: submission.externalJobId,
    reason: "callback-missing-cleanup",
    providerPayload: submission.providerPayload,
  });

  writeEvidenceJson(join(env.evidenceDir, "callback-missing.json"), {
    callbackWaitTimeoutMs,
    callbackMissingDetectionMs,
    terminalStatus: terminal.value,
    cleanup,
    checkedAt: new Date().toISOString(),
  });

  return { callbackMissingDetectionMs };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
