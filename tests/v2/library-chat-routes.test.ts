import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { getResourceByKeyPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("serves library workspace and scoped graph route envelopes", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-route-"));

  try {
    const context = { db, libraryRoot } as any;

    const workspaceResponse = await handleRuntimeRoute(
      context,
      new Request("http://local/api/v2/library/workspace?scope=software"),
    );
    assert.equal(workspaceResponse.status, 200);
    const workspace = await readEnvelope(workspaceResponse);
    assert.equal(workspace.ok, true);
    assert.equal(workspace.kind, "library-workspace");
    assert.equal(workspace.result.selectedScope, "software");

    await seedObject(db, "agent.frontend-developer", "agent_definition", "software", "Frontend Developer");
    await seedObject(db, "agent.research-scout", "agent_definition", "research", "Research Scout");
    await seedObject(db, "tool.browser", "tool_definition", "global", "Browser");

    assert.deepEqual(await graphObjectKeys(context, "software"), ["agent.frontend-developer"]);
    assert.deepEqual(await graphObjectKeys(context, "research"), ["agent.research-scout"]);
    assert.deepEqual(await graphObjectKeys(context, "global"), ["tool.browser"]);
    assert.deepEqual(await graphObjectKeys(context, "all"), [
      "tool.browser",
      "agent.research-scout",
      "agent.frontend-developer",
    ]);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("writes, lists, reads, and syncs library files through route envelopes", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-route-"));

  try {
    const context = { db, libraryRoot } as any;
    const relativePath = "agents/frontend-developer.agent.md";
    const content = `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.frontend-developer
title: Frontend Developer
scope: software
status: draft
allowedToolRefs:
  - tool.browser
---

# Identity

Builds React interfaces.
`;
    const contentToWrite = `${content}  \n`;

    const patchResponse = await handleRuntimeRoute(
      context,
      new Request(`http://local/api/v2/library/files/${relativePath}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: contentToWrite }),
      }),
    );
    assert.equal(patchResponse.status, 200);
    const patched = await readEnvelope(patchResponse);
    assert.equal(patched.ok, true);
    assert.equal(patched.kind, "library-file");
    assert.equal(patched.result.relativePath, relativePath);
    assert.equal(patched.result.content, contentToWrite);
    assert.equal(patched.result.parsed.ok, true);

    const listResponse = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/files"));
    assert.equal(listResponse.status, 200);
    const listed = await readEnvelope(listResponse);
    assert.equal(listed.kind, "library-files");
    assert.deepEqual(
      listed.result.files.map((file: { relativePath: string }) => file.relativePath),
      [relativePath],
    );

    const readResponse = await handleRuntimeRoute(context, new Request(`http://local/api/v2/library/files/${relativePath}`));
    assert.equal(readResponse.status, 200);
    const read = await readEnvelope(readResponse);
    assert.equal(read.ok, true);
    assert.equal(read.kind, "library-file");
    assert.equal(read.result.relativePath, relativePath);
    assert.equal(read.result.content, contentToWrite);
    assert.equal(read.result.parsed.ok, true);

    const syncResponse = await handleRuntimeRoute(
      context,
      new Request(`http://local/api/v2/library/files/${relativePath}/sync`, { method: "POST" }),
    );
    assert.equal(syncResponse.status, 200);
    const synced = await readEnvelope(syncResponse);
    assert.equal(synced.kind, "library-file-sync");
    assert.equal(synced.result.object.objectKey, "agent.frontend-developer");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("library routes allow browser PATCH preflight", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-route-"));

  try {
    const response = await handleRuntimeRoute(
      { db, libraryRoot } as any,
      new Request("http://local/api/v2/library/files/agents/frontend-developer.agent.md", { method: "OPTIONS" }),
    );

    assert.equal(response.status, 204);
    assert.match(response.headers.get("access-control-allow-methods") ?? "", /PATCH/);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("accepts library chat messages and streams deterministic SSE events", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-route-"));

  try {
    const context = { db, libraryRoot } as any;
    const messageResponse = await handleRuntimeRoute(
      context,
      new Request("http://local/api/v2/library/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "library-chat-test",
          prompt: "create a browser verification skill in software",
          scope: "software",
        }),
      }),
    );

    assert.equal(messageResponse.status, 200);
    const message = await readEnvelope(messageResponse);
    assert.equal(message.ok, true);
    assert.equal(message.kind, "library-chat-message");
    assert.equal(message.result.sessionId, "library-chat-test");
    assert.equal(message.result.status, "accepted");
    assert.match(message.result.actionId, /^library-action-/);

    const actionResource = await db.one<{
      resource_type: string;
      resource_key: string;
      session_id: string;
      scope: string;
      status: string;
      payload_json: { schemaVersion: string; actionId: string; sessionId: string; prompt: string; selectedScope: string };
    }>(
      `select resource_type, resource_key, session_id, scope, status, payload_json
       from southstar.runtime_resources
       where resource_type = 'library_chat_action' and resource_key = $1`,
      [message.result.actionId],
    );
    assert.equal(actionResource.resource_key, message.result.actionId);
    assert.equal(actionResource.session_id, "library-chat-test");
    assert.equal(actionResource.scope, "library");
    assert.equal(actionResource.status, "active");
    assert.equal(actionResource.payload_json.schemaVersion, "southstar.library.chat_action.v1");
    assert.equal(actionResource.payload_json.actionId, message.result.actionId);
    assert.equal(actionResource.payload_json.sessionId, "library-chat-test");
    assert.equal(actionResource.payload_json.prompt, "create a browser verification skill in software");
    assert.equal(actionResource.payload_json.selectedScope, "software");

    const streamResponse = await handleRuntimeRoute(
      context,
      new Request(
        `http://local/api/v2/library/chat/events?sessionId=library-chat-test&actionId=${message.result.actionId}`,
      ),
    );

    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
    const stream = await streamResponse.text();
    assert.match(stream, /event: library\.intent\.started/);
    assert.match(stream, /event: library\.proposal\.created/);
    assert.match(stream, /event: library\.command\.completed/);

    const frames = parseSseFrames(stream);
    const proposal = frames.find((frame) => frame.event === "library.proposal.created");
    assert.equal(proposal?.data.title, "Draft library proposal");
    assert.deepEqual(proposal?.data.objectKeys, []);
    assert.deepEqual(proposal?.data.filePaths, []);
    const completed = frames.find((frame) => frame.event === "library.command.completed");
    assert.equal(completed?.data.status, "ready_for_review");

    const mismatchedStream = await handleRuntimeRoute(
      context,
      new Request(`http://local/api/v2/library/chat/events?sessionId=other-session&actionId=${message.result.actionId}`),
    );
    assert.equal(mismatchedStream.status, 400);
    const mismatchedError = await readEnvelope(mismatchedStream);
    assert.equal(mismatchedError.ok, false);
    assert.match(mismatchedError.error, /does not belong to session/);

    const missingStream = await handleRuntimeRoute(
      context,
      new Request("http://local/api/v2/library/chat/events?sessionId=library-chat-test&actionId=library-action-missing"),
    );
    assert.equal(missingStream.status, 400);
    const missingError = await readEnvelope(missingStream);
    assert.equal(missingError.ok, false);
    assert.match(missingError.error, /was not found/);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("library chat messages reject blank prompts", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-route-"));

  try {
    const response = await handleRuntimeRoute(
      { db, libraryRoot } as any,
      new Request("http://local/api/v2/library/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "library-chat-test", prompt: "   ", scope: "software" }),
      }),
    );

    assert.equal(response.status, 400);
    const error = await readEnvelope(response);
    assert.equal(error.ok, false);
    assert.match(error.error, /prompt is required/);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("library prompt import creates an import draft without writing files", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-prompt-"));
  try {
    const context = { db, libraryRoot } as any;
    const response = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/import-prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "create a browser verification skill that uses tool.browser", scope: "software" }),
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      result: {
        draftId: string;
        proposal: { files: Array<{ relativePath: string }> };
        status: string;
      };
    };
    assert.match(payload.result.draftId, /^library-import-draft-/);
    assert.equal(payload.result.status, "ready_for_review");
    assert.equal(payload.result.proposal.files[0]?.relativePath, "skills/browser-verification.skill.md");
    await assert.rejects(
      () => access(join(libraryRoot, "skills/browser-verification.skill.md")),
      /ENOENT/,
    );

    const resource = await getResourceByKeyPg(db, "library_import_draft", payload.result.draftId);
    assert.equal(resource?.status, "draft");
    assert.equal((resource?.payload as any).proposal.files[0].relativePath, "skills/browser-verification.skill.md");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("serves library object detail with inbound and outbound graph edges", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-object-detail-"));

  try {
    const context = { db, libraryRoot } as any;
    await seedObject(db, "agent.frontend-developer", "agent_definition", "software", "Frontend Developer");
    await seedObject(db, "skill.react-ui", "skill_spec", "software", "React UI");
    await seedObject(db, "tool.browser", "tool_definition", "global", "Browser");
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "supports_skill",
      toObjectKey: "skill.react-ui",
      scope: "software",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react-ui",
      edgeType: "requires_tool",
      toObjectKey: "tool.browser",
      scope: "software",
    });

    const response = await handleRuntimeRoute(
      context,
      new Request("http://local/api/v2/library/objects/skill.react-ui"),
    );

    assert.equal(response.status, 200);
    const envelope = await readEnvelope(response);
    assert.equal(envelope.kind, "library-object-detail");
    assert.equal(envelope.result.object.objectKey, "skill.react-ui");
    assert.deepEqual(envelope.result.inboundEdges.map((edge: { fromObjectKey: string }) => edge.fromObjectKey), [
      "agent.frontend-developer",
    ]);
    assert.deepEqual(envelope.result.outboundEdges.map((edge: { toObjectKey: string }) => edge.toObjectKey), [
      "tool.browser",
    ]);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("validates library files without writing to the graph", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-file-validate-"));

  try {
    const context = { db, libraryRoot } as any;
    const relativePath = "skills/broken.skill.md";
    const patchResponse = await handleRuntimeRoute(context, new Request(`http://local/api/v2/library/files/${relativePath}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "not a valid southstar library file" }),
    }));
    assert.equal(patchResponse.status, 200);

    const response = await handleRuntimeRoute(
      context,
      new Request(`http://local/api/v2/library/files/${relativePath}/validate`, { method: "POST" }),
    );

    assert.equal(response.status, 200);
    const envelope = await readEnvelope(response);
    assert.equal(envelope.kind, "library-file-validation");
    assert.equal(envelope.result.relativePath, relativePath);
    assert.equal(envelope.result.validation.ok, false);
    assert.match(envelope.result.validation.issues[0].message, /frontmatter|schema/i);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("validates generated profile drafts through the library route", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-profile-validate-"));

  try {
    const context = { db, libraryRoot } as any;
    await seedObject(db, "agent.frontend-developer", "agent_definition", "software", "Frontend Developer");
    await seedObject(db, "skill.react-ui", "skill_spec", "software", "React UI");
    await seedObject(db, "tool.workspace-write", "tool_definition", "software", "Workspace Write");
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "supports_skill",
      toObjectKey: "skill.react-ui",
      scope: "software",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react-ui",
      edgeType: "requires_tool",
      toObjectKey: "tool.workspace-write",
      scope: "software",
    });

    const response = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/profile-drafts/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: {
          scope: "software",
          nodeId: "implement-ui",
          agentRef: "agent.frontend-developer",
          skillRefs: ["skill.react-ui"],
          toolGrantRefs: [],
          mcpGrantRefs: [],
          instructionRefs: [],
        },
      }),
    }));

    assert.equal(response.status, 200);
    const envelope = await readEnvelope(response);
    assert.equal(envelope.kind, "library-profile-draft-validation");
    assert.equal(envelope.result.validation.ok, false);
    assert.deepEqual(envelope.result.validation.issues.map((issue: { code: string }) => issue.code), [
      "missing_required_tool",
    ]);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

async function graphObjectKeys(context: any, scope: string): Promise<string[]> {
  const response = await handleRuntimeRoute(context, new Request(`http://local/api/v2/library/graph?scope=${scope}`));
  assert.equal(response.status, 200);
  const envelope = await readEnvelope(response);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.kind, "library-graph");
  return envelope.result.nodes.map((node: { objectKey: string }) => node.objectKey);
}

async function readEnvelope(response: Response): Promise<any> {
  return await response.json();
}

function parseSseFrames(text: string): Array<{ event: string; data: any }> {
  return text
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);
      if (!event || !data) throw new Error(`invalid SSE frame: ${frame}`);
      return { event, data: JSON.parse(data) };
    });
}

async function seedObject(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  objectKey: string,
  objectKind: Parameters<typeof upsertLibraryObject>[1]["objectKind"],
  scope: string,
  title: string,
): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind,
    status: "approved",
    state: { title, scope },
  });
}
