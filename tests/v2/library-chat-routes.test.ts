import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
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

    const patchResponse = await handleRuntimeRoute(
      context,
      new Request(`http://local/api/v2/library/files/${relativePath}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    );
    assert.equal(patchResponse.status, 200);
    const patched = await readEnvelope(patchResponse);
    assert.equal(patched.ok, true);
    assert.equal(patched.kind, "library-file");
    assert.equal(patched.result.relativePath, relativePath);
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
