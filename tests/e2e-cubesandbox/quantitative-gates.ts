export type CubeSandboxRealE2EGateInput = {
  configLoadMs: number;
  providerInitMs: number;
  sandboxCreateMs: number;
  commandStartMs: number;
  firstProgressMs: number;
  callbackAcceptedAfterExitMs: number;
  runTerminalMs: number;
  cleanupStartAfterTerminalMs: number;
  sandboxDestroyMs: number;
  managedResidueCount: number;
  cleanupFailures: number;
};

export function assertCubeSandboxRealE2EGates(input: CubeSandboxRealE2EGateInput): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  requireMax(failures, "config load + dependency build", input.configLoadMs, 1_000);
  requireMax(failures, "provider initialize + health", input.providerInitMs, 5_000);
  requireMax(failures, "sandbox create", input.sandboxCreateMs, 10_000);
  requireMax(failures, "command start", input.commandStartMs, 5_000);
  requireMax(failures, "first progress", input.firstProgressMs, 30_000);
  requireMax(failures, "callback accepted after command exit", input.callbackAcceptedAfterExitMs, 30_000);
  requireMax(failures, "happy path terminal", input.runTerminalMs, 15 * 60_000);
  requireMax(failures, "cleanup start after terminal", input.cleanupStartAfterTerminalMs, 5_000);
  requireMax(failures, "sandbox destroy", input.sandboxDestroyMs, 30_000);
  requireEqual(failures, "managed residue count", input.managedResidueCount, 0);
  requireEqual(failures, "cleanup failures", input.cleanupFailures, 0);
  return { ok: failures.length === 0, failures };
}

export type CubeSandboxExceptionGateInput = {
  timeoutDetectionMs: number;
  timeoutDestroyMs: number;
  callbackMissingDetectionMs: number;
  orphanDetectionMs: number;
  orphanDestroyMs: number;
  managedResidueCount: number;
};

export function assertCubeSandboxExceptionGates(input: CubeSandboxExceptionGateInput): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  requireMax(failures, "timeout detection", input.timeoutDetectionMs, 20_000);
  requireMax(failures, "timeout destroy", input.timeoutDestroyMs, 30_000);
  requireMax(failures, "callback missing detection", input.callbackMissingDetectionMs, 45_000);
  requireMax(failures, "orphan detection", input.orphanDetectionMs, 60_000);
  requireMax(failures, "orphan destroy", input.orphanDestroyMs, 30_000);
  requireEqual(failures, "managed residue count", input.managedResidueCount, 0);
  return { ok: failures.length === 0, failures };
}

function requireMax(failures: string[], label: string, actual: number, max: number): void {
  if (!Number.isFinite(actual) || actual > max) {
    failures.push(`${label} ${actual}ms exceeds ${max}ms`);
  }
}

function requireEqual(failures: string[], label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    failures.push(`${label} expected ${expected}, got ${actual}`);
  }
}
