import test from "node:test";
import assert from "node:assert/strict";
import { runTaskEnvelope } from "../../src/v2/agent-runner/task-runner.ts";
import type { TaskEnvelope, TaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";
import type { AgentHarness } from "../../src/v2/harness/types.ts";

test("container runner emits root session, repair, evaluator, and subagent events", async () => {
  const harness: AgentHarness = {
    id: "codex",
    async run(input) {
      if (input.attempt === 1) {
        return {
          artifact: { summary: "missing required fields" },
          progress: ["started implementation"],
          metrics: { tokens: 10, costMicrosUsd: 100, toolCalls: 1, retryCount: 0 },
        };
      }
      assert.match(input.repairInstruction ?? "", /commandsRun, risks/);
      return {
        artifact: { summary: "implemented", commandsRun: ["npm test"], risks: ["low"] },
        progress: ["repaired implementation"],
        metrics: { tokens: 20, costMicrosUsd: 200, toolCalls: 2, retryCount: 1 },
      };
    },
  };

  const result = await runTaskEnvelope(envelope(), harness, {
    requiredFields: ["summary", "commandsRun", "risks"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.events.map((event) => event.eventType), [
    "session.entry",
    "task.started",
    "progress.commentary",
    "artifact.created",
    "evaluator.completed",
    "repair.requested",
    "progress.commentary",
    "artifact.created",
    "evaluator.completed",
    "subagent.completed",
  ]);
  assert.deepEqual(result.artifact, { summary: "implemented", commandsRun: ["npm test"], risks: ["low"] });
  assert.equal(result.metrics.tokens, 30);
  assert.equal(result.metrics.costMicrosUsd, 300);
  assert.equal(result.metrics.toolCalls, 3);
  assert.equal(result.metrics.retryCount, 1);
});

test("container runner records runtime fallback metrics when harness omits self-reported metrics", async () => {
  const harness: AgentHarness = {
    id: "pi",
    async run() {
      return {
        artifact: { summary: "implemented", commandsRun: ["npm test"], risks: [] },
        progress: ["implemented without self-reported metrics"],
      };
    },
  };

  const result = await runTaskEnvelope(envelopeV2(), harness, {
    requiredFields: ["summary", "commandsRun", "risks"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.metrics.tokens, 321);
  assert.equal(result.metrics.durationMs > 0, true);
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
      subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    },
    rootSession: { id: "session-root", validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
    subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
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
    role: { id: "maker", responsibility: "Implement software changes." },
    agentProfile: {
      id: "software-maker-pi",
      roleRef: "maker",
      providerRef: "pi",
      model: "pi-default",
      harnessRef: "pi",
      promptTemplateRef: "software-maker",
      skillRefs: [],
      mcpGrantRefs: [],
      memoryScopeRefs: [],
      contextPolicyRef: "context",
      sessionPolicyRef: "session",
      toolPolicy: { allowedTools: [] },
    },
    harness: { id: "pi", provider: "pi-sdk", endpoint: "local" },
    contextPacket: {
      id: "ctx-1",
      runId: "run-1",
      taskId: "task-1",
      rootSessionId: "session-root",
      executionAttempt: 1,
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      taskGoal: "implement calc sum",
      roleInstruction: "Implement",
      agentsMdBlocks: [],
      artifactContracts: [],
      selectedMemories: [],
      priorArtifacts: [],
      skillInstructions: [],
      mcpGrantSummary: [],
      forbiddenActions: [],
      budget: { maxInputTokens: 1000, maxOutputTokens: 1000, compressionStrategy: "summarize-oldest" },
      tokenEstimate: { total: 321, bySourceType: { prompt: 321 } },
      excludedCandidates: [],
    },
    agentPrompt: "implement calc sum",
    skills: [],
    mcpGrants: [],
    vaultLeases: [],
    artifactContracts: [{ id: "implementation_report", fields: ["summary", "commandsRun", "risks"] }],
    evaluatorPipeline: { id: "software-feature-quality", evaluators: [], onFailure: { defaultStrategy: "retry-same-agent" } },
    session: { sessionId: "session-root", maxRepairAttempts: 1 },
  };
}
