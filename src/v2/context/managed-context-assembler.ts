import { buildTaskEnvelopeV2, type TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { WorkflowNodePromptSpec } from "../design-library/types.ts";
import type { ArtifactContract, EvaluatorPipelineDefinition } from "../design-library/runtime-types.ts";
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import { loadFrozenCoverageContextPg } from "../evaluators/requirement-evaluator-results.ts";
import { storedGoalRequirementCoverage } from "../orchestration/goal-requirement-coverage.ts";
import { materializeTaskLibraryRefs } from "../orchestration/runtime-library-materializer.ts";
import { loadRunLibrarySnapshotPg, requireSnapshotObject } from "../orchestration/run-library-snapshot.ts";
import { validateGoalRequirementDraft, type GoalRequirementDraftV1 } from "../orchestration/goal-requirement-draft.ts";
import { validateUiInteractionContract, type UiInteractionContractV1 } from "../orchestration/ui-interaction-contract.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { assertWorkspaceMountAllowed } from "../workspace/workspace-mount-policy.ts";
import { assembleContextBlocks } from "./assembly-policy.ts";
import { collectContextSourcesPg } from "./source-builder.ts";
import {
  CONTEXT_ASSEMBLY_TRACE_RESOURCE_TYPE,
  CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION,
  type ContextAssemblyTrace,
  type ContextBlock,
  type ContextBlockCandidate,
  type ContextPacket,
  type GoalRequirementContext,
} from "./types.ts";

export type ManagedContextAssemblerOptions = Record<string, never>;

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
  void options;
  return {
    async buildForTask(input: BuildManagedTaskContextInput): Promise<BuildManagedTaskContextResult> {
      const workflow = await readWorkflow(db, input.runId);
      const workspace = await readWorkspaceHandle(db, input.runId);
      const task = required(workflow.tasks.find((candidate) => candidate.id === input.taskId), `unknown task: ${input.taskId}`);
      const roleRef = required(task.roleRef, `missing roleRef for task ${task.id}`);
      const agentProfileRef = required(task.agentProfileRef, `missing agentProfileRef for task ${task.id}`);
      const evaluatorPipelineRef = required(task.evaluatorPipelineRef, `missing evaluatorPipelineRef for task ${task.id}`);
      const workflowRoles = required(workflow.roles, `missing workflow roles in manifest ${workflow.workflowId}`);
      const workflowProfiles = required(workflow.agentProfiles, `missing workflow agentProfiles in manifest ${workflow.workflowId}`);
      const role = required(workflowRoles.find((candidate) => candidate.id === roleRef), `missing role ${roleRef}`);
      const agentProfile = required(workflowProfiles.find((candidate) => candidate.id === agentProfileRef), `missing agent profile ${agentProfileRef}`);
      const harness = required(workflow.harnessDefinitions.find((candidate) => candidate.id === agentProfile.harnessRef), `missing harness ${agentProfile.harnessRef}`);
      const evaluatorPipelines = required(workflow.evaluatorPipelines, `missing workflow evaluatorPipelines in manifest ${workflow.workflowId}`);
      const contextPolicies = required(workflow.contextPolicies, `missing workflow contextPolicies in manifest ${workflow.workflowId}`);
      const memoryPolicies = required(workflow.memoryPolicies, `missing workflow memoryPolicies in manifest ${workflow.workflowId}`);
      const evaluatorPipeline = await evaluatorPipelineForTask(
        db,
        input.runId,
        task,
        required(evaluatorPipelines.find((candidate) => candidate.id === evaluatorPipelineRef), `missing evaluator pipeline ${evaluatorPipelineRef}`),
      );
      const artifactContracts = artifactContractsForTask(workflow, task);
      const contextPolicy = required(
        contextPolicies.find((policy) => policy.id === (task.contextPolicyRef ?? agentProfile.contextPolicyRef)) ?? contextPolicies[0],
        `missing context policy ${task.contextPolicyRef ?? agentProfile.contextPolicyRef ?? "(default)"}`,
      );
      const memoryPolicy = required(
        memoryPolicies.find((policy) => policy.id === contextPolicy.memoryPolicyRef) ?? memoryPolicies[0],
        `missing memory policy ${contextPolicy.memoryPolicyRef}`,
      );
      const sources = await collectContextSourcesPg(db, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        dependsOn: input.dependsOn,
        query: `${workflow.goalPrompt} ${task.name}`.trim(),
        memoryScopes: task.memoryScopeRefs ?? agentProfile.memoryScopes ?? memoryPolicy.scopes,
        allowedMemoryKinds: memoryPolicy.allowedKinds,
        maxMemoryCandidates: memoryPolicy.maxCandidates,
        checkpointRefs: input.checkpointRefs ?? [],
        failureArtifactRefIds: dynamicFailureArtifactRefIds(task.promptInputs),
      });
      const assembly = assembleContextBlocks({
        candidates: [
          ...sources.candidates,
          ...failureSummaryCandidates(input),
        ],
        maxInputTokens: contextPolicy.maxInputTokens ?? agentProfile.budgetPolicy.maxInputTokens,
        maxMemoryTokens: memoryPolicy.maxInjectedTokens,
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
        instructionRefs: libraryRefs(task.instructionRefs),
        skillRefs: libraryRefs(task.skillRefs),
        toolGrantRefs: libraryRefs(task.toolGrantRefs),
        mcpGrantRefs: libraryRefs(task.mcpGrantRefs),
        vaultLeasePolicyRefs: libraryRefs(task.vaultLeasePolicyRefs),
        libraryRoot: process.env.SOUTHSTAR_LIBRARY_ROOT ?? `${process.cwd()}/library`,
      });
      const uiInteractionContracts = await readTaskUiInteractionContracts(db, input.runId, task);
      const goalRequirementContext = await readTaskGoalRequirementContext(db, input.runId, task);

      const contextPacketId = `ctx-${input.runId}-${input.taskId}-${input.attemptId}`;
      const taskEnvelopeId = `task-envelope-${input.runId}-${input.taskId}-${input.attemptId}`;
      const agentsMdBlocks = contextPolicy.includeAgentsMd === false
        ? []
        : await buildAgentsMdBlocks(db, input.runId, unique([agentProfile.agentRef, ...agentProfile.agentsMdRefs].filter((ref): ref is string => Boolean(ref))));
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
        nodePromptSpec: nodePromptSpecFromPromptInputs(task.promptInputs),
        ...(goalRequirementContext ? { goalRequirementContext } : {}),
        systemInstruction: agentProfile.systemPromptRef,
        agentsMdBlocks,
        artifactContracts: artifactContractBlocks(artifactContracts),
        selectedMemories: assembly.selected.filter((block) => block.sourceType === "memory"),
        selectedKnowledgeCards: assembly.selected.filter((block) => block.sourceType === "knowledge_card"),
        priorArtifacts: assembly.selected.filter((block) => block.sourceType === "artifact"),
        uiInteractionContracts,
        checkpointSummary: assembly.selected.find((block) => block.sourceType === "checkpoint"),
        failureSummary: assembly.selected.find((block) => block.sourceType === "failure"),
        skillInstructions: [
          ...inlineInstructionBlocks(agentProfile.instruction),
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
        domain: workflow.domain ?? "generated",
        intent: workflow.intent ?? "implement_feature",
        role,
        agentProfile,
        harness,
        contextPacket,
        skills: materializedLibrary.skills,
        mcpGrants: materializedLibrary.mcpGrants,
        mcpRuntimeConfig: materializedLibrary.mcpRuntimeConfig,
        vaultLeases: materializedLibrary.vaultLeases,
        toolProxyPolicy: materializedLibrary.toolProxyPolicy,
        materializedLibraryRefs: {
          instructionRefs: libraryRefs(task.instructionRefs),
          skillRefs: libraryRefs(task.skillRefs),
          toolGrantRefs: libraryRefs(task.toolGrantRefs),
          mcpGrantRefs: libraryRefs(task.mcpGrantRefs),
          vaultLeasePolicyRefs: libraryRefs(task.vaultLeasePolicyRefs),
        },
        artifactContracts,
        evaluatorPipeline,
        session: {
          sessionId: input.sessionId,
          baseCheckpointId: input.checkpointRefs?.[0],
          maxRepairAttempts: task.rootSession.maxRepairAttempts,
        },
        ...(workspace ? { workspace } : {}),
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

async function readWorkspaceHandle(db: SouthstarDb, runId: string): Promise<TaskEnvelopeV2["workspace"] | undefined> {
  const row = await db.maybeOne<{ runtime_context_json: unknown }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  const runtimeContext = asRecord(row?.runtime_context_json);
  const projectRoot = stringValue(runtimeContext.projectRoot) ?? stringValue(runtimeContext.cwd);
  if (!projectRoot || !isHostMountPath(projectRoot)) return undefined;
  assertWorkspaceMountAllowed(projectRoot);
  return {
    handle: {
      repoRoot: "/workspace/repo",
      worktreePath: "/workspace/repo",
      hostMountPath: projectRoot,
    },
  };
}

async function readTaskGoalRequirementContext(
  db: SouthstarDb,
  runId: string,
  task: WorkflowTaskDefinition,
): Promise<GoalRequirementContext | undefined> {
  const run = await db.maybeOne<{ runtime_context_json: unknown }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  if (!stringValue(asRecord(run?.runtime_context_json).goalContractHash)) return undefined;
  const frozen = await loadFrozenCoverageContextPg(db, runId);
  if (!frozen) return undefined;
  const targetRequirementIds = unique(stringArray(asRecord(task.promptInputs).requirementIds)).sort();
  const blockingRequirementIds = [...frozen.blockingRequirementIds].sort();
  const coverageByRequirementId = new Map(
    frozen.coverage.entries.map((entry) => [entry.requirementId, entry]),
  );
  const requirements = frozen.goalContract.requirements
    .filter((requirement) => frozen.blockingRequirementIds.has(requirement.id) || targetRequirementIds.includes(requirement.id))
    .map((requirement) => {
      const coverage = coverageByRequirementId.get(requirement.id);
      return {
        id: requirement.id,
        statement: requirement.statement,
        blocking: requirement.blocking,
        acceptanceCriteria: [...requirement.acceptanceCriteria],
        expectedArtifacts: requirement.expectedArtifacts.map((artifact) => ({
          mediaType: artifact.mediaType,
          description: artifact.description,
        })),
        producerTaskIds: [...(coverage?.producerTaskIds ?? [])],
        evaluatorTaskIds: [...(coverage?.evaluatorTaskIds ?? [])],
        criterionIds: [...(coverage?.criterionIds ?? [])],
        requiredEvidenceKinds: [...(coverage?.requiredEvidenceKinds ?? [])],
      };
    });
  return {
    schemaVersion: "southstar.task_goal_requirement_context.v1",
    goalContractHash: frozen.coverage.goalContractHash,
    targetRequirementIds,
    blockingRequirementIds,
    requirements,
  };
}

async function evaluatorPipelineForTask(
  db: SouthstarDb,
  runId: string,
  task: WorkflowTaskDefinition,
  pipeline: EvaluatorPipelineDefinition,
): Promise<EvaluatorPipelineDefinition> {
  const pipelineBindingIds = unique([
    ...(pipeline.validationBindingIds ?? []),
    ...pipeline.evaluators.flatMap((step) => {
      const bindingId = stringValue(step.config.validationBindingId);
      return bindingId ? [bindingId] : [];
    }),
  ]);
  if (pipelineBindingIds.length <= 1) return pipeline;

  const requirementIds = stringArray(asRecord(task.promptInputs).requirementIds);
  if (requirementIds.length === 0) return pipeline;
  const row = await db.maybeOne<{ payload_json: unknown }>(
    `select payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'goal_requirement_coverage'
        and status = 'frozen'
      order by updated_at desc
      limit 1`,
    [runId],
  );
  const coverage = storedGoalRequirementCoverage(row?.payload_json);
  if (!coverage) return pipeline;

  const pipelineBindings = new Set(pipelineBindingIds);
  const selectedBindingIds = unique(coverage.entries
    .filter((entry) => requirementIds.includes(entry.requirementId))
    .flatMap((entry) => entry.validationBindingId && pipelineBindings.has(entry.validationBindingId)
      ? [entry.validationBindingId]
      : []));
  if (selectedBindingIds.length === 0) {
    throw new Error(`task ${task.id} requirements do not map to evaluator pipeline ${pipeline.id}`);
  }
  const selectedBindings = new Set(selectedBindingIds);
  const evaluators = pipeline.evaluators.filter((step) => {
    const bindingId = stringValue(step.config.validationBindingId);
    return bindingId ? selectedBindings.has(bindingId) : false;
  });
  if (evaluators.length === 0) {
    throw new Error(`task ${task.id} evaluator pipeline ${pipeline.id} has no steps for validation bindings ${selectedBindingIds.join(", ")}`);
  }
  return {
    ...pipeline,
    evaluators,
    validationBindingIds: selectedBindingIds,
  };
}

async function readTaskUiInteractionContracts(
  db: SouthstarDb,
  runId: string,
  task: WorkflowTaskDefinition,
): Promise<UiInteractionContractV1[]> {
  const requirementIds = stringArray(asRecord(task.promptInputs).requirementIds);
  if (requirementIds.length === 0) return [];
  const run = await db.maybeOne<{ runtime_context_json: unknown }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  const runtimeContext = asRecord(run?.runtime_context_json);
  const draftId = stringValue(runtimeContext.goalRequirementDraftId) ?? stringValue(runtimeContext.draftId);
  if (!draftId) return [];
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
    [draftId],
  );
  if (!row) return [];
  const draft = storedRequirementDraft(row.payload_json.goalRequirementDraft);
  if (!draft || row.payload_json.goalRequirementDraftHash !== draft.draftHash) return [];
  const storedHashes = asRecord(row.payload_json.uiInteractionContractHashes);
  const contracts = Array.isArray(row.payload_json.uiInteractionContracts) ? row.payload_json.uiInteractionContracts : [];
  return contracts.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const contract = value as UiInteractionContractV1;
    if (contract.status !== "confirmed"
      || storedHashes[contract.id] !== contract.contractHash
      || validateUiInteractionContract(contract, draft).length > 0
      || !contract.requirementIds.some((id) => requirementIds.includes(id))) return [];
    return [structuredClone(contract)];
  });
}

function storedRequirementDraft(value: unknown): GoalRequirementDraftV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const draft = value as GoalRequirementDraftV1;
  return validateGoalRequirementDraft(draft).length === 0 ? draft : undefined;
}

function artifactContractsForTask(workflow: SouthstarWorkflowManifest, task: WorkflowTaskDefinition): ArtifactContract[] {
  const artifactContracts = required(workflow.artifactContracts, `missing workflow artifactContracts in manifest ${workflow.workflowId}`);
  return (task.requiredArtifactRefs ?? [])
    .map((artifactRef) => required(artifactContracts.find((contract) => contract.id === artifactRef), `missing artifact contract ${artifactRef}`));
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

function dynamicFailureArtifactRefIds(promptInputs: Record<string, unknown> | undefined): string[] {
  const dynamicRepair = asRecord(promptInputs?.dynamicRepair);
  const refs = [
    stringValue(dynamicRepair.failedArtifactRefId),
    ...stringArray(dynamicRepair.failedArtifactRefIds),
  ];
  return [...new Set(refs.filter((ref): ref is string => Boolean(ref)))];
}

function nodePromptSpecFromPromptInputs(promptInputs: Record<string, unknown> | undefined): WorkflowNodePromptSpec | undefined {
  const value = asRecord(promptInputs?.nodePromptSpec);
  if (!value) return undefined;
  const nodeType = workflowNodePromptType(value.nodeType);
  const goal = stringValue(value.goal);
  const requirements = stringArray(value.requirements);
  const expectedOutputs = stringArray(value.expectedOutputs);
  const acceptanceCriteria = stringArray(value.acceptanceCriteria);
  if (!nodeType || !goal || requirements.length === 0 || expectedOutputs.length === 0 || acceptanceCriteria.length === 0) {
    return undefined;
  }
  return {
    nodeType,
    goal,
    requirements,
    boundaries: stringArray(value.boundaries),
    nonGoals: stringArray(value.nonGoals),
    deliverableDocuments: deliverableDocuments(value.deliverableDocuments),
    expectedOutputs,
    testCases: nodePromptTestCases(value.testCases),
    acceptanceCriteria,
    ...(stringValue(value.failureReportContract) ? { failureReportContract: stringValue(value.failureReportContract)! } : {}),
    ...(stringArray(value.planningQuestions).length > 0 ? { planningQuestions: stringArray(value.planningQuestions) } : {}),
    ...(stringArray(value.decisionCriteria).length > 0 ? { decisionCriteria: stringArray(value.decisionCriteria) } : {}),
    ...(stringValue(value.planArtifactContract) ? { planArtifactContract: stringValue(value.planArtifactContract)! } : {}),
    ...(stringArray(value.implementationScope).length > 0 ? { implementationScope: stringArray(value.implementationScope) } : {}),
    ...(stringArray(value.filesLikelyToTouch).length > 0 ? { filesLikelyToTouch: stringArray(value.filesLikelyToTouch) } : {}),
    ...(stringArray(value.verificationChecks).length > 0 ? { verificationChecks: stringArray(value.verificationChecks) } : {}),
    ...(stringValue(value.failureArtifactContract) ? { failureArtifactContract: stringValue(value.failureArtifactContract)! } : {}),
    ...(stringArray(value.repairInputs).length > 0 ? { repairInputs: stringArray(value.repairInputs) } : {}),
    ...(stringArray(value.mustPreserve).length > 0 ? { mustPreserve: stringArray(value.mustPreserve) } : {}),
    ...(stringArray(value.reverificationChecks).length > 0 ? { reverificationChecks: stringArray(value.reverificationChecks) } : {}),
    ...(stringArray(value.reviewChecklist).length > 0 ? { reviewChecklist: stringArray(value.reviewChecklist) } : {}),
    ...(stringArray(value.riskCriteria).length > 0 ? { riskCriteria: stringArray(value.riskCriteria) } : {}),
    ...(stringArray(value.summarySections).length > 0 ? { summarySections: stringArray(value.summarySections) } : {}),
    ...(stringArray(value.handoffCriteria).length > 0 ? { handoffCriteria: stringArray(value.handoffCriteria) } : {}),
  };
}

function deliverableDocuments(value: unknown): WorkflowNodePromptSpec["deliverableDocuments"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const kind = deliverableDocumentKind(record?.kind);
    const title = stringValue(record?.title);
    const required = typeof record?.required === "boolean" ? record.required : undefined;
    const format = deliverableDocumentFormat(record?.format);
    const description = stringValue(record?.description);
    if (!kind || !title || required === undefined || !format || !description) return [];
    return [{ kind, title, required, format, description }];
  });
}

function deliverableDocumentKind(value: unknown): WorkflowNodePromptSpec["deliverableDocuments"][number]["kind"] | undefined {
  if (
    value === "design"
    || value === "implementation"
    || value === "test"
    || value === "acceptance"
    || value === "verification"
    || value === "summary"
    || value === "handoff"
    || value === "other"
  ) {
    return value;
  }
  return undefined;
}

function deliverableDocumentFormat(value: unknown): WorkflowNodePromptSpec["deliverableDocuments"][number]["format"] | undefined {
  if (value === "markdown" || value === "json" || value === "file" || value === "inline") return value;
  return undefined;
}

function workflowNodePromptType(value: unknown): WorkflowNodePromptSpec["nodeType"] | undefined {
  if (
    value === "plan"
    || value === "implement"
    || value === "verify"
    || value === "repair"
    || value === "review"
    || value === "summary"
    || value === "general"
  ) {
    return value;
  }
  return undefined;
}

function nodePromptTestCases(value: unknown): WorkflowNodePromptSpec["testCases"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const name = stringValue(record?.name);
    const expected = stringValue(record?.expected);
    if (!name || !expected) return [];
    return [{
      name,
      expected,
      ...(stringValue(record?.command) ? { command: stringValue(record?.command)! } : {}),
      ...(stringValue(record?.given) ? { given: stringValue(record?.given)! } : {}),
      ...(stringValue(record?.when) ? { when: stringValue(record?.when)! } : {}),
      ...(stringValue(record?.then) ? { then: stringValue(record?.then)! } : {}),
    }];
  });
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

async function buildAgentsMdBlocks(db: SouthstarDb, runId: string, refs: string[]): Promise<ContextBlock[]> {
  const snapshot = refs.some((ref) => ref.startsWith("agent."))
    ? await loadRunLibrarySnapshotPg(db, runId)
    : null;
  const blocks: ContextBlock[] = [];
  for (const ref of refs) {
    const object = ref.startsWith("agent.")
      ? requireSnapshotObject(snapshot!, ref, "agent_definition")
      : null;
    const text = object?.objectKind === "agent_definition"
      ? agentDefinitionMarkdown(object.state, ref)
      : `Reference ${ref}.`;
    const title = stringValue(object?.state.title) ?? stringValue(object?.state.name) ?? ref;
    blocks.push({
      id: `agents-md-${title}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
      sourceType: "agents-md",
      title,
      text,
      sourceRef: ref,
      tokenEstimate: estimateTokens(text),
    });
  }
  return blocks;
}

function agentDefinitionMarkdown(state: Record<string, unknown>, ref: string): string {
  const body = stringValue(state.body) ?? stringValue(state.content) ?? stringValue(state.markdown);
  const title = stringValue(state.title) ?? stringValue(state.name) ?? ref;
  if (body) return body;
  const description = stringValue(state.description);
  return [`# ${title}`, description ?? `Agent definition ${ref}.`].join("\n\n");
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isHostMountPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("/workspace/");
}

function attemptNumber(attemptId: string): number {
  const match = attemptId.match(/attempt-(\d+)$/);
  return match ? Number(match[1]) : 1;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function libraryRefs(values: string[] | undefined): string[] {
  return unique(values ?? []);
}
