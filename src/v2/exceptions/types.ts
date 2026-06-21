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

export type RuntimeObservation = RuntimeExceptionRecordInput;

export type RuntimeExceptionClassification = RuntimeExceptionRecord & {
  recoveryPath: RecoveryPath;
  operatorApprovalRequired: boolean;
  reason: string;
};

export const RECOVERY_DECISION_RESOURCE_TYPE = "recovery_decision";
export const RECOVERY_DECISION_SCHEMA_VERSION = "southstar.runtime.recovery_decision.v1";

export const RECOVERY_DECISION_STATUSES = [
  "recorded",
  "waiting_operator_approval",
  "approved",
  "applying",
  "applied",
  "blocked",
  "failed",
  "superseded",
] as const;

export type RecoveryDecisionStatus = typeof RECOVERY_DECISION_STATUSES[number];

export type RecoveryDecisionPayload = {
  schemaVersion: typeof RECOVERY_DECISION_SCHEMA_VERSION;
  decisionId: string;
  exceptionId: string;
  runId: string;
  taskId?: string;
  handExecutionId?: string;
  path: RecoveryPath;
  reason: string;
  operatorApprovalRequired: boolean;
  previousAttemptId?: string;
  nextAttemptId?: string;
  supersedes?: string[];
  evidenceRefs: string[];
  createdAt: string;
};

export type RuntimeRecoveryDecisionRecord = {
  decisionId: string;
  resourceKey: string;
  status: RecoveryDecisionStatus;
  payload: RecoveryDecisionPayload;
};

export const RECOVERY_EXECUTION_RESOURCE_TYPE = "recovery_execution";
export const RECOVERY_EXECUTION_SCHEMA_VERSION = "southstar.runtime.recovery_execution.v1";

export type RecoveryExecutionStatus = "started" | "succeeded" | "failed" | "superseded" | "blocked";
export type RecoveryProviderActionName = "poll" | "cancel" | "destroy" | "provision" | "snapshot" | "rollback" | "wake";
export type RecoveryProviderActionStatus = "requested" | "succeeded" | "failed" | "skipped";

export type RecoveryExecutionStateChange = {
  resourceType: string;
  resourceKey: string;
  fromStatus?: string;
  toStatus?: string;
  reason: string;
};

export type RecoveryExecutionProviderAction = {
  providerId: string;
  action: RecoveryProviderActionName;
  status: RecoveryProviderActionStatus;
  evidenceRef?: string;
  attemptedAt?: string;
  succeededAt?: string;
  completedAt?: string;
  errorExcerpt?: string;
  metadata?: Record<string, unknown>;
};

export type RecoveryExecutionPayload = {
  schemaVersion: typeof RECOVERY_EXECUTION_SCHEMA_VERSION;
  executionId: string;
  decisionId: string;
  exceptionId: string;
  runId: string;
  taskId?: string;
  path: RecoveryPath;
  status: RecoveryExecutionStatus;
  stateChanges: RecoveryExecutionStateChange[];
  providerActions: RecoveryExecutionProviderAction[];
  createdAt: string;
  completedAt?: string;
};

export type RecoveryExecutionRecord = {
  executionId: string;
  resourceKey: string;
  status: RecoveryExecutionStatus;
  payload: RecoveryExecutionPayload;
};
