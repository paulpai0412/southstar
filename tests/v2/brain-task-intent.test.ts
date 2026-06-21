import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTaskExecutionIntent } from "../../src/v2/brain/task-intent.ts";
import type { HandExecutionPayload } from "../../src/v2/hands/types.ts";

test("default brain intent creates a single-task hand execution contract", () => {
  const intent = createDefaultTaskExecutionIntent({
    runId: "run-intent",
    taskId: "task-a",
    sessionId: "session-a",
    contextPacketId: "context-a",
    attemptId: "attempt-1",
    expectedArtifactContracts: ["task_result"],
    allowedToolNames: ["github"],
    toolProxyPolicyRef: "policy-a",
    handProviderId: "tork",
    instructionsRef: "context-a",
    inputArtifactRefs: ["artifact_ref:upstream"],
  });

  assert.equal(intent.schemaVersion, "southstar.brain.task_execution_intent.v1");
  assert.equal(intent.executionMode, "single_task");
  assert.equal(intent.runId, "run-intent");
  assert.equal(intent.taskId, "task-a");
  assert.equal(intent.sessionId, "session-a");
  assert.equal(intent.contextPacketId, "context-a");
  assert.equal(intent.attemptId, "attempt-1");
  assert.deepEqual(intent.expectedArtifactContracts, ["task_result"]);
  assert.deepEqual(intent.allowedToolNames, ["github"]);
  assert.equal(intent.toolProxyPolicyRef, "policy-a");
  assert.equal(intent.handProviderId, "tork");
  assert.equal(intent.instructionsRef, "context-a");
  assert.deepEqual(intent.inputArtifactRefs, ["artifact_ref:upstream"]);
});

test("default brain intent copies array inputs defensively", () => {
  const expectedArtifactContracts = ["task_result"];
  const allowedToolNames = ["github"];
  const inputArtifactRefs = ["artifact_ref:upstream"];

  const intent = createDefaultTaskExecutionIntent({
    runId: "run-intent",
    taskId: "task-a",
    sessionId: "session-a",
    contextPacketId: "context-a",
    attemptId: "attempt-1",
    expectedArtifactContracts,
    allowedToolNames,
    toolProxyPolicyRef: "policy-a",
    handProviderId: "tork",
    instructionsRef: "context-a",
    inputArtifactRefs,
  });

  expectedArtifactContracts.push("debug_log");
  allowedToolNames.push("shell");
  inputArtifactRefs.push("artifact_ref:late");

  assert.deepEqual(intent.expectedArtifactContracts, ["task_result"]);
  assert.deepEqual(intent.allowedToolNames, ["github"]);
  assert.deepEqual(intent.inputArtifactRefs, ["artifact_ref:upstream"]);
});

test("hand execution payload preserves queue and heartbeat timeout metadata", () => {
  const payload = {
    schemaVersion: "southstar.runtime.hand_execution.v1",
    handExecutionId: "hand-execution-1",
    providerId: "tork",
    runId: "run-intent",
    taskId: "task-a",
    sessionId: "session-a",
    attemptId: "attempt-1",
    brainBindingId: "brain-binding-1",
    handBindingId: "hand-binding-1",
    status: "queued",
    queuedAt: "2026-06-21T00:00:00.000Z",
    queueTimeoutSeconds: 60,
    heartbeatTimeoutSeconds: 300,
  } satisfies HandExecutionPayload;

  assert.equal(payload.queueTimeoutSeconds, 60);
  assert.equal(payload.heartbeatTimeoutSeconds, 300);
});
