import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinAgentHarness } from "../../src/v2/harness/builtin-agent-harness.ts";
import type { TaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";

test("builtin harness validates fan-in acceptance tasks with concrete command evidence", async () => {
  const repo = createCalcCliFixture();
  const previousRepoPath = process.env.REPO_PATH;
  process.env.REPO_PATH = repo;
  try {
    const result = await createBuiltinAgentHarness().run({
      envelope: envelope("fan-in-acceptance"),
      attempt: 1,
    });

    assert.ok(Array.isArray(result.artifact.commandsRun));
    assert.equal((result.artifact.commandsRun as unknown[]).length >= 2, true);
    assert.ok(Array.isArray(result.artifact.testResults));
    assert.equal((result.artifact.testResults as unknown[]).length >= 2, true);
    assert.deepEqual(result.artifact.checkerFindings, []);
  } finally {
    restoreRepoPath(previousRepoPath);
  }
});

test("builtin harness summarizes accepted artifacts with test evidence", async () => {
  const repo = createCalcCliFixture();
  const previousRepoPath = process.env.REPO_PATH;
  process.env.REPO_PATH = repo;
  try {
    const result = await createBuiltinAgentHarness().run({
      envelope: envelope("summarize-completion", ["fan-in-acceptance"]),
      attempt: 1,
    });

    assert.deepEqual(result.artifact.acceptedArtifacts, ["fan-in-acceptance"]);
    assert.ok(Array.isArray(result.artifact.tests));
    assert.equal((result.artifact.tests as unknown[]).length >= 2, true);
  } finally {
    restoreRepoPath(previousRepoPath);
  }
});

function createCalcCliFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "southstar-builtin-harness-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node test.js",
      cli: "node cli.js",
    },
  }, null, 2));
  writeFileSync(join(repo, "test.js"), "process.exit(0);\n");
  writeFileSync(join(repo, "cli.js"), [
    "const [, , command, ...args] = process.argv;",
    "if (command !== 'sum' || args.length === 0) process.exit(1);",
    "const values = args.map(Number);",
    "if (values.some((value) => !Number.isFinite(value))) process.exit(1);",
    "console.log(values.reduce((total, value) => total + value, 0));",
  ].join("\n"));
  return repo;
}

function envelope(taskId: string, priorArtifactRefs: string[] = []): TaskEnvelopeV2 {
  return {
    schemaVersion: "southstar.task-envelope.v2",
    runId: "run-builtin",
    workflowId: "workflow-builtin",
    taskId,
    domain: "software",
    intent: "implement_feature",
    role: { id: "checker", name: "Checker", responsibility: "Verify", defaultAgentProfileRef: "checker", allowedAgentProfileRefs: ["checker"] },
    agentProfile: {
      id: "checker",
      name: "Checker",
      provider: "codex",
      model: "gpt-5-codex",
      harnessRef: "codex",
      agentsMdRefs: [],
      promptTemplateRef: "checker",
      skillRefs: [],
      mcpGrantRefs: [],
      memoryScopes: [],
      contextPolicyRef: "context",
      sessionPolicyRef: "session",
      toolPolicy: { allowedTools: ["shell"], deniedTools: [], requiresApprovalFor: [] },
      budgetPolicy: { maxInputTokens: 1000, maxOutputTokens: 1000, maxWallTimeSeconds: 60 },
    },
    harness: {
      id: "codex",
      kind: "codex",
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
      id: "ctx-builtin",
      runId: "run-builtin",
      taskId,
      rootSessionId: "session-builtin",
      executionAttempt: 1,
      roleRef: "checker",
      agentProfileRef: "checker",
      taskGoal: "verify calc sum",
      roleInstruction: "Verify",
      agentsMdBlocks: [],
      artifactContracts: [],
      selectedMemories: [],
      priorArtifacts: priorArtifactRefs.map((ref) => ({
        id: `artifact-${ref}`,
        sourceType: "artifact" as const,
        title: ref,
        text: `Prior artifact ${ref}.`,
        sourceRef: ref,
        tokenEstimate: 4,
      })),
      skillInstructions: [],
      mcpGrantSummary: [],
      forbiddenActions: [],
      budget: { maxInputTokens: 1000, maxOutputTokens: 1000, maxWallTimeSeconds: 60 },
      tokenEstimate: { total: 0, bySourceType: {} },
      excludedCandidates: [],
    },
    agentPrompt: "prompt",
    skills: [],
    mcpGrants: [],
    vaultLeases: [],
    artifactContracts: [],
    evaluatorPipeline: { id: "pipeline", evaluators: [], onFailure: { defaultStrategy: "fork-from-checkpoint" } },
    session: { sessionId: "session-builtin", maxRepairAttempts: 1 },
  };
}

function restoreRepoPath(previousRepoPath: string | undefined): void {
  if (previousRepoPath === undefined) {
    delete process.env.REPO_PATH;
  } else {
    process.env.REPO_PATH = previousRepoPath;
  }
}
