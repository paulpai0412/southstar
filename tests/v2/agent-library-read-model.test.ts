import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { buildAgentLibraryReadModelPg, buildAgentLibraryCandidatesReadModelPg } from "../../src/v2/read-models/agent-library.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";

test("agent library exposes roles profiles skills mcp tools contracts and evaluators", async () => {
  const db = await createTestPostgresDb();
  try {
    const model = await buildAgentLibraryReadModelPg(db, { domain: "software" });
    assert.equal(model.domain, "software");
    assert.ok(model.roles.length > 0);
    assert.ok(model.agentProfiles.length > 0);
    assert.ok(model.skills.length > 0);
    assert.ok(model.tools.length > 0);
    assert.ok(model.artifactContracts.length > 0);
    assert.ok(model.evaluatorPipelines.length > 0);
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
          tasks: [
            { id: "task-build", roleRef: "builder", agentProfileRef: "builder-codex" },
          ],
        },
      },
      summary: { goalPrompt: "agent library", workflowId: "wf-agent-library" },
    });
    const model = await buildAgentLibraryCandidatesReadModelPg(db, { draftId: "draft-agent-library", taskId: "task-build" });
    assert.equal(model.selectedRefs.roleRef, "builder");
    assert.equal(model.selectedRefs.agentProfileRef, "builder-codex");
    assert.ok(model.alternatives.agentProfiles.length > 0);
    assert.ok(model.selectionReasons.length > 0);
  } finally {
    await db.close();
  }
});
