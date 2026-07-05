import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicFixtureComposer, seedDeterministicWorkflowGraph } from "./fixtures/deterministic-workflow-composer.ts";
import { createPostgresPlannerDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("planner draft creation emits real progress stages from the backend lifecycle", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDeterministicWorkflowGraph(db);
    const stages: string[] = [];
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with browser QA",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer: new DeterministicFixtureComposer(),
      onProgress(event) {
        stages.push(event.stage);
      },
    });

    assert.equal(draft.status, "validated");
    assert.deepEqual(stages, [
      "request.normalized",
      "requirement.analyzed",
      "candidate.resolving",
      "candidate.resolved",
      "composer.started",
      "composer.completed",
      "validation.completed",
      "composition.compiling",
      "composition.compiled",
      "draft.persisted",
    ]);
  } finally {
    await db.close();
  }
});
