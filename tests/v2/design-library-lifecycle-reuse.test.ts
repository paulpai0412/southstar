import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { createWorkflowDesignDraftFromIssue } from "../../src/v2/design-library/designer.ts";
import { approveDraftForRun, validateTemplateFromRun } from "../../src/v2/design-library/lifecycle.ts";
import { matchValidatedTemplateForIssue } from "../../src/v2/design-library/reuse.ts";

test("template validates only after runtime pass, terminal accepted artifact, evidence, and stop condition", async () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });
  const issue = issuePacket("/tmp/todo-web");
  const draft = await createWorkflowDesignDraftFromIssue(db, { issue, actorType: "llm", plannerClient: { generate: async () => "{}" } });
  const approved = approveDraftForRun(db, { draftId: draft.draftId, approvedBy: "user", version: "1.0.0" });

  createWorkflowRun(db, {
    id: "run-template-validation",
    status: "passed",
    domain: "software",
    goalPrompt: issue.title,
    workflowManifestJson: JSON.stringify({ compiledFrom: { templateVersionId: approved.templateVersionId } }),
    executionProjectionJson: JSON.stringify(null),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  appendHistoryEvent(db, { runId: "run-template-validation", eventType: "run.completed", actorType: "runtime", payload: { status: "passed" } });
  upsertRuntimeResource(db, { resourceType: "artifact", resourceKey: "terminal-artifact", runId: "run-template-validation", scope: "workflow", status: "accepted", payload: { artifactType: "completion_report" } });
  upsertRuntimeResource(db, { resourceType: "evidence_packet", resourceKey: "terminal-evidence", runId: "run-template-validation", scope: "workflow", status: "complete", payload: { completeness: { requiredCount: 3, presentCount: 3, missingKinds: [] } } });
  upsertRuntimeResource(db, { resourceType: "stop_condition_result", resourceKey: "terminal-stop", runId: "run-template-validation", scope: "workflow", status: "passed", payload: { verdict: "passed" } });

  const validated = validateTemplateFromRun(db, { templateVersionId: approved.templateVersionId, runId: "run-template-validation", actorType: "runtime" });
  assert.equal(validated.status, "validated");

  const match = matchValidatedTemplateForIssue(db, { issue: issuePacket("/tmp/another-todo-web") });
  assert.equal(match.confidence >= 0.85, true, JSON.stringify(match));
  assert.equal(match.missingInputs.length, 0);
  assert.equal(match.risk, "low");
  assert.equal(match.clarificationQuestionCount, 0);
});

function issuePacket(repoPath: string) {
  return {
    title: "Todo-web: add priority labels, due dates, and overdue filter",
    body: "Implement todo-web priority and due-date workflow.",
    labels: ["feature", "todo-web"],
    repoPath,
    acceptanceCriteria: ["priority", "due date", "overdue", "localStorage", "tests"],
  };
}
