import type { RecoveryPath, RuntimeExceptionRecord } from "../exceptions/types.ts";

export type RecoveryAction =
  | { type: "release-task"; status: "pending" | "blocked" | "failed" }
  | { type: "mark-hand-execution"; status: "lost" | "superseded" }
  | { type: "create-session-checkpoint" }
  | { type: "fork-session" }
  | { type: "reset-session" }
  | { type: "reprovision-hand" }
  | { type: "wake-brain" }
  | { type: "request-artifact-repair" }
  | { type: "cancel-provider-job" }
  | { type: "observe-only" };

export type RecoveryPolicyMatch = {
  policyRef: string;
  matchedRuleId: string;
  path: RecoveryPath;
  operatorApprovalRequired: boolean;
  reason: string;
  actions: RecoveryAction[];
};

export function matchFallbackRecoveryPolicy(exception: RuntimeExceptionRecord, legacyPath: RecoveryPath): RecoveryPolicyMatch {
  if (exception.payload.kind === "dispatch_preparation_failed") {
    return {
      policyRef: "system:fallback",
      matchedRuleId: "dispatch-preparation-failed-default",
      path: legacyPath,
      operatorApprovalRequired: false,
      reason: "dispatch_preparation_failed matched system fallback policy",
      actions: [{ type: "release-task", status: "pending" }],
    };
  }

  return {
    policyRef: "system:legacy-classifier",
    matchedRuleId: `legacy-${exception.payload.kind}`,
    path: legacyPath,
    operatorApprovalRequired: legacyPath === "rollback-workspace" || legacyPath === "block-for-operator",
    reason: `${exception.payload.kind} classified for ${legacyPath}`,
    actions: legacyActionsForPath(legacyPath),
  };
}

function legacyActionsForPath(path: RecoveryPath): RecoveryAction[] {
  switch (path) {
    case "retry-same-task-new-attempt":
    case "repair-artifact":
      return [{ type: "release-task", status: "pending" }];
    case "block-for-operator":
      return [{ type: "release-task", status: "blocked" }];
    case "reprovision-hand":
      return [{ type: "reprovision-hand" }, { type: "release-task", status: "pending" }];
    case "wake-new-brain":
      return [{ type: "wake-brain" }, { type: "release-task", status: "pending" }];
    case "fork-session":
      return [{ type: "fork-session" }, { type: "release-task", status: "pending" }];
    case "reset-session":
      return [{ type: "reset-session" }, { type: "release-task", status: "pending" }];
    case "rollback-session":
      return [{ type: "release-task", status: "pending" }];
    case "rollback-workspace":
      return [{ type: "release-task", status: "blocked" }];
    case "requeue-hand-execution":
      return [{ type: "mark-hand-execution", status: "lost" }, { type: "release-task", status: "pending" }];
    case "none-observe-only":
      return [{ type: "observe-only" }];
    case "fail-task":
    case "fail-run":
      return [{ type: "release-task", status: "failed" }];
  }
}
