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
  recoveryKey?: string;
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

export type TaskExecutionIntent = {
  schemaVersion: "southstar.brain.task_execution_intent.v1";
  runId: string;
  taskId: string;
  sessionId: string;
  contextPacketId: string;
  attemptId: string;
  expectedArtifactContracts: string[];
  allowedToolNames: string[];
  toolProxyPolicyRef: string;
  handProviderId: "tork" | string;
  executionMode: "single_task";
  instructionsRef: string;
  inputArtifactRefs: string[];
};

export type ExecuteTaskInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  brainBindingId: string;
  handBindingId: string;
  intent: TaskExecutionIntent;
  contextPacketRef: string;
  acceptedInputArtifactRefs: string[];
  toolProxyPolicyRef: string;
  workflow: unknown;
  queueTimeoutSeconds: number;
  heartbeatTimeoutSeconds: number;
  callbackUrl?: string;
  heartbeatUrl?: string;
  envelopeBasePath?: string;
};

export type HandExecutionPayload = {
  schemaVersion: "southstar.runtime.hand_execution.v1";
  handExecutionId: string;
  providerId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  brainBindingId: string;
  handBindingId: string;
  externalJobId?: string;
  status: "queued" | "running" | "completed" | "failed" | "lost" | "superseded" | "cancelled";
  queuedAt: string;
  queueTimeoutSeconds: number;
  heartbeatTimeoutSeconds: number;
  startedAt?: string;
  terminalAt?: string;
  previousAttemptId?: string;
  supersededBy?: string;
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
  executeTask?(binding: HandBinding, input: ExecuteTaskInput): Promise<HandResult>;
  snapshot(binding: HandBinding): Promise<HandSnapshotRef>;
  destroy(binding: HandBinding): Promise<void>;
  capabilities(): HandCapabilities;
};
