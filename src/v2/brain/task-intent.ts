import type { TaskExecutionIntent } from "../hands/types.ts";

export type DefaultTaskExecutionIntentInput = Omit<TaskExecutionIntent, "schemaVersion" | "executionMode">;

export function createDefaultTaskExecutionIntent(input: DefaultTaskExecutionIntentInput): TaskExecutionIntent {
  return {
    schemaVersion: "southstar.brain.task_execution_intent.v1",
    executionMode: "single_task",
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    contextPacketId: input.contextPacketId,
    attemptId: input.attemptId,
    expectedArtifactContracts: [...input.expectedArtifactContracts],
    allowedToolNames: [...input.allowedToolNames],
    toolProxyPolicyRef: input.toolProxyPolicyRef,
    handProviderId: input.handProviderId,
    instructionsRef: input.instructionsRef,
    inputArtifactRefs: [...input.inputArtifactRefs],
  };
}
