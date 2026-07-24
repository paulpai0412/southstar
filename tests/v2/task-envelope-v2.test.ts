import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";
import type { ContextPacket } from "../../src/v2/context/types.ts";
import { implementationReportContract, makerAgentProfile, makerRole, softwareFeatureQualityPipeline } from "./fixtures/runtime-manifest-primitives.ts";

test("TaskEnvelopeV2 carries resolved runtime inputs and renders prompt from ContextPacket", () => {
  const role = makerRole();
  const agentProfile = makerAgentProfile();
  const artifactContracts = [{
    ...implementationReportContract(),
    requiredFields: ["summary", "commandsRun"],
    evidenceFields: ["summary", "commandsRun"],
    evidenceKinds: ["command-output", "test-result", "url", "screenshot", "artifact-ref"],
  }];
  const evaluatorPipeline = softwareFeatureQualityPipeline();
  evaluatorPipeline.evaluators = [{
    id: "browser-criterion",
    kind: "checker-agent",
    required: true,
    config: {
      criterionId: "criterion-quiz",
      acceptanceCriterion: "The quiz flow works in the browser.",
      verificationMode: "browser_interaction",
      instruction: "Open the rendered app and complete the frozen user journey.",
      expectedEvidenceKinds: ["command-output", "screenshot"],
    },
  }];
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
  assert.match(envelope.agentPrompt, /Frozen Goal requirement context:/);
  assert.match(envelope.agentPrompt, /Complete blocking requirement IDs: req-entry, req-quiz/);
  assert.match(envelope.agentPrompt, /never validate coverage against a self-declared subset/);
  assert.match(envelope.agentPrompt, /Southstar runtime owns workflow orchestration, session state, evaluator execution, and stop-condition decisions/);
  assert.match(envelope.agentPrompt, /every command must be bounded and must clean up any server or child process it starts/);
  assert.match(envelope.agentPrompt, /Never use a synchronous child-process call from the same event loop that is hosting the server/);
  assert.match(envelope.agentPrompt, /Runtime grants:/);
  assert.match(envelope.agentPrompt, /These entries are grant policy, not bundled tool or MCP server implementations/);
  assert.match(envelope.agentPrompt, /Allowed tools: workspace-read/);
  assert.match(envelope.agentPrompt, /Required proxy tools: workspace-read-proxy/);
  assert.match(envelope.agentPrompt, /MCP grant filesystem-workspace: read, edit/);
  assert.match(envelope.agentPrompt, /Materialized library refs: instruction\.software, skill\.react-ui, tool\.workspace-read, mcp\.filesystem-workspace/);
  assert.match(envelope.agentPrompt, /Memory:\n- Prefer tests around calc sum behavior/);
  assert.match(envelope.agentPrompt, /Artifact contracts:\n- implementation_report/);
  assert.match(envelope.agentPrompt, /Prior artifacts:\n- ArtifactRef: artifact_ref:run-env2:task-build:attempt-1:abc/);
  assert.match(envelope.agentPrompt, /verifiedArtifactRefs/);
  assert.match(envelope.agentPrompt, /Every criteriaResults\[\]\.evidenceRefs value must equal the id of a schema-valid evidence record/);
  assert.match(envelope.agentPrompt, /A command-output record cited by criteriaResults must use this schema on one object/);
  assert.match(envelope.agentPrompt, /Prefer adding id and evidenceKind to the exact commandsRun item and citing that id/);
  assert.match(envelope.agentPrompt, /testResults\.status allowed values: passed, failed, failed_non_gating, blocked, not-verified, not-run, skipped, pass_with_environment_gap/);
  assert.match(envelope.agentPrompt, /A cited URL record must include/);
  assert.match(envelope.agentPrompt, /A cited screenshot record must include/);
  assert.match(envelope.agentPrompt, /A cited artifact-ref record must include/);
  assert.match(envelope.agentPrompt, /Procedure: Open the rendered app and complete the frozen user journey\./);
  assert.match(envelope.agentPrompt, /execute direct playwright-cli commands in this runtime/);
  assert.match(envelope.agentPrompt, /reported-only or shell-chained commands do not count/);
  assert.match(envelope.agentPrompt, /Run each playwright-cli command as its own direct bash tool call/);
  assert.match(envelope.agentPrompt, /playwright-cli open <url> --browser chromium/);
  assert.match(envelope.agentPrompt, /screenshot evidence requires a successful playwright-cli screenshot command/);
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
    goalRequirementContext: {
      schemaVersion: "southstar.task_goal_requirement_context.v1",
      goalContractHash: "a".repeat(64),
      targetRequirementIds: ["req-quiz"],
      blockingRequirementIds: ["req-entry", "req-quiz"],
      requirements: [{
        id: "req-entry",
        statement: "Entries can be created.",
        blocking: true,
        acceptanceCriteria: ["Entry creation passes."],
        expectedArtifacts: [{ mediaType: "application/json", description: "Entry evidence" }],
        producerTaskIds: ["implement-entry"],
        evaluatorTaskIds: ["verify-entry"],
        criterionIds: ["criterion-entry"],
        requiredEvidenceKinds: ["test-result"],
      }, {
        id: "req-quiz",
        statement: "Quiz answers persist.",
        blocking: true,
        acceptanceCriteria: ["Quiz persistence passes."],
        expectedArtifacts: [{ mediaType: "application/json", description: "Quiz evidence" }],
        producerTaskIds: ["implement-quiz"],
        evaluatorTaskIds: ["verify-quiz"],
        criterionIds: ["criterion-quiz"],
        requiredEvidenceKinds: ["artifact-ref", "test-result"],
      }],
    },
    agentsMdBlocks: [{ id: "agents", sourceType: "agents-md", title: "AGENTS", text: "Follow repo instructions.", tokenEstimate: 5 }],
    artifactContracts: [{ id: "artifact", sourceType: "artifact", title: "implementation_report", text: "Return summary, commandsRun, risks.", tokenEstimate: 7 }],
    selectedMemories: [{ id: "memory-preference", sourceType: "memory", title: "preference", text: "Prefer tests around calc sum behavior.", sourceRef: "mem-1", tokenEstimate: 9 }],
    priorArtifacts: [{
      id: "artifact-build",
      sourceType: "artifact",
      title: "implementation_report",
      text: "Accepted implementation artifact.",
      sourceRef: "artifact_ref:run-env2:task-build:attempt-1:abc",
      tokenEstimate: 6,
    }],
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
