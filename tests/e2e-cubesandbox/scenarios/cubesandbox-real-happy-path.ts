import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExecutorStatusResult } from "../../../src/v2/executor/provider.ts";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { assertCubeSandboxRealE2EGates } from "../quantitative-gates.ts";
import {
  createCubeSandboxRealContext,
  pollUntil,
  startCallbackProbeServer,
  writeEvidenceJson,
} from "./harness.ts";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export async function runCubeSandboxRealHappyPath(env: CubeSandboxRealE2EEnv) {
  const configStartedAt = performance.now();
  const context = createCubeSandboxRealContext(env);
  const configLoadMs = performance.now() - configStartedAt;

  const initStartedAt = performance.now();
  await context.executorManager.initialize();
  const health = await context.executorManager.health();
  const providerInitMs = performance.now() - initStartedAt;
  assert.equal(health.status, "healthy", health.message);

  const callbackServer = await startCallbackProbeServer(env);
  try {
    const submitStartedAt = performance.now();
    const submission = await context.executorManager.submit({
      runId: `cube-real-${Date.now()}`,
      attemptId: "attempt-1",
      workflow: { tasks: [{ id: "task-real-e2e" }] } as never,
      callbackUrl: callbackServer.callbackUrl,
      envelopeBasePath: "/southstar-runs",
    });
    const submitCompletedAt = performance.now();
    assert.equal(submission.executorType, "cubesandbox");

    const timings = parseTimings(submission.providerPayload);
    const sandboxCreateMs = timings.sandboxCreateMs;
    const commandStartMs = timings.commandStartMs;

    const firstProgress = await pollUntil(
      async () => await context.executorManager.provider.logs?.({
        externalJobId: submission.externalJobId,
        providerPayload: submission.providerPayload,
      }),
      {
        timeoutMs: 30_000,
        intervalMs: 1_000,
        stop: (value) => Boolean(value?.text?.trim().length),
        description: "first progress log",
      },
    );

    const terminal = await pollUntil(
      async () => await context.executorManager.provider.status?.({
        externalJobId: submission.externalJobId,
        providerPayload: submission.providerPayload,
      }),
      {
        timeoutMs: 15 * 60_000,
        intervalMs: 2_000,
        stop: (value) => Boolean(value && TERMINAL_STATUSES.has(String(value.status))),
        description: "terminal executor status",
      },
    );

    const commandExitAtMs = finishedAtMs(terminal.value) ?? (submitCompletedAt + terminal.elapsedMs);
    const callback = await callbackServer.waitForCallback(30_000);
    const callbackAcceptedAfterExitMs = callback.receivedAtMs - commandExitAtMs;

    const cleanupStartAt = performance.now();
    const cleanupStartAfterTerminalMs = cleanupStartAt - (submitCompletedAt + terminal.elapsedMs);
    const cleanup = await context.executorManager.cleanup({
      externalJobId: submission.externalJobId,
      reason: "real-e2e-cleanup",
      providerPayload: submission.providerPayload,
    });
    const sandboxDestroyMs = performance.now() - cleanupStartAt;

    const reconcile = await context.executorManager.reconcile({ reason: "residue-check", runId: undefined });
    const managedResidueCount = Number((reconcile.providerPayload as { managedResidueCount?: number } | undefined)?.managedResidueCount ?? 0);
    const cleanupFailures = cleanup.status === "destroyed" ? 0 : 1;

    const gates = assertCubeSandboxRealE2EGates({
      configLoadMs,
      providerInitMs,
      sandboxCreateMs,
      commandStartMs,
      firstProgressMs: firstProgress.elapsedMs,
      callbackAcceptedAfterExitMs,
      runTerminalMs: submitCompletedAt + terminal.elapsedMs - submitStartedAt,
      cleanupStartAfterTerminalMs,
      sandboxDestroyMs,
      managedResidueCount,
      cleanupFailures,
    });
    assert.equal(gates.ok, true, gates.failures.join("\n"));

    writeEvidenceJson(join(env.evidenceDir, "happy-path.json"), {
      gateInput: {
        configLoadMs,
        providerInitMs,
        sandboxCreateMs,
        commandStartMs,
        firstProgressMs: firstProgress.elapsedMs,
        callbackAcceptedAfterExitMs,
        runTerminalMs: submitCompletedAt + terminal.elapsedMs - submitStartedAt,
        cleanupStartAfterTerminalMs,
        sandboxDestroyMs,
        managedResidueCount,
        cleanupFailures,
      },
      submission,
      terminalStatus: terminal.value,
      callbackPayload: callback.body,
      reconcile,
      cleanup,
      health,
      checkedAt: new Date().toISOString(),
    });

    return {
      submission,
      sandboxCreateMs,
      sandboxDestroyMs,
      managedResidueCount,
    };
  } finally {
    await callbackServer.close();
  }
}

function parseTimings(payload: Record<string, unknown> | undefined): { sandboxCreateMs: number; commandStartMs: number } {
  const timings = payload?.timings as { sandboxCreateMs?: unknown; commandStartMs?: unknown } | undefined;
  const sandboxCreateMs = Number(timings?.sandboxCreateMs);
  const commandStartMs = Number(timings?.commandStartMs);
  return { sandboxCreateMs, commandStartMs };
}

function finishedAtMs(status: ExecutorStatusResult | undefined): number | undefined {
  const finishedAt = status?.providerPayload?.finishedAt;
  if (typeof finishedAt !== "string") return undefined;
  const parsed = Date.parse(finishedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}
