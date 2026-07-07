import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "../../web/lib/types.ts";
import {
  classifySessionKindFromEntries,
  filterSessionsByKind,
  SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE,
} from "../../web/lib/session-kind.ts";

test("session kind defaults to chat without workflow evidence", () => {
  assert.equal(classifySessionKindFromEntries([]), "chat");
});

test("session kind uses explicit custom metadata when present", () => {
  assert.equal(classifySessionKindFromEntries([
    customKindEntry("workflow"),
  ]), "workflow");
  assert.equal(classifySessionKindFromEntries([
    customKindEntry("library"),
  ]), "library");
  assert.equal(classifySessionKindFromEntries([
    customKindEntry("workflow"),
    customKindEntry("chat"),
  ]), "chat");
});

test("session kind does not migrate old workflow-looking sessions without explicit metadata", () => {
  assert.equal(classifySessionKindFromEntries([
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-06-30T00:00:00.000Z",
      message: {
        role: "assistant",
        model: "gpt-5",
        provider: "southstar",
        content: [{
          type: "workflowDag",
          dag: {
            id: "draft-1",
            templateId: "template.software",
            templateTitle: "Software Workflow",
            prompt: "build todo",
            expandedByDefault: true,
            readiness: "ready",
            nodes: [],
            edges: [],
            createdAt: "2026-06-30T00:00:00.000Z",
          },
        }],
      },
    },
  ]), "chat");
});

test("session kind recognizes API workflow composer prompt sessions", () => {
  assert.equal(classifySessionKindFromEntries([
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-06-30T00:00:00.000Z",
      message: {
        role: "user",
        content: "You are Southstar's library-constrained workflow architect.\nReturn exactly one JSON object.",
      },
    },
  ]), "workflow");
});

test("filterSessionsByKind separates chat, workflow, and library sessions", () => {
  const sessions = [
    { id: "chat-1", kind: "chat" as const },
    { id: "workflow-1", kind: "workflow" as const },
    { id: "library-1", kind: "library" as const },
  ];

  assert.deepEqual(filterSessionsByKind(sessions, "chat").map((session) => session.id), ["chat-1"]);
  assert.deepEqual(filterSessionsByKind(sessions, "workflow").map((session) => session.id), ["workflow-1"]);
  assert.deepEqual(filterSessionsByKind(sessions, "library").map((session) => session.id), ["library-1"]);
  assert.deepEqual(filterSessionsByKind(sessions, null).map((session) => session.id), ["chat-1", "workflow-1", "library-1"]);
});

function customKindEntry(kind: "chat" | "workflow" | "library"): SessionEntry {
  return {
    type: "custom",
    id: `kind-${kind}`,
    parentId: null,
    timestamp: "2026-06-30T00:00:00.000Z",
    customType: SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE,
    data: { kind },
  };
}
