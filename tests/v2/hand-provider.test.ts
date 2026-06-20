import test from "node:test";
import assert from "node:assert/strict";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";
import { createHandProviderRegistry } from "../../src/v2/hands/registry.ts";
import { createTorkHandProvider } from "../../src/v2/hands/tork-hand-provider.ts";
import type { ExecutorSubmitRequest } from "../../src/v2/executor/provider.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";

test("HandProvider provisions, executes, snapshots, and destroys fake binding", async () => {
  const provider = createFakeHandProvider({ providerId: "fake-hand" });
  const binding = await provider.provision({
    runId: "run-1",
    taskId: "task-1",
    handName: "browser",
    resources: { cpu: 2 },
  });

  assert.equal(binding.providerId, "fake-hand");
  assert.equal(binding.status, "provisioned");
  assert.deepEqual(binding.payload.resources, { cpu: 2 });

  const result = await provider.execute(binding, { name: "inspect", input: { url: "http://127.0.0.1" } });
  assert.equal(result.ok, true);
  assert.equal(binding.status, "succeeded");
  assert.match(result.output, /"url":"http:\/\/127\.0\.0\.1"/);
  assert.deepEqual(provider.capabilities(), {
    supportsSnapshot: true,
    supportsDestroy: true,
    supportsReprovision: true,
    keepsCredentialsOutOfSandbox: true,
  });

  const snapshot = await provider.snapshot(binding);
  assert.match(snapshot.id, /^hand-snapshot-/);
  assert.equal(snapshot.handBindingId, binding.id);
  assert.deepEqual(snapshot.metadata, { providerId: "fake-hand", status: "succeeded" });

  await provider.destroy(binding);
  assert.equal(binding.status, "destroyed");
});

test("HandProvider fake execute marks binding failed when configured to fail", async () => {
  const provider = createFakeHandProvider({ providerId: "fake-hand", failExecute: true });
  const binding = await provider.provision({
    runId: "run-1",
    taskId: "task-1",
    handName: "browser",
    resources: {},
  });

  const result = await provider.execute(binding, { name: "inspect", input: {} });

  assert.equal(result.ok, false);
  assert.equal(binding.status, "failed");
  assert.equal(result.output, "fake hand failed: inspect");
});

test("HandProvider registry selects registered provider and throws for missing", () => {
  const registry = createHandProviderRegistry([createFakeHandProvider({ providerId: "fake-hand" })]);
  assert.equal(registry.get("fake-hand").providerId, "fake-hand");
  assert.throws(() => registry.get("missing"), /hand provider not registered: missing/);
});

test("HandProvider registry rejects duplicate provider ids", () => {
  assert.throws(
    () =>
      createHandProviderRegistry([
        createFakeHandProvider({ providerId: "fake-hand" }),
        createFakeHandProvider({ providerId: "fake-hand" }),
      ]),
    /duplicate hand provider registered: fake-hand/,
  );
});

test("Tork hand provider reports missing workflow input", async () => {
  const provider = createTorkHandProvider({
    callbackUrl: "http://127.0.0.1:3000/api/v2/tork/callback",
    executorProvider: {
      executorType: "tork",
      submit: async () => {
        throw new Error("submit should not be called without workflow input");
      },
    },
  });
  const binding = await provider.provision({
    runId: "run-1",
    taskId: "task-1",
    handName: "tork",
    resources: {},
  });

  const result = await provider.execute(binding, { name: "submit", input: {} });

  assert.equal(result.ok, false);
  assert.equal(result.output, "missing workflow input for Tork hand execution");
  assert.equal(binding.status, "provisioned");
});

test("Tork hand provider submits workflow through executor provider", async () => {
  const submitted: ExecutorSubmitRequest[] = [];
  const provider = createTorkHandProvider({
    callbackUrl: "http://127.0.0.1:3000/api/v2/tork/callback",
    heartbeatUrl: "http://127.0.0.1:3000/api/v2/executor/heartbeat",
    executorProvider: {
      executorType: "tork",
      submit: async (request) => {
        submitted.push(request);
        return {
          executorType: "tork",
          externalJobId: "tork-job-1",
          status: "queued",
          projectionFingerprint: "fingerprint-1",
        };
      },
    },
  });
  const binding = await provider.provision({
    runId: "run-1",
    taskId: "task-1",
    handName: "tork",
    resources: {},
  });
  const workflow = workflowManifest();

  const result = await provider.execute(binding, { name: "submit", input: { workflow } });

  assert.equal(result.ok, true);
  assert.equal(result.output, "tork-job-1");
  assert.equal(binding.status, "running");
  assert.deepEqual(submitted, [{
    runId: "run-1",
    workflow,
    callbackUrl: "http://127.0.0.1:3000/api/v2/tork/callback",
    heartbeatUrl: "http://127.0.0.1:3000/api/v2/executor/heartbeat",
    envelopeBasePath: "/southstar-runs",
    attemptId: "attempt-1",
  }]);
  assert.deepEqual(result.metadata, {
    executorType: "tork",
    projectionFingerprint: "fingerprint-1",
  });
});

function workflowManifest(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-hand-provider",
    title: "Hand provider workflow",
    goalPrompt: "submit from hand provider",
    tasks: [{
      id: "task-1",
      name: "Task",
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
