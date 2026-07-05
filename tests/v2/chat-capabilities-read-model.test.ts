import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentLibraryReadModelPg } from "../../src/v2/read-models/agent-library.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";

async function loadChatCapabilitiesReadModel(): Promise<{
  buildChatCapabilitiesReadModelPg: (db: Awaited<ReturnType<typeof createTestPostgresDb>>, input: { domain?: string }) => Promise<any>;
}> {
  try {
    return await import("../../src/v2/read-models/chat-capabilities.ts");
  } catch (caught) {
    assert.fail(`missing chat capabilities read model: ${(caught as Error).message}`);
  }
}

test("chat capabilities are derived from agent library profiles skills and tool policy", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const { buildChatCapabilitiesReadModelPg } = await loadChatCapabilitiesReadModel();
    const library = await buildAgentLibraryReadModelPg(db, { domain: "software" });
    const model = await buildChatCapabilitiesReadModelPg(db, { domain: "software" });

    assert.equal(model.domain, library.domain);
    assert.ok(model.modelList.length > 0);
    assert.ok(model.modelList.every((entry) => entry.provider.length > 0 && entry.modelId.length > 0));
    assert.ok(model.skillCommands.length > 0);
    assert.deepEqual(
      model.skillCommands.map((entry) => entry.command).sort(),
      library.skills.map((entry) => entry.id).sort(),
    );
    assert.ok(model.toolPresets.some((preset) => preset.id === "default"));
    assert.ok(model.toolPresets.some((preset) => preset.allowedTools.length > 0));
    assert.ok(model.thinkingLevels.includes("auto"));
  } finally {
    await db.close();
  }
});

test("chat capabilities route exposes the same read model contract", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const { buildChatCapabilitiesReadModelPg } = await loadChatCapabilitiesReadModel();
    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/ui/chat-capabilities?domain=software`);
      assert.equal(response.status, 200);
      const envelope = await response.json() as {
        ok: true;
        kind: string;
        result: Awaited<ReturnType<typeof buildChatCapabilitiesReadModelPg>>;
      };
      assert.equal(envelope.kind, "ui-chat-capabilities");
      assert.equal(envelope.result.domain, "software");
      assert.ok(envelope.result.modelList.length > 0);
      assert.ok(envelope.result.skillCommands.length > 0);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});
