import assert from "node:assert/strict";
import test from "node:test";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, listHistoryForRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

async function loadChatSessionReadModel(): Promise<{
  buildChatSessionReadModelPg: (db: Awaited<ReturnType<typeof createTestPostgresDb>>, input: { runId?: string; sessionId?: string }) => Promise<any>;
}> {
  try {
    return await import("../../src/v2/read-models/chat-session.ts");
  } catch (caught) {
    assert.fail(`missing chat session read model: ${(caught as Error).message}`);
  }
}

test("freeform chat session route records chat messages without runtime steering", async () => {
  const db = await createTestPostgresDb();
  try {
    const { buildChatSessionReadModelPg } = await loadChatSessionReadModel();
    await createWorkflowRunPg(db, {
      id: "run-chat-session",
      status: "running",
      domain: "software",
      goalPrompt: "chat session route",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/chat/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-chat-session",
          sessionId: "chat-session-a",
          message: "freeform question",
          model: { provider: "pi", modelId: "pi-default" },
          toolPreset: "default",
          thinkingLevel: "auto",
        }),
      });
      assert.equal(response.status, 200);
      const envelope = await response.json() as { ok: true; kind: string; result: { sessionId: string; messageId: string; status: string } };
      assert.equal(envelope.kind, "chat-message");
      assert.equal(envelope.result.sessionId, "chat-session-a");
      assert.equal(envelope.result.status, "recorded");
      assert.match(envelope.result.messageId, /^chat-message-/);

      const model = await buildChatSessionReadModelPg(db, { runId: "run-chat-session", sessionId: "chat-session-a" });
      assert.equal(model.sessionId, "chat-session-a");
      assert.deepEqual(model.messages.map((message) => [message.role, message.text]), [["user", "freeform question"]]);
      assert.equal(model.branchTree.length, 1);
      assert.equal(model.activeLeafId, model.messages[0]?.id);

      const history = await listHistoryForRunPg(db, "run-chat-session");
      assert.deepEqual(history.map((event) => event.eventType), ["chat.message"]);
      assert.equal(history[0]?.sessionId, "chat-session-a");
      assert.equal(history[0]?.actorType, "user");
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

test("chat session read model exposes real branch lineage when parent message ids are present", async () => {
  const db = await createTestPostgresDb();
  try {
    const { buildChatSessionReadModelPg } = await loadChatSessionReadModel();
    await createWorkflowRunPg(db, {
      id: "run-chat-branch",
      status: "running",
      domain: "software",
      goalPrompt: "chat branch",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "chat_session",
      resourceKey: "chat-session-branch",
      runId: "run-chat-branch",
      sessionId: "chat-session-branch",
      scope: "chat",
      status: "active",
      payload: {
        messages: [
          { id: "msg-root", role: "user", text: "start" },
          { id: "msg-a", parentMessageId: "msg-root", role: "assistant", text: "branch a" },
          { id: "msg-b", parentMessageId: "msg-root", role: "assistant", text: "branch b" },
        ],
        activeLeafId: "msg-b",
      },
    });

    const model = await buildChatSessionReadModelPg(db, { runId: "run-chat-branch", sessionId: "chat-session-branch" });
    assert.equal(model.activeLeafId, "msg-b");
    assert.equal(model.branchTree[0]?.id, "msg-root");
    assert.deepEqual(model.branchTree[0]?.children.map((child) => child.id), ["msg-a", "msg-b"]);
  } finally {
    await db.close();
  }
});

test("freeform chat session route records a message under the selected parent branch", async () => {
  const db = await createTestPostgresDb();
  try {
    const { buildChatSessionReadModelPg } = await loadChatSessionReadModel();
    await createWorkflowRunPg(db, {
      id: "run-chat-selected-branch",
      status: "running",
      domain: "software",
      goalPrompt: "chat selected branch",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "chat_session",
      resourceKey: "chat-session-selected-branch",
      runId: "run-chat-selected-branch",
      sessionId: "chat-session-selected-branch",
      scope: "chat",
      status: "active",
      payload: {
        messages: [
          { id: "msg-root", role: "user", text: "start" },
          { id: "msg-a", parentMessageId: "msg-root", role: "assistant", text: "branch a" },
          { id: "msg-b", parentMessageId: "msg-root", role: "assistant", text: "branch b" },
        ],
        activeLeafId: "msg-b",
      },
    });
    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/chat/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-chat-selected-branch",
          sessionId: "chat-session-selected-branch",
          parentMessageId: "msg-a",
          message: "continue branch a",
        }),
      });
      assert.equal(response.status, 200);
      const envelope = await response.json() as { ok: true; result: { messageId: string } };
      const model = await buildChatSessionReadModelPg(db, { runId: "run-chat-selected-branch", sessionId: "chat-session-selected-branch" });
      const recorded = model.messages.find((message: { id: string }) => message.id === envelope.result.messageId);
      assert.equal(recorded?.parentMessageId, "msg-a");
      assert.equal(model.activeLeafId, envelope.result.messageId);
      assert.deepEqual(model.branchTree[0]?.children.map((child: { id: string }) => child.id), ["msg-a", "msg-b"]);
      assert.deepEqual(
        model.branchTree[0]?.children.find((child: { id: string }) => child.id === "msg-a")?.children.map((child: { id: string }) => child.id),
        [envelope.result.messageId],
      );
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

test("chat session UI route returns the freeform chat read model", async () => {
  const db = await createTestPostgresDb();
  try {
    const { buildChatSessionReadModelPg } = await loadChatSessionReadModel();
    await createWorkflowRunPg(db, {
      id: "run-chat-ui",
      status: "running",
      domain: "software",
      goalPrompt: "chat ui",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "chat_session",
      resourceKey: "chat-session-ui",
      runId: "run-chat-ui",
      sessionId: "chat-session-ui",
      scope: "chat",
      status: "active",
      payload: {
        messages: [{ id: "msg-ui", role: "user", text: "hello ui" }],
        activeLeafId: "msg-ui",
      },
    });
    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/ui/chat-session?runId=run-chat-ui&sessionId=chat-session-ui`);
      assert.equal(response.status, 200);
      const envelope = await response.json() as { ok: true; kind: string; result: Awaited<ReturnType<typeof buildChatSessionReadModelPg>> };
      assert.equal(envelope.kind, "ui-chat-session");
      assert.equal(envelope.result.messages[0]?.text, "hello ui");
      assert.equal(envelope.result.activeLeafId, "msg-ui");
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});
