import test from "node:test";
import assert from "node:assert/strict";
import {
  projectWorkflowUiReadModel,
  readWorkflowUiReadModel,
  unwrapV2Payload,
} from "../../web/lib/workflow/workflow-ui-transport";

const workflowUi = {
  mission: {
    goalContract: {
      schemaVersion: "southstar.goal_contract.v1" as const,
      originalPrompt: "Ship feature",
      promptHash: "prompt-hash",
      revision: 1,
      workspace: { cwd: "/tmp/demo" },
      domain: "software",
      intent: "ship",
      summary: "Ship feature",
      requirements: [],
      expectedArtifactRefs: [],
      requiredCapabilities: [],
      nonGoals: [],
      assumptions: [],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: [],
    },
    goalContractHash: "goal-hash",
    coverage: { covered: 1, total: 1, failedRequirementIds: [], entries: [] },
    status: { execution: "awaiting_approval", outcome: "in_progress" as const, health: "healthy" as const },
    approval: { id: "approval-1", status: "pending", goalContractHash: "goal-hash", manifestHash: "manifest-hash", librarySnapshotHash: "library-hash" },
    evaluatorResults: [],
    blockers: [],
    provenance: { originalPrompt: "Ship feature", revision: 1, promptHash: "prompt-hash" },
  },
  commands: [{ id: "approval.approve", label: "Approve", method: "POST" as const, enabled: true, requiresConfirmation: true }],
};

test("workflow UI transport unwraps V2 envelopes and bare JSON", async () => {
  assert.deepEqual(unwrapV2Payload({ ok: true, result: workflowUi }), workflowUi);
  assert.deepEqual(unwrapV2Payload(workflowUi), workflowUi);
  assert.deepEqual(await readWorkflowUiReadModel(Response.json({ result: workflowUi })), workflowUi);
});

test("workflow UI transport projects mission and approval into the DAG", () => {
  const projection = projectWorkflowUiReadModel({
    orchestration: {
      draftId: "draft-1",
      goalPrompt: "Ship feature",
      workflowId: "wf-1",
      status: "validated",
      validationIssues: [],
      taskSummaries: [{ taskId: "implement", taskName: "Implement", dependsOn: [] }],
    },
    workflowUi,
    runId: "run-1",
    runStatus: "awaiting_approval",
  });

  assert.equal(projection.mission, workflowUi.mission);
  assert.equal(projection.approvalCommand, workflowUi.commands[0]);
  assert.equal(projection.dag.runId, "run-1");
  assert.equal(projection.dag.approvalCommand?.id, "approval.approve");
});
