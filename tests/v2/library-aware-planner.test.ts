import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { createLibraryAwareWorkflowPlanner } from "../../src/v2/planner/library-aware-planner.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";

const todoPrompt = "在 todo-web fixture repo 中新增 priority labels、due dates、overdue filter，保持 localStorage persistence，並更新 README usage。需要瀏覽器層級 QA 與 spec alignment review。";
const bugPrompt = "在 markdown-notes fixture repo 中診斷並修復 table parser 在 escaped pipe 與 code span 中切欄錯誤的 bug。先重現失敗，再修復，最後補 regression tests。";
const docsPrompt = "在 notes-cli fixture repo 中更新 README 與 docs，補上 import/export 指令的使用範例、錯誤處理說明與常見問題。不要修改 runtime code。";

test("planner selects feature workflow with parallel reviewer and browser QA tasks", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const planner = createLibraryAwareWorkflowPlanner(db, { plannerClient: scriptedPlanner() });

  const result = await planner.plan({ goalPrompt: todoPrompt, repoPath: "/tmp/todo-web", releaseMode: "none" });

  assert.equal(result.validation.ok, true, result.validation.issues.map((issue) => issue.message).join("\n"));
  assert.equal(result.result.selectedTemplateRefs[0], "software.workflow.feature-implementation");
  assert.equal(result.result.tasks.some((task) => task.id === "coding-review"), true);
  assert.equal(result.result.tasks.some((task) => task.id === "spec-alignment"), true);
  assert.equal(result.result.tasks.some((task) => task.id === "browser-qa"), true);
  assert.equal(result.result.tasks.find((task) => task.id === "browser-qa")?.dependsOn.includes("implement"), true);
  assert.equal(result.result.tasks.some((task) => task.agentDefinitionRef === "software.release-operator"), false);
  assert.equal(result.result.librarySearchTrace.matchedRefs.includes("software.workflow.feature-implementation"), true);
});

test("planner selects bug diagnosis workflow without browser QA for parser bug", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const planner = createLibraryAwareWorkflowPlanner(db, { plannerClient: scriptedPlanner() });

  const result = await planner.plan({ goalPrompt: bugPrompt, repoPath: "/tmp/markdown-notes", releaseMode: "commit-only" });

  assert.equal(result.validation.ok, true, result.validation.issues.map((issue) => issue.message).join("\n"));
  assert.equal(result.result.selectedTemplateRefs[0], "software.workflow.bug-diagnosis-fix");
  assert.equal(result.result.tasks.some((task) => task.id === "reproduce"), true);
  assert.equal(result.result.tasks.some((task) => task.id === "diagnose"), true);
  assert.equal(result.result.tasks.some((task) => task.id === "browser-qa"), false);
  assert.equal(result.result.tasks.some((task) => task.id === "release-commit-curation"), true);
});

test("planner selects docs workflow without code implementer profile", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const planner = createLibraryAwareWorkflowPlanner(db, { plannerClient: scriptedPlanner() });

  const result = await planner.plan({ goalPrompt: docsPrompt, repoPath: "/tmp/notes-cli", releaseMode: "none" });

  assert.equal(result.validation.ok, true, result.validation.issues.map((issue) => issue.message).join("\n"));
  assert.equal(result.result.selectedTemplateRefs[0], "software.workflow.documentation-update");
  assert.equal(result.result.tasks.some((task) => task.id === "write-docs"), true);
  assert.equal(result.result.tasks.some((task) => task.agentProfileRef === "software.implementer.pi.workspace-write"), false);
});

function scriptedPlanner(): PiPlannerClient {
  return {
    generate: async (prompt) => {
      assert.match(prompt, /Southstar Library-aware Workflow Planner/);
      return JSON.stringify({ accepted: true });
    },
  };
}
