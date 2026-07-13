import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import type { HarnessDefinition } from "../manifests/types.ts";
import type { AgentProfile, ArtifactContract, EvaluatorPipelineDefinition, RoleDefinition } from "../design-library/runtime-types.ts";
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

export type McpRuntimeConfig = {
  schemaVersion: "southstar.mcp_runtime_config.v1";
  runId: string;
  taskId: string;
  servers: McpRuntimeServerConfig[];
  policy: {
    failClosed: true;
    secretsMaterializedByVault: true;
    configContainsSecretValues: false;
  };
};

export type McpRuntimeServerConfig = {
  serverId: string;
  transport: "stdio";
  allowedTools: string[];
  command: {
    argv: string[];
    cwd?: string;
  };
  env?: Record<string, string>;
  envFromVault: Array<{
    name: string;
    leaseRef: string;
    key?: string;
  }>;
  configFiles?: Array<{
    path: string;
    leaseRef?: string;
    readonly?: boolean;
  }>;
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
  mcpRuntimeConfig?: McpRuntimeConfig;
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
      mcpGrants: input.mcpGrants,
      toolProxyPolicy: input.toolProxyPolicy,
      materializedLibraryRefs: input.materializedLibraryRefs,
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
      mcpGrants: envelope.mcpGrants,
      toolProxyPolicy: envelope.toolProxyPolicy,
      materializedLibraryRefs: envelope.materializedLibraryRefs,
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
    mcpGrants: McpGrantInput[];
    toolProxyPolicy?: ToolProxyPolicyPayload;
    materializedLibraryRefs?: TaskEnvelopeV2["materializedLibraryRefs"];
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
    formatNodePromptSpec(packet.nodePromptSpec),
    "",
    "Role instruction:",
    packet.roleInstruction,
    formatBlocks("Agents.md", packet.agentsMdBlocks),
    formatBlocks("Memory", packet.selectedMemories),
    formatBlocks("Knowledge Cards", packet.selectedKnowledgeCards ?? []),
    formatPriorArtifacts(packet.priorArtifacts),
    formatUiInteractionContracts(packet.uiInteractionContracts ?? []),
    formatBlocks("Checkpoint", packet.checkpointSummary ? [packet.checkpointSummary] : []),
    formatBlocks("Failure", packet.failureSummary ? [packet.failureSummary] : []),
    formatBlocks("Workspace", packet.workspaceSummary ? [packet.workspaceSummary] : []),
    formatBlocks("Skills", packet.skillInstructions),
    formatBlocks("MCP grants", packet.mcpGrantSummary),
    formatRuntimeGrantContract(input),
    formatArtifactContracts(input.artifactContracts),
    "",
    formatEvaluatorPipelineContract(input.evaluatorPipeline),
    `Forbidden actions: ${packet.forbiddenActions.length > 0 ? packet.forbiddenActions.join(", ") : "none"}`,
    "Return exactly one JSON object with keys: artifact, progress, metrics.",
  ].filter((line) => line !== "").join("\n");
}

function formatUiInteractionContracts(contracts: NonNullable<ContextPacket["uiInteractionContracts"]>): string {
  if (contracts.length === 0) return "";
  return [
    "",
    "UI Interaction Contracts:",
    "Treat these confirmed, hash-bound structures as required product behavior. Do not replace them with arbitrary HTML, CSS, or scripts.",
    ...contracts.map((contract) => [
      `Contract ${contract.id} revision ${contract.revision} hash ${contract.contractHash}`,
      `Requirement IDs: ${contract.requirementIds.join(", ")}`,
      `Screens: ${contract.screens.map((screen) => screen.id).join(", ")}`,
      `Structured contract: ${JSON.stringify({
        screens: contract.screens.map((screen) => ({
          id: screen.id,
          title: screen.title,
          purpose: screen.purpose,
          layout: screen.layout,
          elements: screen.elements,
          states: screen.states,
          actions: screen.actions,
          responsiveRules: screen.responsiveRules,
          accessibilityRules: screen.accessibilityRules,
        })),
        flows: contract.flows,
        criterionBindings: contract.criterionBindings,
      })}`,
    ].join("\n")),
  ].join("\n");
}

function formatNodePromptSpec(spec: ContextPacket["nodePromptSpec"]): string {
  if (!spec) return "";
  return [
    "",
    "Node prompt spec:",
    `Node type: ${spec.nodeType}`,
    `Goal: ${spec.goal}`,
    formatList("Requirements", spec.requirements),
    formatList("Boundaries", spec.boundaries),
    formatList("Non-goals", spec.nonGoals),
    formatDeliverableDocuments(spec.deliverableDocuments),
    formatList("Expected outputs", spec.expectedOutputs),
    formatTestCases(spec.testCases),
    formatList("Acceptance criteria", spec.acceptanceCriteria),
    spec.failureReportContract ? `Failure report contract: ${spec.failureReportContract}` : "",
    formatList("Planning questions", spec.planningQuestions ?? []),
    formatList("Decision criteria", spec.decisionCriteria ?? []),
    spec.planArtifactContract ? `Plan artifact contract: ${spec.planArtifactContract}` : "",
    formatList("Implementation scope", spec.implementationScope ?? []),
    formatList("Files likely to touch", spec.filesLikelyToTouch ?? []),
    formatList("Verification checks", spec.verificationChecks ?? []),
    spec.failureArtifactContract ? `Failure artifact contract: ${spec.failureArtifactContract}` : "",
    formatList("Repair inputs", spec.repairInputs ?? []),
    formatList("Must preserve", spec.mustPreserve ?? []),
    formatList("Reverification checks", spec.reverificationChecks ?? []),
    formatList("Review checklist", spec.reviewChecklist ?? []),
    formatList("Risk criteria", spec.riskCriteria ?? []),
    formatList("Summary sections", spec.summarySections ?? []),
    formatList("Handoff criteria", spec.handoffCriteria ?? []),
  ].filter((line) => line !== "").join("\n");
}

function formatDeliverableDocuments(documents: NonNullable<ContextPacket["nodePromptSpec"]>["deliverableDocuments"]): string {
  if (documents.length === 0) return "";
  return [
    "Deliverable documents:",
    ...documents.map((document) =>
      `- ${document.kind}: ${document.title} (${document.format}, ${document.required ? "required" : "optional"}) - ${document.description}`
    ),
  ].join("\n");
}

function formatList(title: string, values: string[]): string {
  if (values.length === 0) return "";
  return [`${title}:`, ...values.map((value) => `- ${value}`)].join("\n");
}

function formatTestCases(testCases: NonNullable<ContextPacket["nodePromptSpec"]>["testCases"]): string {
  if (testCases.length === 0) return "";
  return [
    "Test cases:",
    ...testCases.map((testCase) => [
      `- ${testCase.name}`,
      testCase.command ? `  Command: ${testCase.command}` : "",
      testCase.given ? `  Given: ${testCase.given}` : "",
      testCase.when ? `  When: ${testCase.when}` : "",
      testCase.then ? `  Then: ${testCase.then}` : "",
      `  Expected: ${testCase.expected}`,
    ].filter((line) => line !== "").join("\n")),
  ].join("\n");
}

function formatBlocks(title: string, blocks: ContextBlock[]): string {
  if (blocks.length === 0) return "";
  return ["", `${title}:`, ...blocks.map((block) => `- ${block.text}`)].join("\n");
}

function formatPriorArtifacts(blocks: ContextBlock[]): string {
  if (blocks.length === 0) return "";
  return [
    "",
    "Prior artifacts:",
    ...blocks.flatMap((block) => [
      `- ArtifactRef: ${block.sourceRef ?? block.id}`,
      `  ${block.text}`,
    ]),
    "Verifier and reviewer artifacts must return verifiedArtifactRefs containing the exact ArtifactRef values they evaluated.",
  ].join("\n");
}

function formatRuntimeGrantContract(input: {
  mcpGrants: McpGrantInput[];
  toolProxyPolicy?: ToolProxyPolicyPayload;
  materializedLibraryRefs?: TaskEnvelopeV2["materializedLibraryRefs"];
}): string {
  const lines = [
    "",
    "Runtime grants:",
    "The task bundle is mounted read-only under /southstar-runs/<runId>/<taskId> in the container.",
    "Use tools and MCP servers only when they are granted here. These entries are grant policy, not bundled tool or MCP server implementations.",
    "Grant files can include: agent-profile/profile.json, context-packet.json, runtime-manifest.json, tools/tool-policy.json, mcp/grants.json, mcp/runtime-config.json, skills/<skillId>/SKILL.md.",
  ];
  if (input.toolProxyPolicy) {
    lines.push(`Allowed tools: ${input.toolProxyPolicy.allowedTools.length > 0 ? input.toolProxyPolicy.allowedTools.join(", ") : "none"}.`);
    lines.push(`Required proxy tools: ${input.toolProxyPolicy.requiredProxyTools.length > 0 ? input.toolProxyPolicy.requiredProxyTools.join(", ") : "none"}.`);
  }
  if (input.mcpGrants.length > 0) {
    lines.push(
      ...input.mcpGrants.map((grant) =>
        `MCP grant ${grant.serverId}: ${grant.allowedTools.length > 0 ? grant.allowedTools.join(", ") : "no tools"}.`
      ),
    );
  }
  const refs = input.materializedLibraryRefs;
  if (refs) {
    const selectedRefs = [
      ...refs.instructionRefs,
      ...refs.skillRefs,
      ...refs.toolGrantRefs,
      ...refs.mcpGrantRefs,
      ...refs.vaultLeasePolicyRefs,
    ];
    lines.push(`Materialized library refs: ${selectedRefs.length > 0 ? selectedRefs.join(", ") : "none"}.`);
  }
  return lines.join("\n");
}

function formatArtifactContracts(contracts: ArtifactContract[]): string {
  if (contracts.length === 0) return "";
  return [
    "",
    "Artifact contracts:",
    ...contracts.flatMap((contract) => {
      const rules = contractSpecificOutputRules(contract);
      return [
        `- ${contract.id}: ${contract.artifactType}; required fields: ${contract.requiredFields.join(", ")}`,
        ...(contract.evidenceKinds?.length ? [`  - evidenceKinds allowed values: ${contract.evidenceKinds.join(", ")}.`] : []),
        ...(contract.validationRules?.map((rule) => `  - validation rule: ${rule}`) ?? []),
        ...rules.map((rule) => `  - ${rule}`),
      ];
    }),
  ].join("\n");
}

function contractSpecificOutputRules(contract: ArtifactContract): string[] {
  const fields = new Set([...contract.requiredFields, ...contract.evidenceFields]);
  const evidenceKinds = new Set(contract.evidenceKinds ?? []);
  const rules: string[] = [];
  if (fields.has("pass") || fields.has("safeToSave")) {
    rules.push("pass and safeToSave, when present, must be booleans: true or false.");
  }
  if (fields.has("commandsRun") || evidenceKinds.has("command-output")) {
    rules.push(
      "commandsRun must be an array of executed command result objects, not bare strings.",
      "commandsRun.status allowed values: passed, failed, blocked.",
      `commandsRun item schema: {"command": "npm test" or ["npm","test"], "status": "passed", "exitCode": 0, "output": "bounded relevant output"}.`,
      "Each commandsRun item must include status or exitCode; command records without an outcome do not satisfy command-output evidence.",
      "exitCode must be an integer; use 0 for success and non-zero for failed command execution.",
    );
  }
  if (fields.has("testResults") || evidenceKinds.has("test-result")) {
    rules.push(
      "testResults.status allowed values: passed, failed, failed_non_gating, blocked, not-verified, not-run, skipped, pass_with_environment_gap.",
      "gating allowed values: blocking, non-gating.",
      "when status is failed/blocked/not-verified/not-run, include gating: blocking or non-gating.",
    );
  }
  if (fields.has("verifiedArtifactRefs") || evidenceKinds.has("artifact-ref")) {
    rules.push("verifiedArtifactRefs must be an array of exact upstream ArtifactRef values evaluated by this verifier.");
  }
  if (fields.has("remainingFailures")) {
    rules.push(
      "remainingFailures, when present, must be an array; use [] only when every blocking check passed.",
    );
  }
  if (fields.has("tests")) {
    rules.push("tests must summarize executed test evidence (array of strings or structured entries).");
  }
  if (fields.has("acceptedArtifacts")) {
    rules.push(
      "acceptedArtifacts must reference upstream artifact IDs or requirements.",
    );
  }
  return [...new Set(rules)];
}

function formatEvaluatorPipelineContract(pipeline: EvaluatorPipelineDefinition): string {
  const criterionSteps = pipeline.evaluators
    .map((step) => ({ step, config: step.config as Record<string, unknown> }))
    .filter(({ config }) => typeof config.criterionId === "string" && config.criterionId.length > 0);
  if (criterionSteps.length === 0) return `Evaluator pipeline: ${pipeline.id}`;
  return [
    `Evaluator pipeline: ${pipeline.id}`,
    `Evaluator profile ref: ${pipeline.libraryObjectRef ?? pipeline.id}`,
    `Evaluator profile version: ${pipeline.libraryVersionRef ?? "missing"}`,
    "Criterion result contract:",
    "- artifact.criteriaResults is required and must contain exactly one item for every criterion listed below.",
    "- item schema: {\"criterionId\":\"...\",\"verdict\":\"passed|failed|blocked\",\"evidenceRefs\":[\"explicit-ref\"],\"findings\":[\"...\"]}.",
    "- verdict allowed values are passed, failed, blocked. Do not emit any other value.",
    "- evidenceRefs must point to explicit ref/evidenceRef/artifactRef/id/resourceKey/path/url values in the returned artifact evidence fields.",
    "- an overall artifact verdict/pass flag is advisory only; Southstar computes the final verdict from every criterion and validated evidence.",
    ...criterionSteps.map(({ config }) => {
      const kinds = Array.isArray(config.expectedEvidenceKinds)
        ? config.expectedEvidenceKinds.filter((value): value is string => typeof value === "string")
        : [];
      return `- ${String(config.criterionId)}: ${String(config.acceptanceCriterion ?? "")}; required evidence kinds: ${kinds.join(", ")}.`;
    }),
  ].join("\n");
}
