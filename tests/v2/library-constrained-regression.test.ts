import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DeterministicFixtureComposer } from "../../src/v2/orchestration/composer.ts";
import { createPostgresPlannerDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("llm-constrained path stores selected refs and validator proof in planner draft", async () => {
  const db = await createTestPostgresDb();
  try {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with tests and docs",
      orchestrationMode: "llm-constrained",
      composer: new DeterministicFixtureComposer(),
    });
    const resource = await db.one<{
      payload_json: {
        orchestrationSnapshot: {
          candidateSummary: { agentProfileRefs: string[] };
          validation: { ok: boolean };
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_key = $1 and resource_type = 'planner_draft'",
      [draft.draftId],
    );
    assert.equal(resource.payload_json.orchestrationSnapshot.validation.ok, true);
    assert.deepEqual(resource.payload_json.orchestrationSnapshot.candidateSummary.agentProfileRefs, [
      "profile.software-checker-codex",
      "profile.software-code-quality-reviewer-codex",
      "profile.software-explorer-codex",
      "profile.software-maker-pi",
      "profile.software-spec-reviewer-codex",
      "profile.software-summarizer-codex",
    ]);
  } finally {
    await db.close();
  }
});

test("llm-constrained implementation does not call broad or narrow task generators directly", async () => {
  const source = await readFile(new URL("../../src/v2/ui-api/postgres-run-api.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function createLibraryConstrainedPlannerDraft");
  const section = start >= 0 ? source.slice(start) : source;
  assert.equal(section.includes("broadFeatureTasks"), false);
  assert.equal(section.includes("narrowFeatureTasks"), false);
  assert.equal(section.includes("isBroadFeaturePrompt"), false);
  assert.equal(section.includes("new DeterministicFixtureComposer"), false);
  assert.equal(section.includes("createWorkflowComposerRegistry"), true);
});

test("composition compiler avoids hardcoded role/profile string heuristics", async () => {
  const source = await readFile(new URL("../../src/v2/orchestration/composition-compiler.ts", import.meta.url), "utf8");
  assert.equal(source.includes("profile.software-spec-reviewer-codex"), false);
  assert.equal(source.includes("profile.software-code-quality-reviewer-codex"), false);
  assert.equal(source.includes('role === "spec-reviewer"'), false);
});
