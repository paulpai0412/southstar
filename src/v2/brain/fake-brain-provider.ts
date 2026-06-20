import { randomUUID } from "node:crypto";
import type { BrainProvider, BrainSessionBinding, WakeBrainInput } from "./types.ts";

export function createFakeBrainProvider(input: { providerId: string; failWake?: boolean }): BrainProvider {
  return {
    providerId: input.providerId,
    async wake(wakeInput: WakeBrainInput): Promise<BrainSessionBinding> {
      if (input.failWake) throw new Error(`fake brain wake failed: ${input.providerId}`);
      return {
        id: `brain-${randomUUID()}`,
        providerId: input.providerId,
        runId: wakeInput.runId,
        taskId: wakeInput.taskId,
        sessionId: wakeInput.sessionId,
        contextPacketId: wakeInput.contextPacketId,
        status: "running",
        createdAt: new Date().toISOString(),
        payload: { effortPolicy: wakeInput.effortPolicy },
      };
    },
    async cancel(binding: BrainSessionBinding): Promise<void> {
      binding.status = "cancelled";
    },
    capabilities() {
      return {
        supportsWakeFromSession: true,
        supportsCancel: true,
        supportsSteering: true,
        supportsNativeRewind: false,
      };
    },
  };
}
