import test from "node:test";
import assert from "node:assert/strict";
import { applyWorkflowRevision } from "../../src/v2/manifests/workflow-revision.ts";
import type { SouthstarWorkflowManifest, WorkflowRevisionRequest } from "../../src/v2/manifests/types.ts";

test("applies a revision that adds a follow-up task", () => {
  const result = applyWorkflowRevision(baseWorkflow(), addVerificationTaskRequest(), {
    "task-implement": "completed",
  });

  assert.equal(result.newTaskIds.includes("task-follow-up-verification"), true);
  assert.equal(result.workflow.tasks.some((task) => task.id === "task-follow-up-verification"), true);
  assert.match(result.manifestFingerprint, /^[a-f0-9]{64}$/);
});

test("rejects a revision that creates a cycle", () => {
  assert.throws(() => applyWorkflowRevision(baseWorkflow(), {
    ...addVerificationTaskRequest(),
    dependencyChanges: [{ taskId: "task-implement", dependsOn: ["task-follow-up-verification"] }],
  }, {
    "task-implement": "pending",
  }), /cycle/i);
});

test("rejects removing a completed task", () => {
  assert.throws(() => applyWorkflowRevision(baseWorkflow(), {
    ...addVerificationTaskRequest(),
    addTasks: [],
    removeTaskIds: ["task-implement"],
  }, {
    "task-implement": "completed",
  }), /completed/i);
});

function addVerificationTaskRequest(): WorkflowRevisionRequest {
  return {
    revisionId: "rev-1",
    baseRevisionId: "base",
    runId: "run-1",
    actorType: "root-session",
    reason: "artifact gap requires follow-up verification",
    addTasks: [{
      ...baseWorkflow().tasks[0],
      id: "task-follow-up-verification",
      name: "Follow-up verification",
      dependsOn: ["task-implement"],
    }],
    removeTaskIds: [],
    dependencyChanges: [],
    idempotencyKey: "rev-1",
  };
}

function baseWorkflow(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-software-mvp",
    title: "Software MVP",
    goalPrompt: "implement calc sum",
    tasks: [{
      id: "task-implement",
      name: "Implement CLI",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "southstar/codex-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    }],
    harnessDefinitions: [{
      id: "codex",
      kind: "codex",
      entrypoint: "southstar-agent-runner",
      image: "southstar/codex-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v1",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation-report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}
