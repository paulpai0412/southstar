import test from "node:test";
import assert from "node:assert/strict";
import {
  isRecoveryStrategy,
  recoveryStrategies,
  validateSessionCheckpoint,
  validateRecoveryDecision,
  validateSessionOperation,
} from "../../src/v2/session-recovery/types.ts";

test("session recovery strategies are explicit and stable", () => {
  assert.deepEqual(recoveryStrategies, [
    "retry-same-agent",
    "fork-from-checkpoint",
    "reset-from-checkpoint",
    "host-native-rewind",
    "rollback-workspace",
    "request-workflow-revision",
    "ask-human",
  ]);
  assert.equal(isRecoveryStrategy("fork-from-checkpoint"), true);
  assert.equal(isRecoveryStrategy("unknown"), false);
});

test("checkpoint validation rejects missing compact summary", () => {
  assert.throws(() => validateSessionCheckpoint({
    schemaVersion: "southstar.session-checkpoint.v1",
    checkpointId: "chk-1",
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    kind: "before-recovery",
    createdBy: "orchestrator",
    artifactRefs: [],
    evidencePacketRefs: [],
    validatorResultRefs: [],
    summaries: {
      checkpointSummary: "",
      decisions: [],
      filesTouched: [],
      filesInspected: [],
    },
    tokenTelemetry: { contextTokenEstimate: 10, checkpointSummaryTokenEstimate: 0 },
    policy: {
      safeForAutoRetry: true,
      safeForFork: true,
      safeForReset: true,
      safeForWorkspaceRollback: false,
    },
  }), /checkpointSummary is required/);
});

test("recovery decision validation requires before-recovery checkpoint", () => {
  assert.throws(() => validateRecoveryDecision({
    schemaVersion: "southstar.recovery-decision.v1",
    decisionId: "decision-1",
    runId: "run-1",
    taskId: "task-1",
    source: "evaluator",
    requestedStrategy: "retry-same-agent",
    selectedStrategy: "retry-same-agent",
    beforeRecoveryCheckpointId: "",
    reason: "missing evidence",
    evaluatorFindingRefs: [],
    authorization: { mode: "auto", policyReasons: ["repairable artifact"] },
    execution: { status: "queued" },
    tokenTelemetry: {},
  }), /beforeRecoveryCheckpointId is required/);
});

test("session operation validation rejects failed operation without error", () => {
  assert.throws(() => validateSessionOperation({
    operationId: "op-1",
    runId: "run-1",
    taskId: "task-1",
    type: "rewind",
    baseCheckpointId: "chk-1",
    host: "pi",
    status: "failed",
    fallbackUsed: true,
  }), /failed session operation requires error/);
});
