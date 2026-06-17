import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { createSessionCheckpoint } from "../../src/v2/session-recovery/checkpoints.ts";
import { commitRecoveryDecision, recordSessionOperation } from "../../src/v2/session-recovery/operations.ts";

test("commits recovery decision with before-recovery checkpoint", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-op"));
  const checkpoint = createSessionCheckpoint(db, {
    runId: "run-op",
    taskId: "checker",
    sessionId: "session-checker",
    kind: "before-recovery",
    createdBy: "evaluator",
    checkpointSummary: "Checker rejected missing browser evidence.",
    failureSummary: "No browser behavior evidence.",
    contextTokenEstimate: 1000,
    policy: { safeForFork: true },
  });

  const decision = commitRecoveryDecision(db, {
    runId: "run-op",
    taskId: "checker",
    source: "evaluator",
    requestedStrategy: "fork-from-checkpoint",
    selectedStrategy: "fork-from-checkpoint",
    beforeRecoveryCheckpointId: checkpoint.checkpointId,
    baseCheckpointId: checkpoint.checkpointId,
    reason: "checker rejected approach",
    evaluatorFindingRefs: ["validator-1"],
    authorization: { mode: "auto", policyReasons: ["checker_rejected_approach"] },
    tokenTelemetry: { originalContextTokenEstimate: 1000, rebuiltContextTokenEstimate: 350, estimatedSavings: 650 },
  });

  assert.equal(decision.selectedStrategy, "fork-from-checkpoint");
  assert.equal(listResources(db, { resourceType: "recovery_decision" }).length, 1);
});

test("records failed Pi session operation with fallback flag", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-pi-fallback"));

  const op = recordSessionOperation(db, {
    runId: "run-pi-fallback",
    taskId: "checker",
    type: "rewind",
    baseCheckpointId: "checkpoint-1",
    oldSessionId: "session-old",
    host: "pi",
    status: "failed",
    fallbackUsed: true,
    error: "Pi rewind unsupported",
  });

  assert.equal(op.fallbackUsed, true);
  assert.equal(listResources(db, { resourceType: "session_operation" }).length, 1);
});

function run(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "todo-web feature",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: "wf",
      tasks: [],
      harnessDefinitions: [],
      evaluators: [],
      memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: false },
      vaultPolicy: { leaseTtlSeconds: 0, mountMode: "ephemeral-file" },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: { firstEventWithinSeconds: 1, minEventsPerLongTask: 1 },
      steeringPolicy: { enabled: true, acceptedSignals: [] },
      learningPolicy: { recordMemoryDeltas: false, recordWorkflowLearnings: false },
      title: "wf",
      goalPrompt: "todo-web",
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
