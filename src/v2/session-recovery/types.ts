export const recoveryStrategies = [
  "retry-same-agent",
  "fork-from-checkpoint",
  "reset-from-checkpoint",
  "host-native-rewind",
  "rollback-workspace",
  "request-workflow-revision",
  "ask-human",
] as const;

export type RecoveryStrategy = typeof recoveryStrategies[number];

export function isRecoveryStrategy(value: unknown): value is RecoveryStrategy {
  return typeof value === "string" && (recoveryStrategies as readonly string[]).includes(value);
}

export type SessionCheckpointV1 = {
  schemaVersion: "southstar.session-checkpoint.v1";
  checkpointId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  kind: "task-start" | "artifact-accepted" | "before-recovery" | "manual";
  createdBy: "orchestrator" | "evaluator" | "operator" | "root-session";
  contextPacketId?: string;
  taskEnvelopeId?: string;
  artifactRefs: string[];
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
  workspaceSnapshotRef?: string;
  hostSessionAnchor?: {
    host: "pi" | "codex" | "claude-code" | "custom";
    rootSessionId?: string;
    streamSessionId?: string;
    providerCheckpointId?: string;
    rewindSupported?: boolean;
  };
  summaries: {
    checkpointSummary: string;
    decisions: string[];
    filesTouched: string[];
    filesInspected: string[];
    failureSummary?: string;
    attemptedApproach?: string;
    nextAttemptHint?: string;
  };
  tokenTelemetry: {
    contextTokenEstimate: number;
    checkpointSummaryTokenEstimate: number;
    failureSuffixTokenEstimate?: number;
  };
  policy: {
    safeForAutoRetry: boolean;
    safeForFork: boolean;
    safeForReset: boolean;
    safeForWorkspaceRollback: boolean;
  };
};

export type RecoveryDecisionV1 = {
  schemaVersion: "southstar.recovery-decision.v1";
  decisionId: string;
  runId: string;
  taskId: string;
  source: "evaluator" | "operator" | "executor-observation" | "agent-suggestion";
  requestedStrategy: RecoveryStrategy;
  selectedStrategy: RecoveryStrategy;
  baseCheckpointId?: string;
  beforeRecoveryCheckpointId: string;
  reason: string;
  evaluatorFindingRefs: string[];
  agentSuggestion?: {
    strategy: string;
    confidence?: "low" | "medium" | "high";
    reason: string;
  };
  authorization: {
    mode: "auto" | "operator-approved" | "blocked";
    approvalRef?: string;
    policyReasons: string[];
  };
  execution: {
    status: "queued" | "running" | "succeeded" | "failed" | "fallback-used";
    hostPath?: "pi-native" | "southstar-native";
    fallbackReason?: string;
    newSessionId?: string;
    newTaskEnvelopeId?: string;
  };
  tokenTelemetry: {
    originalContextTokenEstimate?: number;
    rebuiltContextTokenEstimate?: number;
    omittedFailureSuffixEstimate?: number;
    estimatedSavings?: number;
  };
};

export type SessionOperationV1 = {
  operationId: string;
  runId: string;
  taskId: string;
  type: "fork" | "reset" | "rewind" | "replay";
  baseCheckpointId: string;
  oldSessionId?: string;
  newSessionId?: string;
  host: "pi" | "southstar-native";
  status: "queued" | "succeeded" | "failed";
  fallbackUsed: boolean;
  error?: string;
};

export function validateSessionCheckpoint(value: SessionCheckpointV1): SessionCheckpointV1 {
  requireString(value.checkpointId, "checkpointId");
  requireString(value.runId, "runId");
  requireString(value.taskId, "taskId");
  requireString(value.sessionId, "sessionId");
  requireString(value.summaries.checkpointSummary, "checkpointSummary");
  if (!Number.isFinite(value.tokenTelemetry.contextTokenEstimate)) {
    throw new Error("contextTokenEstimate must be finite");
  }
  if (!Number.isFinite(value.tokenTelemetry.checkpointSummaryTokenEstimate)) {
    throw new Error("checkpointSummaryTokenEstimate must be finite");
  }
  return value;
}

export function validateRecoveryDecision(value: RecoveryDecisionV1): RecoveryDecisionV1 {
  requireString(value.decisionId, "decisionId");
  requireString(value.runId, "runId");
  requireString(value.taskId, "taskId");
  requireString(value.beforeRecoveryCheckpointId, "beforeRecoveryCheckpointId");
  requireString(value.reason, "reason");
  if (!isRecoveryStrategy(value.requestedStrategy)) {
    throw new Error(`unknown requestedStrategy: ${String(value.requestedStrategy)}`);
  }
  if (!isRecoveryStrategy(value.selectedStrategy)) {
    throw new Error(`unknown selectedStrategy: ${String(value.selectedStrategy)}`);
  }
  return value;
}

export function validateSessionOperation(value: SessionOperationV1): SessionOperationV1 {
  requireString(value.operationId, "operationId");
  requireString(value.runId, "runId");
  requireString(value.taskId, "taskId");
  requireString(value.baseCheckpointId, "baseCheckpointId");
  if (value.status === "failed" && !value.error) {
    throw new Error("failed session operation requires error");
  }
  return value;
}

function requireString(value: string | undefined, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}
