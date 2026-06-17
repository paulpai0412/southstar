import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createSessionCheckpoint, getSessionCheckpoint } from "../../src/v2/session-recovery/checkpoints.ts";

test("creates immutable rich session checkpoint resource and history", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-checkpoint"));

  const checkpoint = createSessionCheckpoint(db, {
    runId: "run-checkpoint",
    taskId: "implementer",
    sessionId: "root-run-checkpoint-implementer",
    kind: "before-recovery",
    createdBy: "evaluator",
    contextPacketId: "ctx-1",
    taskEnvelopeId: "env-1",
    artifactRefs: ["artifact-1"],
    evidencePacketRefs: ["evidence-1"],
    validatorResultRefs: ["validator-1"],
    workspaceSnapshotRef: "workspace-1",
    checkpointSummary: "Implementation evidence is missing test results.",
    failureSummary: "Validator rejected missing testResults.",
    attemptedApproach: "Submitted artifact before running npm test.",
    nextAttemptHint: "Run npm test and include command output.",
    contextTokenEstimate: 900,
    failureSuffixTokenEstimate: 300,
    policy: { safeForAutoRetry: true, safeForFork: true, safeForReset: true, safeForWorkspaceRollback: false },
  });

  assert.equal(checkpoint.kind, "before-recovery");
  assert.equal(checkpoint.tokenTelemetry.checkpointSummaryTokenEstimate > 0, true);

  const stored = getSessionCheckpoint(db, checkpoint.checkpointId);
  assert.equal(stored?.checkpointId, checkpoint.checkpointId);
  assert.equal(stored?.summaries.failureSummary, "Validator rejected missing testResults.");

  const resources = listResources(db, { resourceType: "session_checkpoint" });
  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.status, "created");
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
      title: "wf",
      goalPrompt: "todo-web feature",
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
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
