import { randomUUID } from "node:crypto";
import type { BrainProvider, BrainSessionBinding, WakeBrainInput } from "./types.ts";

export function createPiBrainProvider(input: { providerId?: string } = {}): BrainProvider {
  const providerId = input.providerId ?? "pi";
  return {
    providerId,
    async wake(wakeInput: WakeBrainInput): Promise<BrainSessionBinding> {
      return {
        id: `brain-${randomUUID()}`,
        providerId,
        runId: wakeInput.runId,
        taskId: wakeInput.taskId,
        sessionId: wakeInput.sessionId,
        contextPacketId: wakeInput.contextPacketId,
        status: "running",
        createdAt: new Date().toISOString(),
        payload: {
          adapter: "pi",
          contextPacketId: wakeInput.contextPacketId,
          note: "Pi SDK execution remains delegated through existing task envelope and harness path until scheduler dispatch is wired.",
        },
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
