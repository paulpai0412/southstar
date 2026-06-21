import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTaskExecutionIntent } from "../../src/v2/brain/task-intent.ts";

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
