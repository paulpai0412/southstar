import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "../../web/lib/types.ts";
import {
  buildSessionStats,
  latestWorkflowDraftId,
  readCompactResult,
} from "../../web/lib/agent-session-engine.ts";

test("agent session engine builds stats from durable messages", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "start", timestamp: 1 },
    {
      role: "assistant",
      model: "gpt-5",
      provider: "openai",
      content: [
        { type: "text", text: "I'll check." },
        { type: "toolCall", toolCallId: "tool-1", toolName: "Read", input: { path: "README.md" } },
      ],
      usage: {
        input: 10,
        output: 20,
        cacheRead: 3,
        cacheWrite: 2,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.002, total: 0.035 },
      },
    },
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "Read",
      content: [{ type: "text", text: "done" }],
    },
  ];

  assert.deepEqual(buildSessionStats({
    messages,
    sessionFile: "/tmp/session.jsonl",
    sessionId: "sess-1",
    sessionName: "Architecture pass",
    contextUsage: { percent: 25, contextWindow: 200_000, tokens: 50_000 },
  }), {
    sessionFile: "/tmp/session.jsonl",
    sessionId: "sess-1",
    sessionName: "Architecture pass",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 3,
    tokens: {
      input: 10,
      output: 20,
      cacheRead: 3,
      cacheWrite: 2,
      total: 35,
    },
    cost: 0.035,
    contextUsage: { percent: 25, contextWindow: 200_000, tokens: 50_000 },
  });
});

test("agent session engine returns null stats when there are no messages or tokens", () => {
  assert.equal(buildSessionStats({
    messages: [],
    sessionId: "empty",
  }), null);
});

test("agent session engine finds the newest workflow planner draft in assistant messages", () => {
  const messages = [
    assistantWorkflowMessage("draft-old"),
    { role: "user", content: "revise", timestamp: 2 },
    assistantWorkflowMessage("draft-new"),
  ] satisfies AgentMessage[];

  assert.equal(latestWorkflowDraftId(messages), "draft-new");
});

test("agent session engine reads compact results only when token numbers are present", () => {
  assert.deepEqual(readCompactResult({
    tokensBefore: 1000,
    estimatedTokensAfter: 300,
  }, "manual"), {
    reason: "manual",
    tokensBefore: 1000,
    estimatedTokensAfter: 300,
  });
  assert.equal(readCompactResult({ tokensBefore: "1000" }, "manual"), null);
});

function assistantWorkflowMessage(draftId: string): AgentMessage {
  return {
    role: "assistant",
    model: "gpt-5",
    provider: "openai",
    content: [{
      type: "workflowDag",
      dag: {
        id: "workflow",
        draftId,
        templateId: "template.software",
        templateTitle: "Software workflow",
        prompt: "ship it",
        expandedByDefault: true,
        readiness: "ready",
        nodes: [],
        edges: [],
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    }],
  };
}
