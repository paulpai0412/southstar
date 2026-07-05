import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskEnvelopeV2, refreshTaskEnvelopeV2Prompt } from "../../src/v2/agent-runner/task-envelope.ts";
import type { ContextPacket } from "../../src/v2/context/types.ts";
import { implementationReportContract, makerAgentProfile, makerRole, softwareFeatureQualityPipeline } from "./fixtures/runtime-manifest-primitives.ts";

test("refreshTaskEnvelopeV2Prompt rebuilds agentPrompt after context mutations", () => {
  const role = makerRole();
  const agentProfile = makerAgentProfile();
  const evaluatorPipeline = softwareFeatureQualityPipeline();
  const artifactContracts = [implementationReportContract()];

  const base = buildTaskEnvelopeV2({
    runId: "run-refresh",
    workflowId: "wf-refresh",
    taskId: "task-refresh",
    domain: "software",
    intent: "implement_feature",
    role,
    agentProfile,
    harness: {
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: [],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    },
    contextPacket: packet(agentProfile.budgetPolicy),
    skills: [],
    mcpGrants: [],
    vaultLeases: [],
    artifactContracts,
    evaluatorPipeline,
    session: { sessionId: "session-refresh" },
  });

  const mutated = {
    ...base,
    contextPacket: {
      ...base.contextPacket,
      priorArtifacts: [
        ...base.contextPacket.priorArtifacts,
        {
          id: "upstream-1",
          sourceType: "artifact" as const,
          title: "Accepted upstream artifacts",
          text: "artifact-plan-1",
          sourceRef: "artifact-plan-1",
          tokenEstimate: 3,
        },
      ],
    },
  };

  const refreshed = refreshTaskEnvelopeV2Prompt(mutated);
  assert.doesNotMatch(base.agentPrompt, /artifact-plan-1/);
  assert.match(refreshed.agentPrompt, /Prior artifacts:/);
  assert.match(refreshed.agentPrompt, /artifact-plan-1/);
});

function packet(budget: ContextPacket["budget"]): ContextPacket {
  return {
    id: "ctx-refresh",
    runId: "run-refresh",
    taskId: "task-refresh",
    executionAttempt: 1,
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    taskGoal: "Implement feature",
    roleInstruction: "Write code",
    agentsMdBlocks: [],
    artifactContracts: [],
    selectedMemories: [],
    priorArtifacts: [],
    skillInstructions: [],
    mcpGrantSummary: [],
    forbiddenActions: [],
    budget,
    tokenEstimate: { total: 10, bySourceType: {} },
    excludedCandidates: [],
  };
}
