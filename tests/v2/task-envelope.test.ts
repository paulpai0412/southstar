import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskEnvelope } from "../../src/v2/agent-runner/task-envelope.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";

test("builds a task-scoped envelope for container execution", () => {
  const envelope = buildTaskEnvelope(workflow(), {
    runId: "run-1",
    taskId: "task-implement",
    rootSessionId: "session-root",
    memorySnapshot: { items: [{ id: "mem-1", body: { preference: "minimal changes" } }], capturedAt: "now" },
    vaultLeases: [{ leaseRef: "vault-lease-1", mountAs: "file", secretValue: "do-not-leak" }],
    mcpGrants: [{ serverId: "github", allowedTools: ["issues.read"] }],
  });

  assert.equal(envelope.schemaVersion, "southstar.task-envelope.v1");
  assert.equal(envelope.runId, "run-1");
  assert.equal(envelope.task.id, "task-implement");
  assert.deepEqual(envelope.task.dependsOn, ["task-plan"]);
  assert.equal(envelope.rootSession.id, "session-root");
  assert.equal(envelope.subagents[0].id, "impl");
  assert.deepEqual(envelope.memory.items[0].body, { preference: "minimal changes" });
  assert.deepEqual(envelope.vaultLeases, [{ leaseRef: "vault-lease-1", mountAs: "file" }]);
  assert.deepEqual(envelope.mcpGrants, [{ serverId: "github", allowedTools: ["issues.read"] }]);
  assert.deepEqual(envelope.artifactContract, {
    artifactTypes: ["implementation-report"],
    requiredFields: ["summary", "commandsRun", "risks"],
  });
  assert.doesNotMatch(JSON.stringify(envelope), /do-not-leak/);
});

test("rejects envelope materialization for an unknown task", () => {
  assert.throws(() => buildTaskEnvelope(workflow(), {
    runId: "run-1",
    taskId: "missing",
    rootSessionId: "session-root",
    memorySnapshot: { items: [], capturedAt: "now" },
    vaultLeases: [],
    mcpGrants: [],
  }), /unknown task/);
});

function workflow(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-software-mvp",
    title: "Software MVP",
    goalPrompt: "implement calc sum",
    tasks: [{
      id: "task-plan",
      name: "Plan",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 300,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "planner", harnessId: "pi", prompt: "plan", requiredArtifacts: ["plan"] }],
    }, {
      id: "task-implement",
      name: "Implement",
      domain: "software",
      dependsOn: ["task-plan"],
      execution: {
        engine: "tork",
        image: "southstar/codex-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 2 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    }],
    harnessDefinitions: [],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation-report"], requiredFields: ["summary", "commandsRun", "risks"] }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}
