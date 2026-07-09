import test from "node:test";
import assert from "node:assert/strict";
import { buildPlannerDraftRequest, workflowLifecycleReducer } from "../../web/lib/workflow/lifecycle";
import type { WorkflowDag } from "../../web/lib/workflow/types";

const dag: WorkflowDag = {
  id: "dag-1",
  templateId: "template.software-feature",
  templateTitle: "Software Feature Workflow",
  prompt: "Build API-aligned workflow UI",
  expandedByDefault: true,
  readiness: "ready",
  createdAt: "2026-06-27T00:00:00.000Z",
  nodes: [
    {
      id: "plan",
      label: "plan",
      role: "maker",
      agentRef: "agent.software-maker",
      profileRef: "software-maker-pi",
      profileResourcePath: "software/agents/software-maker/profile.json",
      provider: "pi",
      model: "pi-agent-default",
      level: 0,
      state: "ready",
    },
  ],
  edges: [],
};

test("buildPlannerDraftRequest maps dag to current v2 planner contract", () => {
  assert.deepEqual(buildPlannerDraftRequest(dag, "/repo"), {
    cwd: "/repo",
    goalPrompt: "Build API-aligned workflow UI",
    orchestrationMode: "llm-constrained",
    composerMode: "llm",
    libraryHints: {
      agentProfileRefs: ["software-maker-pi"],
    },
  });
});

test("workflowLifecycleReducer enables run only for validated draft", () => {
  const drafted = workflowLifecycleReducer(
    { phase: "file_draft" },
    {
      type: "drafted",
      draft: {
        draftId: "draft-1",
        goalPrompt: "Build",
        workflowId: "wf-1",
        status: "invalid",
        validationIssues: [{ path: "workflow.tasks", message: "missing task" }],
        taskSummaries: [],
      },
    },
  );
  assert.equal(drafted.phase, "invalid");
  assert.equal(drafted.canRun, false);

  const validated = workflowLifecycleReducer(drafted, {
    type: "validated",
    orchestration: {
      draftId: "draft-1",
      goalPrompt: "Build",
      workflowId: "wf-1",
      status: "validated",
      validationIssues: [],
      taskSummaries: [],
    },
  });
  assert.equal(validated.phase, "validated");
  assert.equal(validated.canRun, true);
});

test("workflowLifecycleReducer preserves created run when execute fails", () => {
  const runCreated = workflowLifecycleReducer(
    { phase: "running" },
    {
      type: "run_created",
      run: { runId: "run-1", taskIds: ["task-1"] },
    },
  );
  const executeFailed = workflowLifecycleReducer(runCreated, {
    type: "execute_failed",
    error: "scheduler unavailable",
  });
  assert.equal(executeFailed.phase, "run_created");
  assert.equal(executeFailed.run?.runId, "run-1");
  assert.equal(executeFailed.error, "scheduler unavailable");
});
