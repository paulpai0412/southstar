import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage, CustomMessage } from "../../web/lib/types.ts";
import {
  createPersistedWorkflowUiMessage,
  isWorkflowUiCheckpointMessage,
  persistedWorkflowUiMessageFromUnknown,
  restorePersistedWorkflowUiMessage,
  SOUTHSTAR_WORKFLOW_UI_CHECKPOINT_TEXT,
  SOUTHSTAR_WORKFLOW_UI_MESSAGE_CUSTOM_TYPE,
} from "../../web/lib/workflow/session-message.ts";

test("workflow UI messages round-trip through the Pi custom-message payload", () => {
  const checkpoint: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: SOUTHSTAR_WORKFLOW_UI_CHECKPOINT_TEXT }],
    provider: "southstar",
    model: "workflow-session",
    stopReason: "stop",
    timestamp: 2,
  };
  assert.equal(isWorkflowUiCheckpointMessage(checkpoint), true);

  const assistantMessage: AgentMessage = {
    role: "assistant",
    model: "workflow-generate",
    provider: "southstar",
    timestamp: 3,
    content: [{
      type: "goalRequirements",
      draftId: "draft-vocabulary",
      status: "requirements_review",
      goalRequirementDraftHash: "hash-1",
      confirmable: true,
      draft: {
        schemaVersion: "southstar.goal_requirement_draft.v1",
        revision: 1,
        originalPrompt: "Build a vocabulary trainer",
        workspace: { cwd: "/tmp/southstar-workflow-session-test" },
        summary: "Vocabulary trainer",
        requirements: [],
        nonGoals: [],
        blockingInputs: [],
        draftHash: "hash-1",
      },
    }],
  };
  const persisted = createPersistedWorkflowUiMessage(assistantMessage);
  const customMessage: CustomMessage = {
    role: "custom",
    customType: SOUTHSTAR_WORKFLOW_UI_MESSAGE_CUSTOM_TYPE,
    content: "Vocabulary requirements ready for review",
    display: false,
    details: persisted,
    timestamp: 4,
  };
  const restored = restorePersistedWorkflowUiMessage(customMessage);
  assert.ok(restored && restored.role === "assistant" && Array.isArray(restored.content));
  assert.equal(restored.content[0]?.type, "goalRequirements");
  assert.equal(restored.content[0]?.type === "goalRequirements" ? restored.content[0].draftId : null, "draft-vocabulary");
  assert.equal(restored.timestamp, 3);
});

test("workflow UI message payload rejects non-workflow roles and malformed content", () => {
  assert.equal(persistedWorkflowUiMessageFromUnknown({
    schemaVersion: "southstar.workflow_ui_message.v1",
    message: { role: "toolResult", content: [] },
  }), null);
  assert.throws(() => createPersistedWorkflowUiMessage({
    role: "assistant",
    content: [null],
  }), /user or assistant messages/);
});
