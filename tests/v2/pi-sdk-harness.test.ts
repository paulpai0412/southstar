import test from "node:test";
import assert from "node:assert/strict";
import { createPiSdkAgentHarness } from "../../src/v2/harness/pi-sdk-harness.ts";
import type { TaskEnvelope } from "../../src/v2/agent-runner/task-envelope.ts";

test("Pi SDK agent harness sends TaskEnvelope prompt and parses assistant artifact JSON", async () => {
  const prompts: string[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const harness = createPiSdkAgentHarness({
    createSession: async () => ({
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      prompt: async (prompt: string) => {
        prompts.push(prompt);
        listeners.forEach((listener) => listener({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({
              artifact: { summary: "implemented", commandsRun: ["npm test"], risks: ["low"] },
              progress: ["read repo", "edited cli", "ran tests"],
              metrics: { tokens: 10, costMicrosUsd: 20, toolCalls: 3, retryCount: 0 },
            }) }],
          }],
        }));
      },
    }),
  });

  const result = await harness.run({
    envelope: envelope(),
    attempt: 2,
    repairInstruction: "include commandsRun",
  });

  assert.match(prompts[0], /TaskEnvelope/);
  assert.match(prompts[0], /include commandsRun/);
  assert.deepEqual(result.artifact, { summary: "implemented", commandsRun: ["npm test"], risks: ["low"] });
  assert.deepEqual(result.progress, ["read repo", "edited cli", "ran tests"]);
  assert.equal(result.metrics?.toolCalls, 3);
});

test("Pi SDK agent harness canonicalizes bare assistant artifact JSON", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const harness = createPiSdkAgentHarness({
    createSession: async () => ({
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      prompt: async () => {
        listeners.forEach((listener) => listener({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: "```json\n{\"summary\":\"planned\",\"commandsRun\":[],\"risks\":[\"none\"]}\n```" }],
          }],
        }));
      },
    }),
  });

  const result = await harness.run({ envelope: envelope(), attempt: 1 });

  assert.deepEqual(result.artifact, { summary: "planned", commandsRun: [], risks: ["none"] });
  assert.deepEqual(result.progress, ["pi-agent returned artifact"]);
});

function envelope(): TaskEnvelope {
  return {
    schemaVersion: "southstar.task-envelope.v1",
    runId: "run-1",
    workflowId: "workflow-1",
    task: {
      id: "task-1",
      name: "Implement",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "image",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 60,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "impl", harnessId: "pi", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    },
    rootSession: { id: "session-root", validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
    subagents: [{ id: "impl", harnessId: "pi", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    memory: { items: [], capturedAt: "now" },
    vaultLeases: [],
    mcpGrants: [],
    artifactContracts: ["implementation-report"],
    artifactContract: { artifactTypes: ["implementation-report"], requiredFields: ["summary", "commandsRun", "risks"] },
  };
}
