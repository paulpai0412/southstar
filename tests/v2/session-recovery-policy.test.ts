import test from "node:test";
import assert from "node:assert/strict";
import { classifyRecoveryStrategy } from "../../src/v2/session-recovery/policy.ts";

test("missing artifact fields classify as compact retry", () => {
  assert.deepEqual(classifyRecoveryStrategy({
    taskId: "checker",
    artifactStatus: "needs_repair",
    missingFields: ["testResults"],
    validatorFindings: [],
    retryCount: 0,
    maxRetryAttempts: 2,
    workspaceDirty: false,
    checkerRejectedApproach: false,
    executorIssue: "none",
  }), {
    strategy: "retry-same-agent",
    authorizationMode: "auto",
    reason: "Artifact is repairable: missing testResults.",
    policyReasons: ["artifact_needs_repair", "retry_budget_available"],
  });
});

test("checker rejection classifies as fork", () => {
  assert.equal(classifyRecoveryStrategy({
    taskId: "checker",
    artifactStatus: "failed",
    missingFields: [],
    validatorFindings: ["browser behavior rejected"],
    retryCount: 0,
    maxRetryAttempts: 2,
    workspaceDirty: false,
    checkerRejectedApproach: true,
    executorIssue: "none",
  }).strategy, "fork-from-checkpoint");
});

test("dirty workspace test failure classifies as workspace rollback requiring operator", () => {
  const decision = classifyRecoveryStrategy({
    taskId: "implementer",
    artifactStatus: "failed",
    missingFields: [],
    validatorFindings: ["npm test failed"],
    retryCount: 0,
    maxRetryAttempts: 2,
    workspaceDirty: true,
    checkerRejectedApproach: false,
    executorIssue: "none",
  });
  assert.equal(decision.strategy, "rollback-workspace");
  assert.equal(decision.authorizationMode, "operator-approved");
});
