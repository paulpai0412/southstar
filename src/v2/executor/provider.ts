import type { SouthstarWorkflowManifest } from "../manifests/types.ts";

export type ExecutorType = "tork" | "cubesandbox";
export type ExecutorLifecycleStatus = "healthy" | "degraded" | "unavailable" | "draining";

export type ExecutorBindingStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "unknown"
  | "degraded"
  | "retryable_error"
  | "callback_missing"
  | "cleanup_failed";

export type ExecutorSubmitRequest = {
  runId: string;
  workflow: SouthstarWorkflowManifest;
  callbackUrl?: string;
  envelopeBasePath?: string;
  runRoot?: string;
  attemptId?: string;
};

export type ExecutorSubmitResult = {
  executorType: ExecutorType;
  externalJobId: string;
  status: ExecutorBindingStatus | string;
  projectionFingerprint?: string;
  executionProjection?: unknown;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorStatusRequest = {
  externalJobId: string;
  runId?: string;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorStatusResult = {
  executorType: ExecutorType;
  externalJobId: string;
  status: ExecutorBindingStatus | string;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorCancelRequest = {
  externalJobId: string;
  runId?: string;
  reason?: string;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorCancelResult = {
  executorType: ExecutorType;
  externalJobId: string;
  status: "cancelled" | "cancelling" | "not_supported";
  providerPayload?: Record<string, unknown>;
};

export type ExecutorLogsRequest = {
  externalJobId: string;
  runId?: string;
  cursor?: string;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorLogsResult = {
  executorType: ExecutorType;
  externalJobId: string;
  text: string;
  cursor?: string;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorHealthResult = {
  executorType: ExecutorType;
  status: ExecutorLifecycleStatus;
  checkedAt: string;
  message?: string;
  capabilities: Record<string, boolean>;
};

export type ExecutorReconcileRequest = {
  runId?: string;
  reason: string;
};

export type ExecutorReconcileResult = {
  executorType: ExecutorType;
  reconciled: number;
  cleaned: number;
  failures: string[];
  providerPayload?: Record<string, unknown>;
};

export type ExecutorCleanupRequest = {
  externalJobId: string;
  runId?: string;
  reason: string;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorCleanupResult = {
  executorType: ExecutorType;
  externalJobId: string;
  status: "destroyed" | "retry_scheduled" | "failed" | "not_supported";
  providerPayload?: Record<string, unknown>;
};

export type ExecutorShutdownRequest = {
  reason: string;
  graceSeconds: number;
};

export type ExecutorShutdownResult = {
  executorType: ExecutorType;
  status: "completed" | "degraded";
  cleaned: number;
  failures: string[];
};

export type ExecutorProvider = {
  readonly executorType: ExecutorType;
  initialize?(): Promise<void>;
  health?(): Promise<ExecutorHealthResult>;
  submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult>;
  status?(request: ExecutorStatusRequest): Promise<ExecutorStatusResult>;
  cancel?(request: ExecutorCancelRequest): Promise<ExecutorCancelResult>;
  logs?(request: ExecutorLogsRequest): Promise<ExecutorLogsResult>;
  reconcile?(request: ExecutorReconcileRequest): Promise<ExecutorReconcileResult>;
  cleanup?(request: ExecutorCleanupRequest): Promise<ExecutorCleanupResult>;
  shutdown?(request: ExecutorShutdownRequest): Promise<ExecutorShutdownResult>;
};
