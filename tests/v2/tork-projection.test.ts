import test from "node:test";
import assert from "node:assert/strict";
import { buildTorkJobProjection } from "../../src/v2/executor/tork-projection.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";

test("builds a Tork job projection from task execution specs only", () => {
  const projection = buildTorkJobProjection(workflow(), {
    callbackUrl: "http://127.0.0.1:3000/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
    runId: "run-wf-software-mvp",
  });

  assert.equal(projection.executor, "tork");
  assert.equal(projection.job.name, "run-wf-software-mvp");
  assert.equal(projection.job.tasks.length, 2);
  assert.deepEqual(projection.job.tasks[1].dependsOn, ["task-plan"]);
  assert.deepEqual(projection.job.tasks[0].image, "southstar/pi-agent:local");
  assert.deepEqual(projection.job.tasks[0].command, [
    "southstar-agent-runner",
    "--envelope",
    "/southstar-runs/run-wf-software-mvp/task-plan/envelope.json",
  ]);
  assert.equal(projection.job.tasks[0].env.SOUTHSTAR_RUN_ID, "run-wf-software-mvp");
  assert.equal(projection.job.tasks[0].env.SOUTHSTAR_TASK_ID, "task-plan");
  assert.equal(projection.job.tasks[0].webhook, "http://127.0.0.1:3000/api/v2/executor/callback");
});

test("does not leak agent/session/memory/vault semantics into Tork projection", () => {
  const projectionText = JSON.stringify(buildTorkJobProjection(workflow(), {
    callbackUrl: "http://127.0.0.1:3000/api/v2/executor/callback",
    envelopeBasePath: "/southstar/envelope",
    runId: "run-wf-software-mvp",
  }));

  assert.doesNotMatch(projectionText, /rootSession/);
  assert.doesNotMatch(projectionText, /subagents/);
  assert.doesNotMatch(projectionText, /memoryPolicy/);
  assert.doesNotMatch(projectionText, /vaultPolicy/);
  assert.doesNotMatch(projectionText, /secret-value/);
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
        env: { SAFE_ENV: "1" },
        mounts: [{ source: "/tmp/work", target: "/workspace", readonly: false }],
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
        env: { SAFE_ENV: "1", SOUTHSTAR_SECRET_TEST: "secret-value" },
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 2 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    }],
    harnessDefinitions: [{
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["planning"],
      inputProtocol: "task-envelope-v1",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }, {
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
