import test from "node:test";
import assert from "node:assert/strict";
import { createPiSdkAgentHarness } from "../../src/v2/harness/pi-sdk-harness.ts";
import type { TaskEnvelope, TaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";

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

test("Pi SDK agent harness sends TaskEnvelopeV2 rendered agent prompt", async () => {
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
              artifact: { summary: "implemented", commandsRun: ["npm test"], risks: [] },
              progress: ["used rendered prompt"],
            }) }],
          }],
        }));
      },
    }),
  });

  await harness.run({ envelope: envelopeV2(), attempt: 1 });

  assert.match(prompts[0], /Rendered prompt from ContextPacket/);
  assert.match(prompts[0], /Implement calc sum from context/);
  assert.doesNotMatch(prompts[0], /"schemaVersion":"southstar.task-envelope.v2"/);
});

test("Pi SDK agent harness runs mounted workspace tasks from /workspace/repo", async () => {
  const prompts: string[] = [];
  const sessionInputs: Array<{ cwd: string }> = [];
  const listeners: Array<(event: unknown) => void> = [];
  const harness = createPiSdkAgentHarness({
    createSession: async (input) => {
      sessionInputs.push(input);
      return {
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
                artifact: { summary: "implemented", commandsRun: ["npm test"], risks: [] },
                progress: ["used mounted workspace"],
              }) }],
            }],
          }));
        },
      };
    },
  });

  const env = envelopeV2();
  env.skills = [{
    skillId: "software.calc-cli",
    version: "2026-06-12",
    instructions: "Use the mounted repository.",
    allowedTools: ["shell", "edit"],
    requiredMounts: ["/workspace/repo"],
    mcpRequirements: [],
    artifactContracts: ["implementation_report"],
    contentHash: "hash",
    mountPath: "/southstar/skills/software.calc-cli",
  }];

  await harness.run({ envelope: env, attempt: 1 });

  assert.equal(sessionInputs[0]?.cwd, "/workspace/repo");
  assert.match(prompts[0], /Execution workspace: \/workspace\/repo/);
  assert.match(prompts[0], /change directory to \/workspace\/repo/i);
  assert.match(prompts[0], /Do not modify \/app/);
  assert.match(prompts[0], /=== SKILL INSTRUCTIONS ===/);
  assert.match(prompts[0], /## software\.calc-cli@2026-06-12/);
  assert.match(prompts[0], /Use the mounted repository\./);
  assert.match(prompts[0], /=== END SKILL INSTRUCTIONS ===/);
});

test("Pi SDK agent harness defaults v2 workspace tasks to /workspace/repo when envelope carries workspace handle", async () => {
  const sessionInputs: Array<{ cwd: string }> = [];
  const listeners: Array<(event: unknown) => void> = [];
  const harness = createPiSdkAgentHarness({
    createSession: async (input) => {
      sessionInputs.push(input);
      return {
        subscribe: (listener: (event: unknown) => void) => {
          listeners.push(listener);
          return () => undefined;
        },
        prompt: async () => {
          listeners.forEach((listener) => listener({
            type: "agent_end",
            messages: [{
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify({ artifact: { summary: "ok" }, progress: ["done"] }) }],
            }],
          }));
        },
      };
    },
  });

  const env = envelopeV2();
  env.workspace = {
    handle: {
      repoRoot: "/tmp/non-mounted-host-path",
      worktreePath: "/tmp/non-mounted-host-path",
    },
  };

  await harness.run({ envelope: env, attempt: 1 });

  assert.equal(sessionInputs[0]?.cwd, "/workspace/repo");
});

test("Pi SDK agent harness bounds session creation with the harness timeout", async () => {
  const harness = createPiSdkAgentHarness({
    timeoutMs: 5,
    createSession: async () => new Promise(() => undefined),
  });

  const outcome = await Promise.race([
    harness.run({ envelope: envelopeV2(), attempt: 1 }).then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 25)),
  ]);

  assert.equal(outcome, "Pi SDK harness timed out while creating session after 5ms");
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
    skills: [],
    vaultLeases: [],
    mcpGrants: [],
    artifactContracts: ["implementation-report"],
    artifactContract: { artifactTypes: ["implementation-report"], requiredFields: ["summary", "commandsRun", "risks"] },
  };
}

function envelopeV2(): TaskEnvelopeV2 {
  return {
    schemaVersion: "southstar.task-envelope.v2",
    runId: "run-1",
    workflowId: "workflow-1",
    taskId: "task-1",
    domain: "software",
    intent: "implement_feature",
    role: {
      id: "maker",
      responsibility: "Implement feature",
      defaultAgentProfileRef: "software-maker-pi",
      allowedAgentProfileRefs: ["software-maker-pi"],
      artifactInputs: [],
      artifactOutputs: ["implementation_report"],
      stopAuthority: "none",
    },
    agentProfile: {
      id: "software-maker-pi",
      name: "Maker",
      provider: "pi",
      model: "pi-agent-default",
      harnessRef: "pi",
      agentsMdRefs: [],
      promptTemplateRef: "software-maker",
      skillRefs: [],
      mcpGrantRefs: [],
      memoryScopes: ["software"],
      contextPolicyRef: "software-context-default",
      sessionPolicyRef: "software-session-default",
      toolPolicy: { allowedTools: ["read", "edit"], deniedTools: [], requiresApprovalFor: [] },
      budgetPolicy: { maxInputTokens: 10_000, maxOutputTokens: 2_000 },
    },
    harness: {
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    },
    contextPacket: {
      id: "ctx-1",
      runId: "run-1",
      taskId: "task-1",
      executionAttempt: 1,
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      taskGoal: "Implement calc sum",
      roleInstruction: "Implement feature",
      agentsMdBlocks: [],
      artifactContracts: [],
      selectedMemories: [],
      priorArtifacts: [],
      skillInstructions: [],
      mcpGrantSummary: [],
      forbiddenActions: [],
      budget: { maxInputTokens: 10_000, maxOutputTokens: 2_000 },
      tokenEstimate: { total: 1, bySourceType: { prompt: 1 } },
      excludedCandidates: [],
    },
    agentPrompt: "Rendered prompt from ContextPacket\nImplement calc sum from context",
    skills: [],
    mcpGrants: [],
    vaultLeases: [],
    artifactContracts: [],
    evaluatorPipeline: { id: "software-feature-quality", evaluators: [], onFailure: { defaultStrategy: "rollback-workspace" } },
    session: { sessionId: "session-root" },
  };
}
