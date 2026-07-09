import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, SessionEntry, UserMessage } from "../../web/lib/types.ts";
import { slimMessageForUi, slimSessionTreeForUi } from "../../web/lib/session-slimming.ts";

test("session message slimming preserves workflow DAG metadata", () => {
  const assistant = slimMessageForUi({
    role: "assistant",
    model: "gpt-test",
    provider: "southstar",
    content: [
      { type: "thinking", thinking: "secret thinking".repeat(1_000), thinkingSignature: "secret-signature".repeat(1_000) } as never,
      { type: "text", text: `planner text ${"x".repeat(20_000)}` },
      {
        type: "workflowDag",
        dag: {
          id: "draft-1",
          templateId: "template.software-feature",
          templateTitle: "Tiny Workflow",
          prompt: "build",
          expandedByDefault: true,
          readiness: "ready",
          nodes: [{ id: "task-a", label: "Task A", role: "maker", provider: "pi", model: "gpt-test", profileRef: "profile.software-maker-pi" }],
          edges: [],
          createdAt: "2026-07-09T00:00:00.000Z",
          draftId: "draft-1",
          mode: "draft",
        },
      },
    ],
  } satisfies AssistantMessage);
  const dag = assistant.content.find((block) => block.type === "workflowDag");
  const text = assistant.content.find((block) => block.type === "text")?.text ?? "";

  assert.ok(text.length < 7_000);
  assert.match(text, /truncated/);
  assert.ok(dag);
  assert.equal(dag.dag.nodes[0]?.id, "task-a");
  assert.equal(dag.dag.nodes[0]?.profileRef, "profile.software-maker-pi");
  assert.doesNotMatch(JSON.stringify(assistant), /secret-signature/);
});

test("session tree slimming keeps navigation metadata without full message bodies", () => {
  const tree = [{
    entry: messageEntry("user-1", null, {
      role: "user",
      content: [{ type: "text", text: `prompt ${"x".repeat(20_000)}` }],
    } satisfies UserMessage),
    children: [],
  }];

  const slim = slimSessionTreeForUi(tree);
  const entry = slim[0]?.entry;
  const content = entry?.type === "message" ? textFromUser(entry.message as UserMessage) : "";

  assert.equal(entry?.id, "user-1");
  assert.ok(content.length < 500);
  assert.match(content, /truncated/);
  assert.ok(JSON.stringify(slim).length < 2_000);
});

function messageEntry(id: string, parentId: string | null, message: UserMessage | AssistantMessage): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-07-09T00:00:00.000Z",
    message,
  };
}

function textFromUser(message: UserMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content.find((block) => block.type === "text")?.text ?? "";
}
