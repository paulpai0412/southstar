import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentLibraryCandidatesReadModelPg, buildAgentLibraryReadModelPg } from "../../src/v2/read-models/agent-library.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("agent library exposes roles profiles skills mcp tools contracts and evaluators", async () => {
  const db = await createTestPostgresDb();
  try {
    const model = await buildAgentLibraryReadModelPg(db, { domain: "software" });
    assert.equal(model.domain, "software");
    assert.ok(model.roles.length > 0);
    assert.ok(model.agentProfiles.length > 0);
    assert.ok(model.skills.length > 0);
    assert.ok(model.mcpServers.length > 0);
    assert.ok(model.tools.length > 0);
    assert.ok(model.artifactContracts.length > 0);
    assert.ok(model.evaluatorPipelines.length > 0);
    assert.ok(model.mcpServers.some((server: { id: string }) => server.id.length > 0));
    assert.ok(model.tools.some((tool: { id: string }) => tool.id.length > 0));
  } finally {
    await db.close();
  }
});

test("agent library candidates exposes selected refs and alternatives for a task", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: "draft-agent-library",
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          tasks: [{ id: "task-build", roleRef: "builder", agentProfileRef: "builder-codex", skillRefs: ["southstar"] }],
        },
      },
      summary: { goalPrompt: "agent library", workflowId: "wf-agent-library" },
    });

    const model = await buildAgentLibraryCandidatesReadModelPg(db, { draftId: "draft-agent-library", taskId: "task-build" });
    assert.equal(model.selectedRefs.roleRef, "builder");
    assert.equal(model.selectedRefs.agentProfileRef, "builder-codex");
    assert.deepEqual(model.selectedRefs.skillRefs, ["southstar"]);
    assert.ok(model.alternatives.agentProfiles.length > 0);
    assert.ok(model.alternatives.roles.length > 0);
    assert.ok(model.alternatives.skills.length > 0);
    assert.ok(model.selectionReasons.length > 0);
  } finally {
    await db.close();
  }
});

test("agent library routes expose /api/v2/agent-library and /api/v2/agent-library/candidates", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-agent-library-routes";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          tasks: [{ id: "task-build", roleRef: "builder", agentProfileRef: "builder-codex" }],
        },
      },
      summary: { goalPrompt: "agent library routes", workflowId: "wf-agent-library-routes" },
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const libraryResponse = await fetch(`${server.url}/api/v2/agent-library?domain=software`);
      assert.equal(libraryResponse.status, 200);
      const libraryEnvelope = await libraryResponse.json() as { ok: true; kind: string; result: Awaited<ReturnType<typeof buildAgentLibraryReadModelPg>> };
      assert.equal(libraryEnvelope.kind, "agent-library");
      assert.equal(libraryEnvelope.result.domain, "software");
      assert.ok(libraryEnvelope.result.roles.length > 0);

      const candidatesResponse = await fetch(
        `${server.url}/api/v2/agent-library/candidates?draftId=${encodeURIComponent(draftId)}&taskId=task-build`,
      );
      assert.equal(candidatesResponse.status, 200);
      const candidatesEnvelope = await candidatesResponse.json() as {
        ok: true;
        kind: string;
        result: Awaited<ReturnType<typeof buildAgentLibraryCandidatesReadModelPg>>;
      };
      assert.equal(candidatesEnvelope.kind, "agent-library-candidates");
      assert.equal(candidatesEnvelope.result.selectedRefs.roleRef, "builder");
      assert.equal(candidatesEnvelope.result.taskId, "task-build");
      assert.ok(candidatesEnvelope.result.alternatives.agentProfiles.length > 0);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});
