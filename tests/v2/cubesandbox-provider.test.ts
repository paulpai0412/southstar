import test from "node:test";
import assert from "node:assert/strict";
import { CubeSandboxExecutorProvider } from "../../src/v2/executor/cubesandbox/provider.ts";
import type { CubeSandboxSdkClient } from "../../src/v2/executor/cubesandbox/types.ts";

function client(): CubeSandboxSdkClient & { destroyed: string[] } {
  return {
    destroyed: [],
    async health() {},
    async createSandbox(input) {
      assert.equal(input.metadata.managedBy, "southstar");
      assert.equal(input.templateId, "tmpl");
      return { sandboxId: "sbx_1" };
    },
    async runCommand(input) {
      assert.equal(input.sandboxId, "sbx_1");
      assert.equal(input.command.includes("southstar-agent-runner"), true);
      return { commandId: "cmd_1" };
    },
    async getSandbox() {
      return { sandboxId: "sbx_1", status: "running" };
    },
    async getCommand() {
      return { commandId: "cmd_1", status: "running" };
    },
    async killCommand() {},
    async destroySandbox(input) {
      this.destroyed.push(input.sandboxId);
    },
    async listSandboxes() {
      return [];
    },
    async logs() {
      return { text: "progress" };
    },
  };
}

const lifecycle = {
  cleanupMode: "strict" as const,
  healthCheckIntervalSeconds: 10,
  reconcileIntervalSeconds: 30,
  orphanScanIntervalSeconds: 30,
  orphanGraceSeconds: 60,
  shutdownGraceSeconds: 20,
  maxRestartAttempts: 3,
  maxCleanupAttempts: 5,
  sdkCallTimeoutSeconds: 15,
  sandboxCreateTimeoutSeconds: 60,
  commandStartTimeoutSeconds: 30,
  commandIdleTimeoutSeconds: 120,
  taskWallTimeoutSeconds: 1800,
  callbackWaitTimeoutSeconds: 30,
  destroyTimeoutSeconds: 20,
  lockTtlSeconds: 60,
};

test("CubeSandbox provider creates sandbox and starts agent runner", async () => {
  const sdk = client();
  const provider = new CubeSandboxExecutorProvider({
    lifecycle,
    sdkClient: sdk,
    config: {
      sdk: "e2b-compatible",
      apiUrl: "http://cube",
      apiKeyRef: "ref",
      templateId: "tmpl",
      defaultTimeoutSeconds: 900,
      destroyOnCompletion: true,
      hostMounts: [{ source: ".southstar/runs", target: "/southstar-runs", readonly: false }],
    },
  });
  const result = await provider.submit({
    runId: "run-1",
    workflow: {
      tasks: [{ id: "task-1" }],
    } as never,
    callbackUrl: "http://southstar/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
    attemptId: "attempt-1",
  });

  assert.equal(result.executorType, "cubesandbox");
  assert.equal(result.externalJobId, "cube-exec-run-1-attempt-1");
  assert.equal(result.providerPayload?.sandboxId, "sbx_1");
  assert.equal(result.providerPayload?.commandId, "cmd_1");
  assert.equal(typeof (result.providerPayload?.timings as { sandboxCreateMs?: unknown } | undefined)?.sandboxCreateMs, "number");
  assert.equal(typeof (result.providerPayload?.timings as { commandStartMs?: unknown } | undefined)?.commandStartMs, "number");

  const status = await provider.status?.({
    externalJobId: result.externalJobId,
    providerPayload: result.providerPayload,
  });
  assert.equal(status?.status, "running");

  const cancelled = await provider.cancel?.({
    externalJobId: result.externalJobId,
    providerPayload: result.providerPayload,
  });
  assert.equal(cancelled?.status, "cancelled");
  assert.deepEqual(sdk.destroyed, ["sbx_1"]);
  assert.equal((cancelled?.providerPayload?.cleanup as { attempts?: number } | undefined)?.attempts, 1);
  assert.equal((cancelled?.providerPayload?.cleanup as { finalizerStatus?: string } | undefined)?.finalizerStatus, "destroyed");
});

test("CubeSandbox provider cleanup increments finalizer attempts and records retry", async () => {
  const sdk = client();
  let shouldFail = true;
  sdk.destroySandbox = async (input) => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error(`destroy failed for ${input.sandboxId}`);
    }
    sdk.destroyed.push(input.sandboxId);
  };

  const provider = new CubeSandboxExecutorProvider({
    lifecycle,
    sdkClient: sdk,
    config: {
      sdk: "e2b-compatible",
      apiUrl: "http://cube",
      apiKeyRef: "ref",
      templateId: "tmpl",
      defaultTimeoutSeconds: 900,
      destroyOnCompletion: true,
      hostMounts: [{ source: ".southstar/runs", target: "/southstar-runs", readonly: false }],
    },
  });

  const retry = await provider.cleanup?.({
    externalJobId: "cube-exec-1",
    reason: "test-retry",
    providerPayload: {
      sandboxId: "sbx_1",
      cleanup: { required: true, destroyOnCompletion: true, attempts: 0, finalizerStatus: "pending" },
    },
  });
  assert.equal(retry?.status, "retry_scheduled");
  assert.equal((retry?.providerPayload?.cleanup as { attempts?: number } | undefined)?.attempts, 1);
  assert.equal((retry?.providerPayload?.cleanup as { finalizerStatus?: string } | undefined)?.finalizerStatus, "retry_scheduled");

  const destroyed = await provider.cleanup?.({
    externalJobId: "cube-exec-1",
    reason: "test-destroy",
    providerPayload: {
      sandboxId: "sbx_1",
      cleanup: retry?.providerPayload?.cleanup,
    },
  });
  assert.equal(destroyed?.status, "destroyed");
  assert.equal((destroyed?.providerPayload?.cleanup as { attempts?: number } | undefined)?.attempts, 2);
  assert.equal((destroyed?.providerPayload?.cleanup as { finalizerStatus?: string } | undefined)?.finalizerStatus, "destroyed");
});

test("CubeSandbox provider reconcile destroys managed orphan sandboxes", async () => {
  const sdk = client();
  sdk.listSandboxes = async () => [
    { sandboxId: "sbx_orphan_1", status: "running" },
    { sandboxId: "sbx_orphan_2", status: "running" },
  ];
  const provider = new CubeSandboxExecutorProvider({
    lifecycle,
    sdkClient: sdk,
    config: {
      sdk: "e2b-compatible",
      apiUrl: "http://cube",
      apiKeyRef: "ref",
      templateId: "tmpl",
      defaultTimeoutSeconds: 900,
      destroyOnCompletion: true,
      hostMounts: [{ source: ".southstar/runs", target: "/southstar-runs", readonly: false }],
    },
  });

  const reconciled = await provider.reconcile?.({ reason: "orphan-scan" });
  assert.equal(reconciled?.reconciled, 2);
  assert.equal(reconciled?.cleaned, 2);
  assert.deepEqual(sdk.destroyed, ["sbx_orphan_1", "sbx_orphan_2"]);
  assert.equal((reconciled?.providerPayload as { managedResidueCount?: number } | undefined)?.managedResidueCount, 0);
});
