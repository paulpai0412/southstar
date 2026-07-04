import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import type { ContextPacket } from "../../src/v2/context/types.ts";

test("TaskEnvelopeV2 carries resolved runtime inputs and renders prompt from ContextPacket", () => {
  const role = required(softwareDomainPack.roles.find((item) => item.id === "maker"));
  const agentProfile = required(softwareDomainPack.agentProfiles.find((item) => item.id === "software-maker-pi"));
  const artifactContracts = softwareDomainPack.artifactContracts.filter((item) => item.id === "implementation_report");
  const evaluatorPipeline = required(softwareDomainPack.evaluatorPipelines.find((item) => item.id === "software-feature-quality"));
  const envelope = buildTaskEnvelopeV2({
    runId: "run-env2",
    workflowId: "wf-env2",
    taskId: "implement-feature",
    domain: "software",
    intent: "implement_feature",
    role,
    agentProfile,
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
    contextPacket: contextPacket(agentProfile.budgetPolicy),
    skills: [],
    mcpGrants: [{ serverId: "filesystem-workspace", allowedTools: ["read", "edit"] }],
    vaultLeases: [{ leaseRef: "vault-lease-1", mountAs: "file", secretValue: "do-not-leak" }],
    artifactContracts,
    evaluatorPipeline,
    toolProxyPolicy: {
      schemaVersion: "southstar.tool_proxy_policy.v1",
      runId: "run-env2",
      sessionId: "session-1",
      allowedTools: ["workspace-read"],
      requiredProxyTools: ["workspace-read-proxy"],
      forbiddenDirectEnvKeys: [],
      vaultLeaseRefs: [],
      maxLeaseTtlSeconds: 900,
      redactResultPayloads: true,
      failClosed: true,
    },
    materializedLibraryRefs: {
      instructionRefs: ["instruction.software"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      vaultLeasePolicyRefs: [],
    },
    session: { sessionId: "session-1", baseCheckpointId: "checkpoint-0" },
    workspace: {
      handle: { repoRoot: "/tmp/repo", worktreePath: "/tmp/repo" },
      baseSnapshotRef: { provider: "git", repoRoot: "/tmp/repo", commitSha: "0".repeat(40) },
    },
  });

  assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
  assert.equal(envelope.contextPacket.id, "ctx-env2");
  assert.equal(envelope.agentProfile.model, "pi-agent-default");
  assert.equal(envelope.mcpGrants[0]?.serverId, "filesystem-workspace");
  assert.equal(envelope.workspace?.baseSnapshotRef?.provider, "git");
  assert.match(envelope.agentPrompt, /ContextPacket: ctx-env2/);
  assert.match(envelope.agentPrompt, /Task goal:\nImplement calc sum/);
  assert.match(envelope.agentPrompt, /Southstar runtime owns workflow orchestration, session state, evaluator execution, and stop-condition decisions/);
  assert.match(envelope.agentPrompt, /Runtime grants:/);
  assert.match(envelope.agentPrompt, /These entries are grant policy, not bundled tool or MCP server implementations/);
  assert.match(envelope.agentPrompt, /Allowed tools: workspace-read/);
  assert.match(envelope.agentPrompt, /Required proxy tools: workspace-read-proxy/);
  assert.match(envelope.agentPrompt, /MCP grant filesystem-workspace: read, edit/);
  assert.match(envelope.agentPrompt, /Materialized library refs: instruction\.software, skill\.react-ui, tool\.workspace-read, mcp\.filesystem-workspace/);
  assert.match(envelope.agentPrompt, /Memory:\n- Prefer tests around calc sum behavior/);
  assert.match(envelope.agentPrompt, /Artifact contracts:\n- implementation_report/);
  assert.doesNotMatch(JSON.stringify(envelope), /do-not-leak/);
});

function contextPacket(budget: ContextPacket["budget"]): ContextPacket {
  return {
    id: "ctx-env2",
    runId: "run-env2",
    taskId: "implement-feature",
    rootSessionId: "session-1",
    executionAttempt: 1,
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    taskGoal: "Implement calc sum",
    roleInstruction: "Implement the feature with tests and documentation.",
    agentsMdBlocks: [{ id: "agents", sourceType: "agents-md", title: "AGENTS", text: "Follow repo instructions.", tokenEstimate: 5 }],
    artifactContracts: [{ id: "artifact", sourceType: "artifact", title: "implementation_report", text: "Return summary, commandsRun, risks.", tokenEstimate: 7 }],
    selectedMemories: [{ id: "memory-preference", sourceType: "memory", title: "preference", text: "Prefer tests around calc sum behavior.", sourceRef: "mem-1", tokenEstimate: 9 }],
    priorArtifacts: [],
    checkpointSummary: { id: "checkpoint", sourceType: "checkpoint", title: "Checkpoint", text: "base checkpoint", tokenEstimate: 4 },
    workspaceSummary: { id: "workspace", sourceType: "workspace", title: "Workspace", text: "fixture repo", tokenEstimate: 3 },
    skillInstructions: [{ id: "skill", sourceType: "skill", title: "software.calc-cli", text: "Use calc CLI skill.", tokenEstimate: 4 }],
    mcpGrantSummary: [{ id: "mcp", sourceType: "mcp", title: "filesystem-workspace", text: "read, edit", tokenEstimate: 2 }],
    forbiddenActions: ["external-write"],
    budget,
    tokenEstimate: { total: 34, bySourceType: { prompt: 4, memory: 9 } },
    excludedCandidates: [{ sourceRef: "mem-unsupported", reason: "kind-mismatch", tokenEstimate: 5 }],
  };
}

function required<T>(value: T | undefined): T {
  if (!value) throw new Error("missing fixture value");
  return value;
}
