import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import type { HarnessDefinition } from "../manifests/types.ts";
import type { AgentProfile, ArtifactContract, EvaluatorPipelineDefinition, RoleDefinition } from "../domain-packs/types.ts";
import type { ResolvedSkillSnapshot } from "../skills/types.ts";
import type { ContextPacket, ContextBlock } from "../context/types.ts";
import type { ToolProxyPolicyPayload } from "../tool-proxy/types.ts";

export type MemorySnapshot = {
  items: Array<{ id: string; body: unknown }>;
  capturedAt: string;
};

export type VaultLeaseInput = {
  leaseRef: string;
  mountAs: "env" | "file";
  secretValue?: string;
};

export type McpGrantInput = {
  serverId: string;
  allowedTools: string[];
};

export type TaskEnvelopeInput = {
  runId: string;
  taskId: string;
  rootSessionId: string;
  memorySnapshot: MemorySnapshot;
  vaultLeases: VaultLeaseInput[];
  mcpGrants: McpGrantInput[];
  skills?: ResolvedSkillSnapshot[];
};

export type TaskEnvelope = {
  schemaVersion: "southstar.task-envelope.v1";
  runId: string;
  workflowId: string;
  task: WorkflowTaskDefinition;
  rootSession: {
    id: string;
    validator: string;
    maxRepairAttempts: number;
  };
  subagents: WorkflowTaskDefinition["subagents"];
  memory: MemorySnapshot;
  skills: ResolvedSkillSnapshot[];
  vaultLeases: Array<Omit<VaultLeaseInput, "secretValue">>;
  mcpGrants: McpGrantInput[];
  artifactContracts: string[];
  artifactContract: {
    artifactTypes: string[];
    requiredFields: string[];
  };
};

export type WorkspaceHandle = {
  repoRoot: string;
  worktreePath: string;
  hostMountPath?: string;
};

export type WorkspaceSnapshotRef = {
  provider: "git" | string;
  repoRoot: string;
  commitSha?: string;
  ref?: string;
};

export type TaskEnvelopeV2 = {
  schemaVersion: "southstar.task-envelope.v2";
  runId: string;
  workflowId: string;
  taskId: string;
  domain: string;
  intent: string;
  role: RoleDefinition;
  agentProfile: AgentProfile;
  harness: HarnessDefinition;
  contextPacket: ContextPacket;
  agentPrompt: string;
  skills: ResolvedSkillSnapshot[];
  mcpGrants: McpGrantInput[];
  vaultLeases: Array<Omit<VaultLeaseInput, "secretValue">>;
  toolProxyPolicy?: ToolProxyPolicyPayload;
  materializedLibraryRefs?: {
    instructionRefs: string[];
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    vaultLeasePolicyRefs: string[];
  };
  artifactContracts: ArtifactContract[];
  evaluatorPipeline: EvaluatorPipelineDefinition;
  session: { sessionId: string; baseCheckpointId?: string; maxRepairAttempts?: number };
  workspace?: { handle: WorkspaceHandle; baseSnapshotRef?: WorkspaceSnapshotRef };
};

export type AnyTaskEnvelope = TaskEnvelope | TaskEnvelopeV2;

export function buildTaskEnvelope(workflow: SouthstarWorkflowManifest, input: TaskEnvelopeInput): TaskEnvelope {
  const task = workflow.tasks.find((candidate) => candidate.id === input.taskId);
  if (!task) {
    throw new Error(`unknown task: ${input.taskId}`);
  }
  const artifactTypes = [...new Set(task.subagents.flatMap((subagent) => subagent.requiredArtifacts))];
  const evaluator = workflow.evaluators.find((candidate) => candidate.id === task.rootSession.validator)
    ?? workflow.evaluators.find((candidate) => candidate.artifactTypes.some((artifactType) => artifactTypes.includes(artifactType)));
  return {
    schemaVersion: "southstar.task-envelope.v1",
    runId: input.runId,
    workflowId: workflow.workflowId,
    task,
    rootSession: {
      id: input.rootSessionId,
      validator: task.rootSession.validator,
      maxRepairAttempts: task.rootSession.maxRepairAttempts,
    },
    subagents: task.subagents,
    memory: input.memorySnapshot,
    skills: input.skills ?? [],
    vaultLeases: input.vaultLeases.map((lease) => ({
      leaseRef: lease.leaseRef,
      mountAs: lease.mountAs,
    })),
    mcpGrants: input.mcpGrants,
    artifactContracts: artifactTypes,
    artifactContract: {
      artifactTypes,
      requiredFields: evaluator?.requiredFields ?? [],
    },
  };
}

export function buildTaskEnvelopeV2(input: Omit<TaskEnvelopeV2, "schemaVersion" | "agentPrompt"> & { agentPrompt?: string }): TaskEnvelopeV2 {
  return {
    ...input,
    schemaVersion: "southstar.task-envelope.v2",
    agentPrompt: input.agentPrompt ?? renderContextPacketPrompt(input.contextPacket, {
      role: input.role,
      agentProfile: input.agentProfile,
      artifactContracts: input.artifactContracts,
      evaluatorPipeline: input.evaluatorPipeline,
    }),
    vaultLeases: input.vaultLeases.map((lease) => ({ leaseRef: lease.leaseRef, mountAs: lease.mountAs })),
  };
}

export function refreshTaskEnvelopeV2Prompt(envelope: TaskEnvelopeV2): TaskEnvelopeV2 {
  return {
    ...envelope,
    agentPrompt: renderContextPacketPrompt(envelope.contextPacket, {
      role: envelope.role,
      agentProfile: envelope.agentProfile,
      artifactContracts: envelope.artifactContracts,
      evaluatorPipeline: envelope.evaluatorPipeline,
    }),
  };
}

function renderContextPacketPrompt(
  packet: ContextPacket,
  input: {
    role: RoleDefinition;
    agentProfile: AgentProfile;
    artifactContracts: ArtifactContract[];
    evaluatorPipeline: EvaluatorPipelineDefinition;
  },
): string {
  return [
    "You are a Southstar container agent running inside a Tork task.",
    `ContextPacket: ${packet.id}`,
    `Run: ${packet.runId}`,
    `Task: ${packet.taskId}`,
    `Attempt: ${packet.executionAttempt}`,
    `Role: ${input.role.id}`,
    input.role.responsibility,
    `Agent profile: ${input.agentProfile.id}`,
    input.agentProfile.model ? `Model: ${input.agentProfile.model}` : "",
    "Southstar runtime owns workflow orchestration, session state, evaluator execution, and stop-condition decisions. Complete only this task's artifact and repository work; do not try to modify or operate Southstar runtime internals unless the task explicitly asks for runtime code changes.",
    "",
    "Task goal:",
    packet.taskGoal,
    "",
    "Role instruction:",
    packet.roleInstruction,
    formatBlocks("Agents.md", packet.agentsMdBlocks),
    formatBlocks("Memory", packet.selectedMemories),
    formatBlocks("Knowledge Cards", packet.selectedKnowledgeCards ?? []),
    formatBlocks("Prior artifacts", packet.priorArtifacts),
    formatBlocks("Checkpoint", packet.checkpointSummary ? [packet.checkpointSummary] : []),
    formatBlocks("Failure", packet.failureSummary ? [packet.failureSummary] : []),
    formatBlocks("Workspace", packet.workspaceSummary ? [packet.workspaceSummary] : []),
    formatBlocks("Skills", packet.skillInstructions),
    formatBlocks("MCP grants", packet.mcpGrantSummary),
    formatArtifactContracts(input.artifactContracts),
    "",
    `Evaluator pipeline: ${input.evaluatorPipeline.id}`,
    `Forbidden actions: ${packet.forbiddenActions.length > 0 ? packet.forbiddenActions.join(", ") : "none"}`,
    "Return exactly one JSON object with keys: artifact, progress, metrics.",
  ].filter((line) => line !== "").join("\n");
}

function formatBlocks(title: string, blocks: ContextBlock[]): string {
  if (blocks.length === 0) return "";
  return ["", `${title}:`, ...blocks.map((block) => `- ${block.text}`)].join("\n");
}

function formatArtifactContracts(contracts: ArtifactContract[]): string {
  if (contracts.length === 0) return "";
  return [
    "",
    "Artifact contracts:",
    ...contracts.flatMap((contract) => {
      const rules = contractSpecificOutputRules(contract.id);
      return [
        `- ${contract.id}: ${contract.artifactType}; required fields: ${contract.requiredFields.join(", ")}`,
        ...rules.map((rule) => `  - ${rule}`),
      ];
    }),
  ].join("\n");
}

function contractSpecificOutputRules(contractId: string): string[] {
  if (contractId === "implementation_report" || contractId === "verification_report") {
    return [
      "commandsRun must be an array of executed commands (string or object with command).",
      "testResults entries should use status enum: passed, failed, failed_non_gating, blocked, not-verified, not-run.",
      "when status is failed/blocked/not-verified/not-run, include gating: blocking or non-gating.",
    ];
  }
  if (contractId === "completion_report") {
    return [
      "tests must summarize executed test evidence (array of strings or structured entries).",
      "acceptedArtifacts must reference upstream artifact IDs or requirements.",
    ];
  }
  return [];
}
