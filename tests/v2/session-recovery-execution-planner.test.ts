import assert from "node:assert/strict";
import test from "node:test";
import { planRecoveryExecution } from "../../src/v2/session-recovery/execution-planner.ts";
import type { SouthstarWorkflowManifest, TaskExecutionSpec } from "../../src/v2/manifests/types.ts";

const baseExecution: TaskExecutionSpec = {
  engine: "tork",
  image: "southstar/pi-agent:local",
  command: ["southstar-agent-runner"],
  env: {},
  mounts: [],
  timeoutSeconds: 900,
  infraRetry: { maxAttempts: 1 },
};

function workflow(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-generic",
    title: "generic workflow",
    goalPrompt: "do work",
    domain: "general",
    tasks: [
      {
        id: "discover",
        name: "Discover",
        domain: "general",
        dependsOn: [],
        requiredArtifactRefs: ["plan"],
        evaluatorPipelineRef: "plan-quality",
        execution: baseExecution,
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
        subagents: [],
      },
      {
        id: "produce",
        name: "Produce",
        domain: "general",
        dependsOn: ["discover"],
        requiredArtifactRefs: ["work"],
        evaluatorPipelineRef: "work-quality",
        execution: baseExecution,
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
        subagents: [],
      },
      {
        id: "review",
        name: "Review",
        domain: "general",
        dependsOn: ["produce"],
        requiredArtifactRefs: ["review"],
        evaluatorPipelineRef: "review-quality",
        stopConditionRefs: ["done"],
        execution: baseExecution,
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
        subagents: [],
      },
      {
        id: "publish",
        name: "Publish",
        domain: "general",
        dependsOn: ["review"],
        requiredArtifactRefs: ["completion"],
        evaluatorPipelineRef: "completion-quality",
        stopConditionRefs: ["done"],
        execution: baseExecution,
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
        subagents: [],
      },
    ],
    harnessDefinitions: [],
    evaluators: [],
    memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: false },
    vaultPolicy: { leaseTtlSeconds: 0, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 1, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: false, recordWorkflowLearnings: false },
  };
}

test("fork recovery targets upstream producer and downstream stop-condition path without software names", () => {
  const plan = planRecoveryExecution({
    workflow: workflow(),
    failedTaskId: "review",
    strategy: "fork-from-checkpoint",
    attemptNumber: 2,
    completedTaskIds: ["discover", "produce", "review", "publish"],
  });

  assert.deepEqual(plan.targetTaskIds, ["produce", "review", "publish"]);
  assert.equal(plan.baseTaskId, "produce");
  assert.equal(plan.requiresOperatorApproval, false);
});

test("retry-same-agent targets only the failed task", () => {
  const plan = planRecoveryExecution({
    workflow: workflow(),
    failedTaskId: "review",
    strategy: "retry-same-agent",
    attemptNumber: 2,
    completedTaskIds: ["discover", "produce"],
  });

  assert.deepEqual(plan.targetTaskIds, ["review"]);
  assert.equal(plan.baseTaskId, "review");
});

test("rollback-workspace targets failed task and downstream path and requires operator approval", () => {
  const plan = planRecoveryExecution({
    workflow: workflow(),
    failedTaskId: "review",
    strategy: "rollback-workspace",
    attemptNumber: 2,
    completedTaskIds: ["discover", "produce", "review"],
  });

  assert.deepEqual(plan.targetTaskIds, ["review", "publish"]);
  assert.equal(plan.baseTaskId, "review");
  assert.equal(plan.requiresOperatorApproval, true);
});

test("planner fails closed when failed task is absent", () => {
  assert.throws(() => planRecoveryExecution({
    workflow: workflow(),
    failedTaskId: "missing-task",
    strategy: "fork-from-checkpoint",
    attemptNumber: 2,
    completedTaskIds: [],
  }), /failed task missing-task not found/);
});
