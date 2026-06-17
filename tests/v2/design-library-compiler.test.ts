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

test("compiler assigns task-specific software-dev skill refs and records skill version refs", async () => {
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

  const refsByTask = Object.fromEntries(manifest.tasks.map((task) => [task.id, task.skillRefs ?? []]));
  assert.equal((refsByTask.explorer ?? []).includes("software-dev.skill.explorer-context"), true);
  assert.equal((refsByTask.planner ?? []).includes("software-dev.skill.planner-planning"), true);
  assert.equal((refsByTask.implementer ?? []).includes("software-dev.skill.implementer-implementation"), true);
  assert.equal((refsByTask.checker ?? []).includes("software-dev.skill.checker-verification"), true);
  assert.equal((refsByTask.summarizer ?? []).includes("software-dev.skill.summarizer-completion"), true);
  assert.equal(manifest.agentProfiles.some((profile) => (profile.skillRefs?.length ?? 0) > 0), false);
  assert.equal((manifest.compiledFrom?.libraryVersionRefs ?? []).some((ref) => ref.includes("software-dev-skill")), true);
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
