import test from "node:test";
import assert from "node:assert/strict";
import { runTaskEnvelope } from "../../src/v2/agent-runner/task-runner.ts";
import type { TaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";
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

  const taskEnvelope = envelopeV2();
  taskEnvelope.session.maxRepairAttempts = 2;
  const result = await runTaskEnvelope(taskEnvelope, harness, {
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

test("container runner can inject a validation fault after harness execution", async () => {
  let harnessCalls = 0;
  const harness: AgentHarness = {
    id: "pi",
    async run() {
      harnessCalls += 1;
      return {
        artifact: { summary: "implemented", commandsRun: ["npm test"], risks: [] },
        progress: ["implemented before runtime fault"],
        metrics: { tokens: 10 },
      };
    },
  };

  const result = await runTaskEnvelope(envelopeV2(), harness, {
    requiredFields: ["summary", "commandsRun", "risks"],
    attemptId: "task-1-attempt-1",
    runtimeFault: {
      kind: "validation_missing_fields",
      fields: ["summary"],
      attemptIds: ["task-1-attempt-1"],
      reason: "controlled abnormal E2E first attempt",
    },
  });

  assert.equal(harnessCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.artifact.summary, undefined);
  assert.deepEqual(result.artifact.faultInjected, {
    kind: "validation_missing_fields",
    fields: ["summary"],
    reason: "controlled abnormal E2E first attempt",
  });
  assert.equal(result.events.some((event) => event.eventType === "runtime.fault_injected"), true);
  assert.equal(
    result.events.some((event) =>
      event.eventType === "evaluator.completed" &&
      Array.isArray((event.payload as { missingFields?: unknown }).missingFields) &&
      ((event.payload as { missingFields: string[] }).missingFields.includes("summary"))
    ),
    true,
  );
});

test("container runner runtime fault applies to the first repair loop attempt by default", async () => {
  const retryEnvelope = envelopeV2();
  retryEnvelope.session.maxRepairAttempts = 2;
  let harnessCalls = 0;
  const harness: AgentHarness = {
    id: "pi",
    async run(input) {
      harnessCalls += 1;
      return input.attempt === 1
        ? {
          artifact: { summary: "implemented", commandsRun: ["npm test"], risks: [] },
          progress: ["first attempt before runtime fault"],
          metrics: { tokens: 10 },
        }
        : {
          artifact: { summary: "repaired", commandsRun: ["npm test"], risks: [] },
          progress: ["repair attempt after runtime fault"],
          metrics: { tokens: 20, retryCount: 1 },
        };
    },
  };

  const result = await runTaskEnvelope(retryEnvelope, harness, {
    requiredFields: ["summary", "commandsRun", "risks"],
    attemptId: "task-1-attempt-1",
    runtimeFault: {
      kind: "validation_missing_fields",
      fields: ["summary"],
      attemptIds: ["task-1-attempt-1"],
      reason: "controlled first runner attempt failure",
    },
  });

  assert.equal(harnessCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.artifact.summary, "repaired");
  assert.equal(result.events.filter((event) => event.eventType === "runtime.fault_injected").length, 1);
});

test("container runner runtime fault removes required fields from nested artifact shapes", async () => {
  const harness: AgentHarness = {
    id: "pi",
    async run() {
      return {
        artifact: {
          implementation_report: {
            summary: "nested summary",
            commandsRun: ["npm test"],
            risks: [],
          },
        },
        progress: ["nested artifact returned"],
        metrics: { tokens: 10 },
      };
    },
  };

  const result = await runTaskEnvelope(envelopeV2(), harness, {
    requiredFields: ["summary", "commandsRun", "risks"],
    attemptId: "task-1-attempt-1",
    runtimeFault: {
      kind: "validation_missing_fields",
      fields: ["summary"],
      attemptIds: ["task-1-attempt-1"],
      reason: "nested summary must be removed before validation",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(((result.artifact.implementation_report as Record<string, unknown>).summary), undefined);
  assert.equal(result.events.some((event) =>
    event.eventType === "evaluator.completed" &&
    ((event.payload as { missingFields?: string[] }).missingFields ?? []).includes("summary")
  ), true);
});

test("container runner runtime fault can attach failed upstream artifact refs", async () => {
  const harness: AgentHarness = {
    id: "pi",
    async run() {
      return {
        artifact: { summary: "consumer inspected upstream output", commandsRun: ["npm test"], risks: [] },
        progress: ["consumer finished before upstream lineage fault"],
        metrics: { tokens: 10 },
      };
    },
  };

  const result = await runTaskEnvelope(envelopeV2(), harness, {
    requiredFields: ["summary", "commandsRun", "risks"],
    attemptId: "task-1-attempt-1",
    runtimeFault: {
      kind: "validation_missing_fields",
      fields: ["summary"],
      attemptIds: ["task-1-attempt-1"],
      reason: "consumer rejected upstream artifact",
      failedArtifactRefs: ["artifact-ref-producer-1"],
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.artifact.failedArtifactRefs, ["artifact-ref-producer-1"]);
  assert.deepEqual(result.artifact.faultInjected, {
    kind: "validation_missing_fields",
    fields: ["summary"],
    reason: "consumer rejected upstream artifact",
    failedArtifactRefs: ["artifact-ref-producer-1"],
  });
});

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
