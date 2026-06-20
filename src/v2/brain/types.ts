import type { BindingStatus } from "../meta-harness/types.ts";

export type BrainCapabilities = {
  supportsWakeFromSession: boolean;
  supportsCancel: boolean;
  supportsSteering: boolean;
  supportsNativeRewind: boolean;
};

export type WakeBrainInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  contextPacketId: string;
  recoveryKey?: string;
  effortPolicy: {
    complexity: "simple" | "standard" | "broad" | "deep";
    maxToolCallsPerTask: number;
  };
};

export type BrainSessionBinding = {
  id: string;
  providerId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  contextPacketId: string;
  status: BindingStatus;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type BrainProvider = {
  providerId: string;
  wake(input: WakeBrainInput): Promise<BrainSessionBinding>;
  cancel(binding: BrainSessionBinding): Promise<void>;
  capabilities(): BrainCapabilities;
};
