export const RUNTIME_EXCEPTION_RESOURCE_TYPE = "runtime_exception";
export const RUNTIME_EXCEPTION_SCHEMA_VERSION = "southstar.runtime.exception.v1";

export const RUNTIME_EXCEPTION_SOURCES = [
  "scheduler",
  "tork-observer",
  "callback",
  "heartbeat",
  "tool-proxy",
  "artifact-gate",
  "completion-gate",
  "intake",
  "operator",
] as const;

export type RuntimeExceptionSource = typeof RUNTIME_EXCEPTION_SOURCES[number];

export const RUNTIME_EXCEPTION_KINDS = [
  "tork_queue_timeout",
  "tork_running_hang",
  "tork_terminal_without_callback",
  "late_callback",
  "stale_callback",
  "callback_contract_violation",
  "artifact_rejected",
  "tool_proxy_violation",
  "brain_wake_failed",
  "hand_provision_failed",
  "hand_submit_failed",
  "scheduler_claim_stale",
  "intake_invalid",
  "completion_gate_failed",
  "provider_unreachable",
] as const;

export type RuntimeExceptionKind = typeof RUNTIME_EXCEPTION_KINDS[number];

export const RUNTIME_EXCEPTION_SEVERITIES = [
  "info",
  "warning",
  "recoverable",
  "blocking",
  "terminal",
] as const;

export type RuntimeExceptionSeverity = typeof RUNTIME_EXCEPTION_SEVERITIES[number];

export const RUNTIME_EXCEPTION_STATUSES = [
  "observed",
  "classified",
  "deciding",
  "recovering",
  "resolved",
  "blocked",
  "terminal",
] as const;

export type RuntimeExceptionStatus = typeof RUNTIME_EXCEPTION_STATUSES[number];

export type RecoveryPath =
  | "none-observe-only"
  | "requeue-hand-execution"
  | "reprovision-hand"
  | "wake-new-brain"
  | "retry-same-task-new-attempt"
  | "repair-artifact"
  | "rollback-workspace"
  | "block-for-operator"
  | "fail-task"
  | "fail-run";

export type RuntimeExceptionPayload = {
  schemaVersion: typeof RUNTIME_EXCEPTION_SCHEMA_VERSION;
  exceptionId: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  handExecutionId?: string;
  brainBindingId?: string;
  handBindingId?: string;
  source: RuntimeExceptionSource;
  kind: RuntimeExceptionKind;
  severity: RuntimeExceptionSeverity;
  status: RuntimeExceptionStatus;
  observedAt: string;
  classifiedAt?: string;
  resolvedAt?: string;
  resolvedReason?: string;
  evidenceRefs: string[];
  providerEvidence?: Record<string, unknown>;
  retryBudgetRef?: string;
  recoveryDecisionRef?: string;
};

export type RuntimeExceptionRecordInput = Omit<RuntimeExceptionPayload, "schemaVersion" | "exceptionId" | "status"> & {
  exceptionId?: string;
  status?: RuntimeExceptionStatus;
};

export type RuntimeExceptionRecord = {
  id: string;
  exceptionId: string;
  resourceKey: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  scope: string;
  status: RuntimeExceptionStatus;
  payload: RuntimeExceptionPayload;
  createdAt: string;
  updatedAt: string;
};
