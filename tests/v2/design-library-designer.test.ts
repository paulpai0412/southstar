import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { createWorkflowDesignDraftFromIssue } from "../../src/v2/design-library/designer.ts";

const issue = {
  title: "Todo-web: add priority labels, due dates, and overdue filter",
  body: "Users need to assign priority and due dates to todos, filter overdue items, and keep the state after reload.",
  labels: ["feature", "todo-web", "frontend"],
  repoPath: "/workspace/todo-web",
  acceptanceCriteria: [
    "Each todo can show low, medium, or high priority.",
    "Each todo can store an ISO due date.",
    "Overdue filter shows only incomplete todos with due date before today.",
    "Todo state persists in localStorage across reload.",
    "Unit and browser behavior tests pass in Docker.",
  ],
};

test("designer creates software-dev workflow draft from a real todo-web issue packet", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });

  const result = await createWorkflowDesignDraftFromIssue(db, {
    issue,
    actorType: "llm",
    plannerClient: { generate: async (prompt) => JSON.stringify({ promptLength: prompt.length }) },
  });

  assert.match(result.draftId, /^obj-/);
  assert.equal(result.requirementSpec.requiredInputs.length >= 3, true);
  assert.equal(result.requirementSpec.acceptanceCriteria.length, 5);
  assert.equal(result.librarySearchTrace.matchedDefinitions.length >= 5, true);
  assert.equal(result.externalDiscoveryTrace.sources.length, 0, "internal seed should satisfy the first todo-web workflow");
  assert.deepEqual(result.agentComposition.map((entry) => entry.roleRef), ["explorer", "planner", "implementer", "checker", "summarizer"]);
  assert.equal(result.validation.ok, true, JSON.stringify(result.validation.issues));
});
