import test from "node:test";
import assert from "node:assert/strict";
import { loadCubeSandboxRealE2EEnv } from "./env.ts";
import { assertCubeSandboxExceptionGates } from "./quantitative-gates.ts";
import { runCubeSandboxRealHappyPath } from "./scenarios/cubesandbox-real-happy-path.ts";
import { runCubeSandboxRealTimeoutCleanup } from "./scenarios/cubesandbox-real-timeout-cleanup.ts";
import { runCubeSandboxRealCallbackMissing } from "./scenarios/cubesandbox-real-callback-missing.ts";
import { runCubeSandboxRealOrphanReconcile } from "./scenarios/cubesandbox-real-orphan-reconcile.ts";

const runReal = process.env.SOUTHSTAR_CUBESANDBOX_E2E === "1";

test("CubeSandbox real E2E env requires real config", () => {
  assert.throws(() => loadCubeSandboxRealE2EEnv({}), /SOUTHSTAR_CUBESANDBOX_E2E=1/);
});

test("CubeSandbox real provider creates command and leaves zero managed residue", { skip: !runReal }, async () => {
  const env = loadCubeSandboxRealE2EEnv();
  const result = await runCubeSandboxRealHappyPath(env);
  assert.equal(result.managedResidueCount, 0);
});

test("CubeSandbox real exception handling cleans timeout callback-missing and orphan resources", { skip: !runReal }, async () => {
  const env = loadCubeSandboxRealE2EEnv();
  const timeout = await runCubeSandboxRealTimeoutCleanup(env);
  const callbackMissing = await runCubeSandboxRealCallbackMissing(env);
  const orphan = await runCubeSandboxRealOrphanReconcile(env);

  const gates = assertCubeSandboxExceptionGates({
    timeoutDetectionMs: timeout.timeoutDetectionMs,
    timeoutDestroyMs: timeout.timeoutDestroyMs,
    callbackMissingDetectionMs: callbackMissing.callbackMissingDetectionMs,
    orphanDetectionMs: orphan.orphanDetectionMs,
    orphanDestroyMs: orphan.orphanDestroyMs,
    managedResidueCount: orphan.managedResidueCount,
  });
  assert.equal(gates.ok, true, gates.failures.join("\n"));
});
