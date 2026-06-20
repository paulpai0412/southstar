import type { BindingStatus } from "../meta-harness/types.ts";

export type HandCapabilities = {
  supportsSnapshot: boolean;
  supportsDestroy: boolean;
  supportsReprovision: boolean;
  keepsCredentialsOutOfSandbox: boolean;
};

export type ProvisionHandInput = {
  runId: string;
  taskId: string;
  handName: string;
  resources: Record<string, unknown>;
};

export type HandBinding = {
  id: string;
  providerId: string;
  runId: string;
  taskId: string;
  handName: string;
  status: BindingStatus;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type HandCall = {
  name: string;
  input: Record<string, unknown>;
};

export type HandResult = {
  ok: boolean;
  output: string;
  metadata: Record<string, unknown>;
};

export type HandSnapshotRef = {
  id: string;
  handBindingId: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type HandProvider = {
  providerId: string;
  provision(input: ProvisionHandInput): Promise<HandBinding>;
  execute(binding: HandBinding, call: HandCall): Promise<HandResult>;
  snapshot(binding: HandBinding): Promise<HandSnapshotRef>;
  destroy(binding: HandBinding): Promise<void>;
  capabilities(): HandCapabilities;
};
