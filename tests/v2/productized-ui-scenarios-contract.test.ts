import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { todoWebFeatureScenario } from "../e2e-legacy-sqlite/scenarios/todo-web-feature.ts";
import { markdownTableBugfixScenario } from "../e2e-legacy-sqlite/scenarios/markdown-table-bugfix.ts";
import { docsCliUsageScenario } from "../e2e-legacy-sqlite/scenarios/docs-cli-usage.ts";
import { refactorSafetyNetScenario } from "../e2e-legacy-sqlite/scenarios/refactor-safety-net.ts";

function writeDraft(db: ReturnType<typeof openSouthstarDb>, draftId: string, tasks: Array<{ id: string; agentProfileRef?: string }>) {
  upsertRuntimeResource(db, {
    resourceType: "planner_draft",
    resourceKey: draftId,
    runId: "run-contract",
    scope: "planner",
    status: "created",
    payload: {
      workflow: {
        tasks,
      },
    },
  });
}

function setupDb(): ReturnType<typeof openSouthstarDb> {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-contract",
    status: "running",
    domain: "software",
    goalPrompt: "scenario contract",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  return db;
}

test("todo-web scenario contract requires review + browser lanes", () => {
  const db = setupDb();
  writeDraft(db, "draft-todo", [
    { id: "explore" },
    { id: "implement" },
    { id: "coding-review" },
    { id: "spec-alignment" },
    { id: "browser-qa" },
  ]);
  assert.doesNotThrow(() => todoWebFeatureScenario.assertPlannerDraft(db, "draft-todo"));
});

test("markdown bugfix scenario contract requires reproduce->diagnose->fix->regression", () => {
  const db = setupDb();
  writeDraft(db, "draft-markdown", [
    { id: "reproduce" },
    { id: "diagnose" },
    { id: "fix" },
    { id: "regression-check" },
  ]);
  assert.doesNotThrow(() => markdownTableBugfixScenario.assertPlannerDraft(db, "draft-markdown"));
});

test("docs scenario contract keeps implementation write profile out of non-doc tasks", () => {
  const db = setupDb();
  writeDraft(db, "draft-docs", [
    { id: "write-docs", agentProfileRef: "software.doc-writer.codex.readonly" },
    { id: "doc-check", agentProfileRef: "software.doc-checker.codex.readonly" },
  ]);
  assert.doesNotThrow(() => docsCliUsageScenario.assertPlannerDraft(db, "draft-docs"));
});

test("refactor scenario contract requires baseline + safety-net review lanes", () => {
  const db = setupDb();
  writeDraft(db, "draft-refactor", [
    { id: "baseline-check" },
    { id: "refactor" },
    { id: "regression-check" },
    { id: "coding-review" },
    { id: "spec-alignment" },
  ]);
  assert.doesNotThrow(() => refactorSafetyNetScenario.assertPlannerDraft(db, "draft-refactor"));
});
