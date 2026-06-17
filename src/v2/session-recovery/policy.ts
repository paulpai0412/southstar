import type { RecoveryStrategy } from "./types.ts";

export type RecoveryPolicyInput = {
  taskId: string;
  artifactStatus: "accepted" | "needs_repair" | "rejected" | "failed" | "missing";
  missingFields: string[];
  validatorFindings: string[];
  retryCount: number;
  maxRetryAttempts: number;
  workspaceDirty: boolean;
  checkerRejectedApproach: boolean;
  executorIssue: "none" | "timeout" | "callback_missing" | "orphaned";
};

export type RecoveryPolicyDecision = {
  strategy: RecoveryStrategy;
  authorizationMode: "auto" | "operator-approved" | "blocked";
  reason: string;
  policyReasons: string[];
};

export function classifyRecoveryStrategy(input: RecoveryPolicyInput): RecoveryPolicyDecision {
  if (input.executorIssue !== "none") {
    return {
      strategy: "retry-same-agent",
      authorizationMode: "auto",
      reason: `Executor issue ${input.executorIssue}; replay from checkpoint without penalizing agent output.`,
      policyReasons: ["executor_issue", input.executorIssue],
    };
  }
  if (input.workspaceDirty && input.validatorFindings.some((finding) => /test failed|npm test|browser/i.test(finding))) {
    return {
      strategy: "rollback-workspace",
      authorizationMode: "operator-approved",
      reason: "Workspace-changing attempt failed verification; rollback preview is required before retry.",
      policyReasons: ["workspace_dirty", "verification_failed"],
    };
  }
  if (input.checkerRejectedApproach) {
    return {
      strategy: "fork-from-checkpoint",
      authorizationMode: "auto",
      reason: "Checker rejected the approach; preserve old branch and fork from checkpoint.",
      policyReasons: ["checker_rejected_approach"],
    };
  }
  if ((input.artifactStatus === "needs_repair" || input.missingFields.length > 0) && input.retryCount < input.maxRetryAttempts) {
    return {
      strategy: "retry-same-agent",
      authorizationMode: "auto",
      reason: `Artifact is repairable: missing ${input.missingFields.join(", ") || "required evidence"}.`,
      policyReasons: ["artifact_needs_repair", "retry_budget_available"],
    };
  }
  if (input.retryCount >= input.maxRetryAttempts) {
    return {
      strategy: "reset-from-checkpoint",
      authorizationMode: "auto",
      reason: "Retry budget exhausted; reset from checkpoint with compact context.",
      policyReasons: ["retry_budget_exhausted"],
    };
  }
  return {
    strategy: "ask-human",
    authorizationMode: "blocked",
    reason: "No safe automatic recovery strategy matched the failure facts.",
    policyReasons: ["no_strategy_matched"],
  };
}
