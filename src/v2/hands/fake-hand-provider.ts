import { randomUUID } from "node:crypto";
import type { HandBinding, HandCall, HandProvider, HandResult, HandSnapshotRef, ProvisionHandInput } from "./types.ts";

export function createFakeHandProvider(input: { providerId: string; failExecute?: boolean }): HandProvider {
  return {
    providerId: input.providerId,
    async provision(provisionInput: ProvisionHandInput): Promise<HandBinding> {
      return {
        id: `hand-${randomUUID()}`,
        providerId: input.providerId,
        runId: provisionInput.runId,
        taskId: provisionInput.taskId,
        handName: provisionInput.handName,
        status: "provisioned",
        createdAt: new Date().toISOString(),
        payload: {
          resourceKeys: Object.keys(provisionInput.resources).sort(),
          ...(provisionInput.recoveryKey ? { recoveryKey: provisionInput.recoveryKey } : {}),
        },
      };
    },
    async execute(binding: HandBinding, call: HandCall): Promise<HandResult> {
      binding.status = "running";
      if (input.failExecute) {
        binding.status = "failed";
        return { ok: false, output: `fake hand failed: ${call.name}`, metadata: { call } };
      }
      binding.status = "succeeded";
      return { ok: true, output: `fake hand executed ${call.name} ${JSON.stringify(call.input)}`, metadata: { call } };
    },
    async snapshot(binding: HandBinding): Promise<HandSnapshotRef> {
      return {
        id: `hand-snapshot-${randomUUID()}`,
        handBindingId: binding.id,
        createdAt: new Date().toISOString(),
        metadata: { providerId: binding.providerId, status: binding.status },
      };
    },
    async destroy(binding: HandBinding): Promise<void> {
      binding.status = "destroyed";
    },
    capabilities() {
      return {
        supportsSnapshot: true,
        supportsDestroy: true,
        supportsReprovision: true,
        keepsCredentialsOutOfSandbox: true,
      };
    },
  };
}
