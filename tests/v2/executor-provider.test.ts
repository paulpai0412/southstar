import test from "node:test";
import assert from "node:assert/strict";
import { TorkExecutorProvider } from "../../src/v2/executor/tork-provider.ts";
import type { TorkJobProjection } from "../../src/v2/executor/tork-projection.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import type { ExecutorType } from "../../src/v2/executor/provider.ts";


test("executor contract supports cubesandbox type", () => {
  const executorType: ExecutorType = "cubesandbox";
  assert.equal(executorType, "cubesandbox");
});

test("TorkExecutorProvider submits through Tork without leaking provider details into workflow manifest", async () => {
  const workflow = workflowManifest();
  const canonicalWorkflowJson = JSON.stringify(workflow);
  const submittedProjections: TorkJobProjection[] = [];
  const provider = new TorkExecutorProvider({
    callbackUrl: "http://127.0.0.1:3000/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
    torkClient: {
      submit: async (projection) => {
        submittedProjections.push(projection);
        return { jobId: "tork-job-1", status: "queued" };
      },
    },
  });

  const result = await provider.submit({
    runId: "run-wf-provider",
    workflow,
  });

  assert.equal(result.executorType, "tork");
  assert.equal(result.externalJobId, "tork-job-1");
  assert.equal(result.status, "queued");
  assert.equal(result.projectionFingerprint, submittedProjections[0]?.fingerprint);
  assert.equal(submittedProjections.length, 1);
  assert.equal(submittedProjections[0].job.name, "run-wf-provider");
  assert.deepEqual(submittedProjections[0].job.tasks[0].command, [
    "southstar-agent-runner",
    "--envelope",
    "/southstar-runs/run-wf-provider/task-implement/envelope.json",
  ]);

  assert.equal(JSON.stringify(workflow), canonicalWorkflowJson);
  const workflowText = JSON.stringify(workflow);
  assert.equal(workflowText.includes("executorType"), false);
  assert.equal(workflowText.includes("externalJobId"), false);
  assert.equal(workflowText.includes("torkJobId"), false);
});

function workflowManifest(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-provider",
    title: "Provider workflow",
    goalPrompt: "implement provider boundary",
    tasks: [{
      id: "task-implement",
      name: "Implement provider boundary",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
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
