import { buildTaskEnvelopeV2, type TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import type { ArtifactContract, DomainPack } from "../domain-packs/types.ts";
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import { normalizeLibraryRefs, type LibraryRefKind } from "../orchestration/library-ref-compat.ts";
import { materializeTaskLibraryRefs } from "../orchestration/runtime-library-materializer.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { assembleContextBlocks } from "./assembly-policy.ts";
import { collectContextSourcesPg } from "./source-builder.ts";
import {
  CONTEXT_ASSEMBLY_TRACE_RESOURCE_TYPE,
  CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION,
  type ContextAssemblyTrace,
  type ContextBlock,
  type ContextBlockCandidate,
  type ContextPacket,
} from "./types.ts";

export type ManagedContextAssemblerOptions = {
  domainPack?: DomainPack;
};

export type BuildManagedTaskContextInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  dependsOn: string[];
  checkpointRefs?: string[];
  failureSummary?: string;
};

export type BuildManagedTaskContextResult = {
  contextPacket: ContextPacket;
  taskEnvelope: TaskEnvelopeV2;
  taskEnvelopeId: string;
  trace: ContextAssemblyTrace;
};

export function createManagedContextAssembler(db: SouthstarDb, options: ManagedContextAssemblerOptions = {}) {
  const domainPack = options.domainPack ?? softwareDomainPack;
  return {
    async buildForTask(input: BuildManagedTaskContextInput): Promise<BuildManagedTaskContextResult> {
      const workflow = await readWorkflow(db, input.runId);
      const task = required(workflow.tasks.find((candidate) => candidate.id === input.taskId), `unknown task: ${input.taskId}`);
      const roleRef = required(task.roleRef, `missing roleRef for task ${task.id}`);
      const agentProfileRef = required(task.agentProfileRef, `missing agentProfileRef for task ${task.id}`);
      const evaluatorPipelineRef = required(task.evaluatorPipelineRef, `missing evaluatorPipelineRef for task ${task.id}`);
      const workflowRoles = required(workflow.roles, `missing workflow roles in manifest ${workflow.workflowId}`);
      const workflowProfiles = required(workflow.agentProfiles, `missing workflow agentProfiles in manifest ${workflow.workflowId}`);
      const role = required(workflowRoles.find((candidate) => candidate.id === roleRef), `missing role ${roleRef}`);
      const agentProfile = required(workflowProfiles.find((candidate) => candidate.id === agentProfileRef), `missing agent profile ${agentProfileRef}`);
      const harness = required(workflow.harnessDefinitions.find((candidate) => candidate.id === agentProfile.harnessRef), `missing harness ${agentProfile.harnessRef}`);
      const evaluatorPipeline = required(domainPack.evaluatorPipelines.find((candidate) => candidate.id === evaluatorPipelineRef), `missing evaluator pipeline ${evaluatorPipelineRef}`);
      const artifactContracts = artifactContractsForTask(domainPack, task);
      const contextPolicy = domainPack.contextPolicies.find((policy) => policy.id === (task.contextPolicyRef ?? agentProfile.contextPolicyRef)) ?? domainPack.contextPolicies[0];
      const memoryPolicy = domainPack.memoryPolicies.find((policy) => policy.id === contextPolicy?.memoryPolicyRef) ?? domainPack.memoryPolicies[0];
      const sources = await collectContextSourcesPg(db, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        dependsOn: input.dependsOn,
        query: `${workflow.goalPrompt} ${task.name}`.trim(),
        memoryScopes: task.memoryScopeRefs ?? agentProfile.memoryScopes ?? memoryPolicy?.scopes ?? [],
        allowedMemoryKinds: memoryPolicy?.allowedKinds ?? [],
        maxMemoryCandidates: memoryPolicy?.maxCandidates ?? workflow.memoryPolicy.retrievalLimit,
        checkpointRefs: input.checkpointRefs ?? [],
      });
      const assembly = assembleContextBlocks({
        candidates: [
          ...sources.candidates,
          ...failureSummaryCandidates(input),
        ],
        maxInputTokens: contextPolicy?.maxInputTokens ?? agentProfile.budgetPolicy.maxInputTokens,
        maxMemoryTokens: memoryPolicy?.maxInjectedTokens ?? 1_500,
        pendingMemoryRefs: sources.pendingMemoryRefs,
        invalidatedSourceRefs: sources.invalidatedSourceRefs,
        requiredSourceRefs: [],
      });
      if (!assembly.validation.ok) {
        throw new Error(`context assembly failed: ${assembly.validation.errors.map((error) => error.message).join("; ")}`);
      }
      const materializedLibrary = await materializeTaskLibraryRefs(db, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        instructionRefs: libraryRefs(task.instructionRefs, "instruction.", "instruction"),
        skillRefs: libraryRefs(task.skillRefs, "skill.", "skill"),
        toolGrantRefs: libraryRefs(task.toolGrantRefs, "tool.", "tool"),
        mcpGrantRefs: libraryRefs(task.mcpGrantRefs, "mcp.", "mcp"),
        vaultLeasePolicyRefs: libraryRefs(task.vaultLeasePolicyRefs, "vault.", "vault"),
      });

      const contextPacketId = `ctx-${input.runId}-${input.taskId}-${input.attemptId}`;
      const taskEnvelopeId = `task-envelope-${input.runId}-${input.taskId}-${input.attemptId}`;
      const contextPacket: ContextPacket = {
        id: contextPacketId,
        runId: input.runId,
        taskId: input.taskId,
        rootSessionId: input.sessionId,
        executionAttempt: attemptNumber(input.attemptId),
        roleRef: role.id,
        agentProfileRef: agentProfile.id,
        taskGoal: workflow.goalPrompt,
        roleInstruction: role.responsibility,
        systemInstruction: agentProfile.systemPromptRef,
        agentsMdBlocks: [],
        artifactContracts: artifactContractBlocks(artifactContracts),
        selectedMemories: assembly.selected.filter((block) => block.sourceType === "memory"),
        selectedKnowledgeCards: assembly.selected.filter((block) => block.sourceType === "knowledge_card"),
        priorArtifacts: assembly.selected.filter((block) => block.sourceType === "artifact"),
        checkpointSummary: assembly.selected.find((block) => block.sourceType === "checkpoint"),
        failureSummary: assembly.selected.find((block) => block.sourceType === "failure"),
        skillInstructions: [
          ...inlineInstructionBlocks(profile.instruction),
          ...instructionBlocks(materializedLibrary.instructions),
          ...skillBlocks(materializedLibrary.skills),
        ],
        mcpGrantSummary: mcpGrantBlocks(materializedLibrary.mcpGrants),
        forbiddenActions: agentProfile.toolPolicy.deniedTools,
        budget: agentProfile.budgetPolicy,
        tokenEstimate: assembly.tokenEstimate,
        excludedCandidates: assembly.excludedCandidates,
        managedSourceRefs: sources.sourceRefs,
      };
      const taskEnvelope = buildTaskEnvelopeV2({
        runId: input.runId,
        workflowId: workflow.workflowId,
        taskId: input.taskId,
        domain: workflow.domain ?? domainPack.id,
        intent: workflow.intent ?? "implement_feature",
        role,
        agentProfile,
        harness,
        contextPacket,
        skills: materializedLibrary.skills,
        mcpGrants: materializedLibrary.mcpGrants,
        vaultLeases: materializedLibrary.vaultLeases,
        toolProxyPolicy: materializedLibrary.toolProxyPolicy,
        materializedLibraryRefs: {
          instructionRefs: libraryRefs(task.instructionRefs, "instruction.", "instruction"),
          skillRefs: libraryRefs(task.skillRefs, "skill.", "skill"),
          toolGrantRefs: libraryRefs(task.toolGrantRefs, "tool.", "tool"),
          mcpGrantRefs: libraryRefs(task.mcpGrantRefs, "mcp.", "mcp"),
          vaultLeasePolicyRefs: libraryRefs(task.vaultLeasePolicyRefs, "vault.", "vault"),
        },
        artifactContracts,
        evaluatorPipeline,
        session: {
          sessionId: input.sessionId,
          baseCheckpointId: input.checkpointRefs?.[0],
          maxRepairAttempts: task.rootSession.maxRepairAttempts,
        },
      });
      const trace: ContextAssemblyTrace = {
        schemaVersion: CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION,
        traceId: `context-trace-${input.runId}-${input.taskId}-${input.attemptId}`,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        handExecutionId: input.handExecutionId,
        contextPacketId,
        taskEnvelopeId,
        selectedSourceRefs: assembly.selected.map((block) => block.sourceRef ?? block.id),
        excludedCandidates: assembly.excludedCandidates,
        tokenEstimate: assembly.tokenEstimate,
        validation: assembly.validation,
        rollbackMarkerRefs: sources.sourceRefs.rollbackMarkerRefs,
        resetMarkerRefs: sources.sourceRefs.resetMarkerRefs,
        createdAt: new Date().toISOString(),
      };

      await persistAssembly(db, { input, contextPacket, taskEnvelope, taskEnvelopeId, trace });
      return { contextPacket, taskEnvelope, taskEnvelopeId, trace };
    },
  };
}

async function persistAssembly(
  db: SouthstarDb,
  input: {
    input: BuildManagedTaskContextInput;
    contextPacket: ContextPacket;
    taskEnvelope: TaskEnvelopeV2;
    taskEnvelopeId: string;
    trace: ContextAssemblyTrace;
  },
): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: input.contextPacket.id,
    resourceType: "context_packet",
    resourceKey: input.contextPacket.id,
    runId: input.input.runId,
    taskId: input.input.taskId,
    sessionId: input.input.sessionId,
    scope: "context",
    status: "created",
    title: `Context ${input.input.taskId}`,
    payload: input.contextPacket,
    summary: { tokenEstimate: input.contextPacket.tokenEstimate.total, attemptId: input.input.attemptId },
  });
  await upsertRuntimeResourcePg(db, {
    id: input.taskEnvelopeId,
    resourceType: "task_envelope",
    resourceKey: input.taskEnvelopeId,
    runId: input.input.runId,
    taskId: input.input.taskId,
    sessionId: input.input.sessionId,
    scope: "task",
    status: "materialized",
    title: `TaskEnvelope ${input.input.taskId}`,
    payload: { envelope: input.taskEnvelope },
    summary: { schemaVersion: input.taskEnvelope.schemaVersion, contextPacketId: input.contextPacket.id, attemptId: input.input.attemptId },
  });
  await upsertRuntimeResourcePg(db, {
    id: input.trace.traceId,
    resourceType: CONTEXT_ASSEMBLY_TRACE_RESOURCE_TYPE,
    resourceKey: input.trace.traceId,
    runId: input.input.runId,
    taskId: input.input.taskId,
    sessionId: input.input.sessionId,
    scope: "context",
    status: input.trace.validation.ok ? "valid" : "invalid",
    title: `Context assembly trace ${input.input.taskId}`,
    payload: input.trace,
    summary: { selectedSourceRefs: input.trace.selectedSourceRefs.length, excludedCandidates: input.trace.excludedCandidates.length },
  });
}

async function readWorkflow(db: SouthstarDb, runId: string): Promise<SouthstarWorkflowManifest> {
  const row = await db.maybeOne<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
    "select workflow_manifest_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  return row.workflow_manifest_json;
}

function artifactContractsForTask(domainPack: DomainPack, task: WorkflowTaskDefinition): ArtifactContract[] {
  return (task.requiredArtifactRefs ?? [])
    .map((artifactRef) => required(domainPack.artifactContracts.find((contract) => contract.id === artifactRef), `missing artifact contract ${artifactRef}`));
}

function artifactContractBlocks(contracts: ArtifactContract[]): ContextBlock[] {
  return contracts.map((contract) => ({
    id: `artifact-contract-${contract.id}`,
    sourceType: "artifact",
    title: contract.id,
    text: `Artifact type: ${contract.artifactType}. Required fields: ${contract.requiredFields.join(", ")}.`,
    sourceRef: contract.id,
    tokenEstimate: estimateTokens(`${contract.artifactType} ${contract.requiredFields.join(" ")}`),
  }));
}

function failureSummaryCandidates(input: BuildManagedTaskContextInput): ContextBlockCandidate[] {
  const text = input.failureSummary;
  if (!text) return [];
  return [{
    id: `failure-${input.runId}-${input.taskId}-${input.attemptId}`,
    sourceType: "failure",
    title: "Failure summary",
    text,
    sourceRef: `failure-summary:${input.attemptId}`,
    tokenEstimate: estimateTokens(text),
    score: 1,
  }];
}

function instructionBlocks(
  instructions: Array<{ instructionRef: string; content: string }>,
): ContextBlock[] {
  return instructions.map((instruction) => ({
    id: `instruction-${instruction.instructionRef}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
    sourceType: "skill",
    title: instruction.instructionRef,
    text: instruction.content,
    sourceRef: instruction.instructionRef,
    tokenEstimate: estimateTokens(instruction.content),
  }));
}

function inlineInstructionBlocks(instruction: string | undefined): ContextBlock[] {
  const text = instruction?.trim();
  if (!text) return [];
  return [{
    id: "node-profile-instruction",
    sourceType: "skill",
    title: "Node profile instruction",
    text,
    sourceRef: "node-profile:instruction",
    tokenEstimate: estimateTokens(text),
  }];
}

function skillBlocks(
  skills: Array<{ skillId: string; instructions: string }>,
): ContextBlock[] {
  return skills.map((skill) => ({
    id: `skill-${skill.skillId}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
    sourceType: "skill",
    title: skill.skillId,
    text: skill.instructions,
    sourceRef: skill.skillId,
    tokenEstimate: estimateTokens(skill.instructions),
  }));
}

function mcpGrantBlocks(
  grants: Array<{ serverId: string; allowedTools: string[] }>,
): ContextBlock[] {
  return grants.map((grant) => ({
    id: `mcp-${grant.serverId}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
    sourceType: "mcp",
    title: grant.serverId,
    text: grant.allowedTools.join(", "),
    sourceRef: grant.serverId,
    tokenEstimate: estimateTokens(grant.allowedTools.join(" ")),
  }));
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function attemptNumber(attemptId: string): number {
  const match = attemptId.match(/attempt-(\d+)$/);
  return match ? Number(match[1]) : 1;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function libraryRefs(values: string[] | undefined, prefix: string, kind: LibraryRefKind): string[] {
  return normalizeLibraryRefs({ values, prefix, kind });
}
