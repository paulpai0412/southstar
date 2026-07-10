import type { SouthstarWorkflowManifest } from "../manifests/types.ts";

export type ExecutorType = "tork";

export type ExecutorSubmitRequest = {
  runId: string;
  workflow: SouthstarWorkflowManifest & { runtime?: Record<string, unknown> };
  callbackUrl?: string;
  heartbeatUrl?: string;
  liveEventUrl?: string;
  envelopeBasePath?: string;
  attemptId?: string;
};

export type ExecutorSubmitResult = {
  executorType: ExecutorType;
  externalJobId: string;
  status: string;
  projectionFingerprint?: string;
  executionProjection?: unknown;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorStatusRequest = {
  externalJobId: string;
  runId?: string;
};

export type ExecutorStatusResult = {
  executorType: ExecutorType;
  externalJobId: string;
  status: string;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorCancelRequest = {
  externalJobId: string;
  runId?: string;
  reason?: string;
};

export type ExecutorCancelResult = {
  executorType: ExecutorType;
  externalJobId: string;
  status: "cancelled" | "cancelling" | "not_supported";
  providerPayload?: Record<string, unknown>;
};

export type TorkAdapterCapabilities = {
  supportsJobInspect: boolean;
  supportsTaskInspect: boolean;
  supportsJobCancel: boolean;
  supportsTaskCancel: boolean;
  supportsJobLogs: boolean;
  supportsTaskLogs: boolean;
  supportsWorkerHealth: boolean;
};

export type TorkJobObservation = {
  jobId: string;
  status: string;
  raw?: unknown;
};

export type TorkObservationClient = {
  capabilities(): TorkAdapterCapabilities;
  getJob(jobId: string): Promise<TorkJobObservation>;
  getJobLogs(jobId: string): Promise<string>;
  cancelJob(jobId: string): Promise<void>;
};

export type ExecutorProvider = {
  readonly executorType: ExecutorType;
  submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult>;
  status?(request: ExecutorStatusRequest): Promise<ExecutorStatusResult>;
  cancel?(request: ExecutorCancelRequest): Promise<ExecutorCancelResult>;
};
