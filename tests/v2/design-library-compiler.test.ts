import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { validateWorkflowManifest } from "../../src/v2/manifests/validate.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { createWorkflowDesignDraftFromIssue } from "../../src/v2/design-library/designer.ts";
import { approveDraftForRun } from "../../src/v2/design-library/lifecycle.ts";
import { compileTemplateVersionToManifest } from "../../src/v2/design-library/compiler.ts";

test("approved template compiles from immutable version refs into a valid Tork manifest", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });
  const issue = todoIssue("/tmp/todo-web");
  const draft = await createWorkflowDesignDraftFromIssue(db, {
    issue,
    actorType: "llm",
    plannerClient: { generate: async () => "{}" },
  });
  const approved = approveDraftForRun(db, { draftId: draft.draftId, approvedBy: "user", version: "1.0.0" });

  const manifest = compileTemplateVersionToManifest(db, {
    templateVersionId: approved.templateVersionId,
    issue,
    runInputs: { repoPath: issue.repoPath, issueTitle: issue.title, issueBody: issue.body, acceptanceCriteria: issue.acceptanceCriteria },
    compilerVersion: "design-library-compiler-v1",
  });

  assert.equal(manifest.compiledFrom?.templateVersionId, approved.templateVersionId);
  assert.match(manifest.compiledFrom?.inputHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(manifest.tasks.length >= 5, true);
  assert.equal(manifest.tasks.every((task) => task.execution.engine === "tork"), true);
  assert.equal(manifest.tasks.every((task) => task.subagents.every((subagent) => subagent.harnessId === "pi")), true);
  assert.equal(manifest.harnessDefinitions.every((harness) => harness.kind === "pi-agent"), true);
  assert.equal(manifest.tasks.some((task) => task.id.includes("checker")), true);
  const validation = validateWorkflowManifest(manifest);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
});

function todoIssue(repoPath: string) {
  return {
    title: "Todo-web: add priority labels, due dates, and overdue filter",
    body: "Implement the todo-web feature issue in the fixture repo.",
    labels: ["feature", "todo-web"],
    repoPath,
    acceptanceCriteria: ["priority labels", "due dates", "overdue filter", "localStorage persistence", "tests pass"],
  };
}
