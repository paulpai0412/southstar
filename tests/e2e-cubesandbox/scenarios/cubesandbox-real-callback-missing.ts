import assert from "node:assert/strict";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { createCubeSandboxRealContext } from "./harness.ts";

export async function runCubeSandboxRealCallbackMissing(env: CubeSandboxRealE2EEnv) {
  const context = createCubeSandboxRealContext(env);
  await context.executorManager.initialize();
  const submission = await context.executorManager.submit({
    runId: `cube-callback-missing-${Date.now()}`,
    attemptId: "attempt-callback-missing",
    workflow: { tasks: [{ id: "task-callback-missing" }] } as never,
    callbackUrl: "http://127.0.0.1:1/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
  });

  const startedAt = Date.now();
  const status = await context.executorManager.provider.status?.({
    externalJobId: submission.externalJobId,
    providerPayload: submission.providerPayload,
  });
  const callbackMissingDetectionMs = Date.now() - startedAt;

  assert.notEqual(status?.status, "completed", "executor status alone must not complete callback-missing flow");

  await context.executorManager.cleanup({
    externalJobId: submission.externalJobId,
    reason: "callback-missing-cleanup",
    providerPayload: submission.providerPayload,
  });

  return { callbackMissingDetectionMs };
}
