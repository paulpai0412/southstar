import assert from "node:assert/strict";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { assertCubeSandboxRealE2EGates } from "../quantitative-gates.ts";
import { createCubeSandboxRealContext } from "./harness.ts";

export async function runCubeSandboxRealHappyPath(env: CubeSandboxRealE2EEnv) {
  const configStartedAt = Date.now();
  const context = createCubeSandboxRealContext(env);
  const configLoadMs = Date.now() - configStartedAt;

  const initStartedAt = Date.now();
  await context.executorManager.initialize();
  const health = await context.executorManager.health();
  const providerInitMs = Date.now() - initStartedAt;
  assert.equal(health.status, "healthy", health.message);

  const submitStartedAt = Date.now();
  const submission = await context.executorManager.submit({
    runId: `cube-real-${Date.now()}`,
    attemptId: "attempt-1",
    workflow: { tasks: [{ id: "task-real-e2e" }] } as never,
    callbackUrl: "http://127.0.0.1:1/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
  });
  const sandboxCreateMs = Date.now() - submitStartedAt;
  assert.equal(submission.executorType, "cubesandbox");

  const cleanupStartedAt = Date.now();
  const cleanup = await context.executorManager.cleanup({
    externalJobId: submission.externalJobId,
    reason: "real-e2e-cleanup",
    providerPayload: submission.providerPayload,
  });
  const sandboxDestroyMs = Date.now() - cleanupStartedAt;
  assert.equal(cleanup.status, "destroyed");

  const reconcile = await context.executorManager.reconcile({ reason: "residue-check", runId: undefined });
  const managedResidueCount = Number((reconcile.providerPayload as { managedResidueCount?: number } | undefined)?.managedResidueCount ?? 0);

  const gates = assertCubeSandboxRealE2EGates({
    configLoadMs,
    providerInitMs,
    sandboxCreateMs,
    commandStartMs: 0,
    firstProgressMs: 0,
    callbackAcceptedAfterExitMs: 0,
    runTerminalMs: sandboxCreateMs,
    cleanupStartAfterTerminalMs: 0,
    sandboxDestroyMs,
    managedResidueCount,
    cleanupFailures: 0,
  });
  assert.equal(gates.ok, true, gates.failures.join("\n"));

  return {
    submission,
    sandboxCreateMs,
    sandboxDestroyMs,
    managedResidueCount,
  };
}
