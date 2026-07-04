import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTaskMaterialization, materializeTaskEnvelope } from "../../src/v2/agent-runner/materializer.ts";
import type { TaskEnvelope, TaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";

test("materializes task envelope only under configured ephemeral run root", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-materializer-"));
  const envelope = minimalEnvelope();

  const result = await materializeTaskEnvelope(envelope, { runRoot: root });

  assert.equal(result.taskDir, join(root, "run-1", "task-1"));
  assert.equal(result.envelopePath, join(root, "run-1", "task-1", "envelope.json"));
  assert.deepEqual(JSON.parse(await readFile(result.envelopePath, "utf8")), envelope);
});

test("cleanup removes materialized task directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-materializer-"));
  const result = await materializeTaskEnvelope(minimalEnvelope(), { runRoot: root });

  await cleanupTaskMaterialization(result);

  await assert.rejects(() => stat(result.taskDir), /ENOENT/);
});

test("materializes v2 task profile, tools, MCP grants, and skill bundle files for Docker mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-materializer-v2-"));
  const envelope = minimalEnvelopeV2();
  envelope.contextPacket.agentsMdBlocks = [{
    id: "agent.engineering-frontend-developer",
    sourceType: "agents-md",
    title: "Frontend Developer",
    text: "Build polished React UI and preserve existing design conventions.",
    sourceRef: "agent.engineering-frontend-developer",
    tokenEstimate: 10,
  }];

  const result = await materializeTaskEnvelope(envelope, { runRoot: root });

  assert.equal(
    await readFile(join(result.taskDir, "AGENTS.md"), "utf8"),
    "# Frontend Developer\n\nBuild polished React UI and preserve existing design conventions.\n",
  );
  assert.deepEqual(JSON.parse(await readFile(join(result.taskDir, "agent-profile", "profile.json"), "utf8")), envelope.agentProfile);
  assert.deepEqual(JSON.parse(await readFile(join(result.taskDir, "tools", "tool-policy.json"), "utf8")), envelope.toolProxyPolicy);
  assert.deepEqual(JSON.parse(await readFile(join(result.taskDir, "mcp", "grants.json"), "utf8")), envelope.mcpGrants);
  assert.deepEqual(JSON.parse(await readFile(join(result.taskDir, "mcp", "runtime-config.json"), "utf8")), envelope.mcpRuntimeConfig);
  assert.equal(await readFile(join(result.taskDir, "skills", "skill.react-ui", "references", "patterns.md"), "utf8"), "Use controlled inputs.");
  const manifest = JSON.parse(await readFile(join(result.taskDir, "runtime-manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "southstar.runtime_bundle_manifest.v1");
  assert.equal(manifest.defaultContainerBasePath, "/southstar-runs/run-v2/task-v2");
  assert.equal(manifest.policy.toolsAreGrantPolicyOnly, true);
  assert.equal(manifest.policy.mcpEntriesAreGrantPolicyOnly, true);
  assert.equal(manifest.files.some((file: { relativePath: string }) => file.relativePath === "AGENTS.md"), true);
  assert.equal(manifest.files.some((file: { relativePath: string }) => file.relativePath === "tools/tool-policy.json"), true);
  assert.equal(manifest.files.some((file: { relativePath: string }) => file.relativePath === "mcp/grants.json"), true);
  assert.equal(manifest.files.some((file: { relativePath: string }) => file.relativePath === "mcp/runtime-config.json"), true);
  assert.equal(manifest.files.some((file: { relativePath: string }) => file.relativePath === "skills/skill.react-ui/references/patterns.md"), true);
});

function minimalEnvelope(): TaskEnvelope {
  return {
    schemaVersion: "southstar.task-envelope.v1",
    runId: "run-1",
    workflowId: "workflow-1",
    task: {
      id: "task-1",
      name: "Task",
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
      subagents: [],
    },
    rootSession: { id: "session-1", validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
    subagents: [],
    memory: { items: [], capturedAt: "now" },
    skills: [],
    vaultLeases: [],
    mcpGrants: [],
    artifactContracts: [],
    artifactContract: { artifactTypes: [], requiredFields: [] },
  };
}

function minimalEnvelopeV2(): TaskEnvelopeV2 {
  return {
    schemaVersion: "southstar.task-envelope.v2",
    runId: "run-v2",
    workflowId: "workflow-v2",
    taskId: "task-v2",
    domain: "software",
    intent: "implement_feature",
    role: {
      id: "frontend-developer",
      responsibility: "Build UI",
      defaultAgentProfileRef: "profile.generated.todo.task-v2",
      allowedAgentProfileRefs: ["profile.generated.todo.task-v2"],
      artifactInputs: [],
      artifactOutputs: ["web_app"],
      stopAuthority: "can-suggest",
    },
    agentProfile: {
      id: "profile.generated.todo.task-v2",
      name: "Todo UI",
      provider: "codex",
      model: "gpt-5",
      harnessRef: "codex",
      agentsMdRefs: [],
      promptTemplateRef: "instruction.react-review",
      skillRefs: ["skill.react-ui"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      memoryScopes: [],
      contextPolicyRef: "context.generated",
      sessionPolicyRef: "session.generated",
      toolPolicy: { allowedTools: ["tool.workspace-write"], deniedTools: [], requiresApprovalFor: [] },
      budgetPolicy: { maxInputTokens: 12000, maxOutputTokens: 2000, maxWallTimeSeconds: 900 },
      instruction: "Build the UI.",
    },
    harness: {
      id: "codex",
      kind: "codex",
      entrypoint: "southstar-agent-runner",
      image: "southstar-agent-runner",
      capabilities: ["workspace"],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    },
    contextPacket: {
      id: "ctx-v2",
      runId: "run-v2",
      taskId: "task-v2",
      rootSessionId: "session-v2",
      executionAttempt: 1,
      roleRef: "frontend-developer",
      agentProfileRef: "profile.generated.todo.task-v2",
      taskGoal: "Build todo app",
      roleInstruction: "Build UI",
      systemInstruction: "instruction.react-review",
      agentsMdBlocks: [],
      artifactContracts: [],
      selectedMemories: [],
      selectedKnowledgeCards: [],
      priorArtifacts: [],
      skillInstructions: [],
      mcpGrantSummary: [],
      forbiddenActions: [],
      budget: { maxInputTokens: 12000, maxOutputTokens: 2000, maxWallTimeSeconds: 900 },
      tokenEstimate: { total: 0, bySourceType: {} },
      excludedCandidates: [],
      managedSourceRefs: {
        rawEventRefs: [],
        omittedEventRanges: [],
        transformRefs: [],
        checkpointRefs: [],
      },
    },
    agentPrompt: "Build todo app",
    skills: [{
      skillId: "skill.react-ui",
      version: "skill.react-ui@1",
      instructions: "Build React UI.",
      allowedTools: ["workspace-write"],
      requiredMounts: ["workspace"],
      mcpRequirements: ["filesystem-workspace"],
      artifactContracts: [],
      contentHash: "hash",
      mountPath: "/skills/skill.react-ui",
      bundleFiles: [{
        relativePath: "references/patterns.md",
        contentBase64: Buffer.from("Use controlled inputs.", "utf8").toString("base64"),
        contentHash: "bundle-hash",
      }],
    }],
    mcpGrants: [{ serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] }],
    mcpRuntimeConfig: {
      schemaVersion: "southstar.mcp_runtime_config.v1",
      runId: "run-v2",
      taskId: "task-v2",
      servers: [{
        serverId: "filesystem-workspace",
        transport: "stdio",
        allowedTools: ["read_file", "write_file"],
        command: {
          argv: ["node", "/app/src/v2/mcp/filesystem-workspace-server.ts"],
          cwd: "/workspace/repo",
        },
        envFromVault: [],
      }],
      policy: {
        failClosed: true,
        secretsMaterializedByVault: true,
        configContainsSecretValues: false,
      },
    },
    vaultLeases: [],
    toolProxyPolicy: {
      schemaVersion: "southstar.tool_proxy_policy.v1",
      runId: "run-v2",
      sessionId: "session-v2",
      allowedTools: ["workspace-write"],
      requiredProxyTools: ["workspace-write-proxy"],
      forbiddenDirectEnvKeys: [],
      vaultLeaseRefs: [],
      maxLeaseTtlSeconds: 900,
      redactResultPayloads: true,
      failClosed: true,
    },
    materializedLibraryRefs: {
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      vaultLeasePolicyRefs: [],
    },
    artifactContracts: [],
    evaluatorPipeline: { id: "evaluator.generated", evaluators: [], onFailure: { defaultStrategy: "ask-human" } },
    session: { sessionId: "session-v2", maxRepairAttempts: 1 },
  };
}
