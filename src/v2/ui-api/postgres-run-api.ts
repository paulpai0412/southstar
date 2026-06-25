import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type { GeneratedComponentProposal, LibraryDefinitionKind, WorkflowCompositionValidationIssue } from "../design-library/types.ts";
import { seedSoftwareLibraryGraph } from "../design-library/software-library-seed.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import type { DomainPack } from "../domain-packs/types.ts";
import { generateConstrainedWorkflowPlan } from "../workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../workflow-generator/materialize.ts";
import type { PlanBundle, SouthstarWorkflowManifest } from "../manifests/types.ts";
import { resolveWorkflowCandidates } from "../orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../orchestration/composition-compiler.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { createWorkflowComposerRegistry, type WorkflowComposerMode } from "../orchestration/composer-registry.ts";
import { runCompositionRepairLoop, type CompositionRepairAttempt } from "../orchestration/composition-repair-loop.ts";
import { analyzeRequirementDeterministically } from "../orchestration/requirement-analyzer.ts";
import {
  appendHistoryEventPg,
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import { buildContextPacketWithKnowledgeCards } from "../context/postgres-builder.ts";

export type PostgresPlannerDraftResult = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
  status: string;
  validationIssues: PlannerDraftValidationIssue[];
  taskSummaries: PlannerDraftTaskSummary[];
};

export type PlannerDraftValidationIssue = {
  path: string;
  message: string;
  code?: string;
};

export type PlannerDraftTaskSummary = {
  taskId: string;
  taskName: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
};

export type PostgresPlannerDraftOrchestrationView = PostgresPlannerDraftResult & {
  orchestrationSnapshot?: unknown;
  plannerTrace?: unknown;
  repairAttempts?: unknown;
};

export type PostgresRunResult = {
  runId: string;
  taskIds: string[];
};

export type PlannerDraftProposalStatus = "proposed" | "approved-for-draft" | "rejected" | "converted";

export type PlannerDraftProposalSummary = {
  proposalId: string;
  draftId: string;
  kind: LibraryDefinitionKind;
  status: PlannerDraftProposalStatus;
  risk: "low" | "medium" | "high";
  reason: string;
  validationStatus: "validated" | "unvalidated";
  source: {
    plannerDraftId: string;
    compositionHash?: string;
  };
  libraryDraftId?: string;
};

export type ConvertPlannerDraftProposalResult = {
  proposalId: string;
  status: "converted" | "blocked";
  libraryDraftId?: string;
  reason?: string;
};

export type CreatePostgresPlannerDraftInput = {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: WorkflowComposerMode;
  composer?: WorkflowComposer;
  scope?: string;
};

export async function createPostgresPlannerDraft(db: SouthstarDb, input: CreatePostgresPlannerDraftInput): Promise<PostgresPlannerDraftResult> {
  if (input.orchestrationMode === "llm-constrained") {
    return createLibraryConstrainedPlannerDraft(db, input);
  }
  return createDeterministicPlannerDraft(db, input);
}

async function createDeterministicPlannerDraft(
  db: SouthstarDb,
  input: { goalPrompt: string; scope?: string },
): Promise<PostgresPlannerDraftResult> {
  const scope = normalizedScope(input.scope);
  if (scope !== "software") {
    throw new Error(`deterministic planner only supports software scope: ${scope}`);
  }
  const draftRunId = `draft-software-${hash(input.goalPrompt).slice(0, 12)}`;
  const plan = generateConstrainedWorkflowPlan({
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    domainPack: softwareDomainPack,
    intentId: inferIntent(input.goalPrompt),
  });
  const workflow = materializeGenerationPlan({ plan, domainPack: softwareDomainPack, goalPrompt: input.goalPrompt });
  const bundle: PlanBundle & { generationPlan: typeof plan } = {
    workflow,
    plannerTrace: { model: "southstar-postgres-constrained-planner", promptHash: hash(input.goalPrompt), generatedAt: new Date().toISOString() },
    generationPlan: plan,
  };
  const validationIssues: PlannerDraftValidationIssue[] = [];
  const taskSummaries = summarizeWorkflowTasks(workflow);
  const status = "validated";
  const draftId = `draft-${workflow.workflowId}`;
  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status,
    title: workflow.title,
    payload: bundle,
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: workflow.workflowId,
      planner: "postgres-constrained",
      status,
      validationIssues,
      taskSummaries,
    },
  });
  return {
    draftId,
    goalPrompt: input.goalPrompt,
    workflowId: workflow.workflowId,
    status,
    validationIssues,
    taskSummaries,
  };
}

async function createLibraryConstrainedPlannerDraft(
  db: SouthstarDb,
  input: { goalPrompt: string; composerMode?: WorkflowComposerMode; composer?: WorkflowComposer; scope?: string },
): Promise<PostgresPlannerDraftResult> {
  const scope = normalizedScope(input.scope);
  const draftRunId = `draft-library-${scopeToken(scope)}-${hash(input.goalPrompt).slice(0, 12)}`;
  if (scope === "software") {
    await seedSoftwareLibraryGraph(db);
  }
  const requirementSpec = analyzeRequirementDeterministically(input.goalPrompt);
  const candidatePacket = await resolveWorkflowCandidates(db, {
    requirementSpec,
    scope,
  });
  const workflowId = `wf-composed-${hash(draftRunId).slice(0, 12)}`;
  const draftId = `draft-${workflowId}`;
  const emptyLlmTrace = buildSanitizedLlmTrace(input.goalPrompt, []);

  if (candidatePacket.unavailableRequirements.length > 0) {
    const validationIssues = unavailableRequirementIssues(candidatePacket.unavailableRequirements);
    const status = "invalid";
    const taskSummaries: PlannerDraftTaskSummary[] = [];
    await upsertRuntimeResourcePg(db, {
      id: draftId,
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status,
      title: "Invalid Library-Constrained Planner Draft",
      payload: {
        scope,
        requirementSpec,
        candidatePacket,
        unavailableRequirements: candidatePacket.unavailableRequirements,
        llmTrace: emptyLlmTrace,
      },
      summary: {
        goalPrompt: input.goalPrompt,
        workflowId,
        planner: "library-constrained-llm",
        status,
        validationIssues,
        taskSummaries,
      },
    });
    return {
      draftId,
      goalPrompt: input.goalPrompt,
      workflowId,
      status,
      validationIssues,
      taskSummaries,
    };
  }

  const registry = createWorkflowComposerRegistry({ llmComposer: input.composer });
  const composerMode = input.composerMode ?? "llm";
  const composer = registry.resolve({ composerMode });
  const fallbackImplicitlySelected = composerMode === "llm-with-fixture-fallback" && !input.composer;
  const repairResult = await runCompositionRepairLoop({
    db,
    goalPrompt: input.goalPrompt,
    candidatePacket,
    composer,
    scope,
    maxRepairAttempts: 2,
  });
  const llmTrace = buildSanitizedLlmTrace(input.goalPrompt, repairResult.attempts);
  if (!repairResult.validation.ok) {
    const validationIssues = toPlannerDraftValidationIssues(repairResult.validation.issues);
    const status = "invalid";
    const taskSummaries: PlannerDraftTaskSummary[] = [];
    await upsertRuntimeResourcePg(db, {
      id: draftId,
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status,
      title: "Invalid Library-Constrained Planner Draft",
      payload: {
        scope,
        requirementSpec,
        candidatePacket,
        repairAttempts: repairResult.attempts,
        llmTrace,
        validationIssues,
      },
      summary: {
        goalPrompt: input.goalPrompt,
        workflowId,
        planner: "library-constrained-llm",
        status,
        validationIssues,
        taskSummaries,
      },
    });
    return {
      draftId,
      goalPrompt: input.goalPrompt,
      workflowId,
      status,
      validationIssues,
      taskSummaries,
    };
  }
  const composition = repairResult.composition;
  if (!composition) {
    throw new Error("composition repair loop returned ok validation without composition");
  }
  const compiled = await compileWorkflowComposition(db, {
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    candidatePacket,
    composition,
    scope,
  });
  const bundle: PlanBundle & {
    orchestrationSnapshot: ReturnType<typeof compileWorkflowComposition> extends Promise<infer T> ? T["orchestrationSnapshot"] : never;
    repairAttempts: typeof repairResult.attempts;
    llmTrace: ReturnType<typeof buildSanitizedLlmTrace>;
  } = {
    workflow: compiled.workflow,
    plannerTrace: {
      model: `southstar-library-constrained-${composerMode}-composer`,
      promptHash: hash(input.goalPrompt),
      generatedAt: new Date().toISOString(),
      analyzerType: "deterministic",
      composerMode,
      composerFallbackUsed: fallbackImplicitlySelected || didComposerUseFallback(composer),
      validatorAttempts: repairResult.attempts.length,
      repairAttempts: Math.max(0, repairResult.attempts.length - 1),
      finalValidationOk: repairResult.validation.ok,
      candidatePacketHash: hash(JSON.stringify(candidatePacket)),
      compositionHash: hash(JSON.stringify(composition)),
    },
    orchestrationSnapshot: compiled.orchestrationSnapshot,
    repairAttempts: repairResult.attempts,
    llmTrace,
  };
  const validationIssues = toPlannerDraftValidationIssues(compiled.orchestrationSnapshot.validation.issues);
  const taskSummaries = summarizeWorkflowTasks(compiled.workflow);
  const status = "validated";

  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status,
    title: compiled.workflow.title,
    payload: bundle,
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: compiled.workflow.workflowId,
      planner: "library-constrained-llm",
      status,
      validationIssues,
      taskSummaries,
    },
  });
  await persistGeneratedComponentProposals(db, {
    draftId,
    proposals: composition.generatedComponentProposals,
    compositionHash: hash(JSON.stringify(composition)),
  });
  return {
    draftId,
    goalPrompt: input.goalPrompt,
    workflowId: compiled.workflow.workflowId,
    status,
    validationIssues,
    taskSummaries,
  };
}

export async function createPostgresRunFromDraft(db: SouthstarDb, input: { draftId: string }): Promise<PostgresRunResult> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  if (draft.status !== "validated") throw new Error(`planner draft is not validated: ${input.draftId}`);
  const bundle = draft.payload as PlanBundle & { generationPlan?: { templateRef?: string } };
  const workflow = bundle.workflow;
  const runId = await allocateRunId(db, workflow.workflowId);

  await createWorkflowRunPg(db, {
    id: runId,
    status: "created",
    domain: workflow.domain,
    goalPrompt: workflow.goalPrompt,
    workflowManifestJson: JSON.stringify(workflow),
    executionProjectionJson: JSON.stringify({ executor: "pending" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({ draftId: input.draftId, scope: workflow.domain }),
    metricsJson: JSON.stringify({}),
  });
  await appendHistoryEventPg(db, {
    runId,
    eventType: "run.created",
    actorType: "orchestrator",
    payload: { draftId: input.draftId, workflowId: workflow.workflowId },
  });

  const taskIds: string[] = [];
  for (const [index, task] of workflow.tasks.entries()) {
    await createWorkflowTaskPg(db, {
      id: task.id,
      runId,
      taskKey: task.name ?? task.id,
      status: "pending",
      sortOrder: index,
      dependsOn: task.dependsOn,
      snapshot: { roleRef: task.roleRef, agentProfileRef: task.agentProfileRef },
      metrics: {},
    });
    await appendHistoryEventPg(db, {
      runId,
      taskId: task.id,
      eventType: "task.created",
      actorType: "orchestrator",
      payload: { taskKey: task.name ?? task.id, dependsOn: task.dependsOn },
    });
    await buildContextForTask(db, workflow, task.id, runId, bundle.generationPlan?.templateRef ?? "software.workflow.feature-implementation");
    taskIds.push(task.id);
  }

  return { runId, taskIds };
}

export async function getPostgresPlannerDraftOrchestration(
  db: SouthstarDb,
  input: { draftId: string },
): Promise<PostgresPlannerDraftOrchestrationView> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);

  const payload = asRecord(draft.payload);
  const summary = asRecord(draft.summary);
  const workflow = asRecord(payload.workflow);
  const workflowId = stringValue(summary.workflowId) ?? stringValue(workflow.workflowId) ?? "";
  const goalPrompt = stringValue(summary.goalPrompt) ?? stringValue(workflow.goalPrompt) ?? "";
  const validationIssues = parseValidationIssues(summary.validationIssues);
  const taskSummaries = parseTaskSummaries(summary.taskSummaries).length > 0
    ? parseTaskSummaries(summary.taskSummaries)
    : summarizeWorkflowTasksFromPayload(workflow.tasks);

  return {
    draftId: input.draftId,
    goalPrompt,
    workflowId,
    status: draft.status,
    validationIssues,
    taskSummaries,
    ...(payload.orchestrationSnapshot !== undefined ? { orchestrationSnapshot: payload.orchestrationSnapshot } : {}),
    ...(payload.plannerTrace !== undefined ? { plannerTrace: payload.plannerTrace } : {}),
    ...(payload.repairAttempts !== undefined ? { repairAttempts: payload.repairAttempts } : {}),
  };
}

export async function listPostgresPlannerDraftProposals(
  db: SouthstarDb,
  input: { draftId: string },
): Promise<PlannerDraftProposalSummary[]> {
  const rows = await db.query<{
    payload_json: unknown;
    status: string;
  }>(
    `select payload_json, status
       from southstar.runtime_resources
      where resource_type = 'library_component_proposal'
        and payload_json->>'draftId' = $1
      order by created_at, resource_key`,
    [input.draftId],
  );
  const proposals: PlannerDraftProposalSummary[] = [];
  for (const row of rows.rows) {
    const parsed = parsePlannerDraftProposalPayload(row.payload_json);
    if (!parsed) continue;
    proposals.push({
      ...parsed,
      status: asPlannerDraftProposalStatus(row.status) ?? parsed.status,
    });
  }
  return proposals;
}

export async function approvePostgresPlannerDraftProposal(
  db: SouthstarDb,
  input: { draftId: string; proposalId: string; actorId?: string; reason?: string },
): Promise<{ proposalId: string; status: PlannerDraftProposalStatus }> {
  return await updatePostgresPlannerDraftProposalStatus(db, {
    draftId: input.draftId,
    proposalId: input.proposalId,
    status: "approved-for-draft",
    actorId: input.actorId,
    reason: input.reason,
  });
}

export async function rejectPostgresPlannerDraftProposal(
  db: SouthstarDb,
  input: { draftId: string; proposalId: string; actorId?: string; reason?: string },
): Promise<{ proposalId: string; status: PlannerDraftProposalStatus }> {
  return await updatePostgresPlannerDraftProposalStatus(db, {
    draftId: input.draftId,
    proposalId: input.proposalId,
    status: "rejected",
    actorId: input.actorId,
    reason: input.reason,
  });
}

export async function convertPostgresPlannerDraftProposalToLibraryDraft(
  db: SouthstarDb,
  input: { draftId: string; proposalId: string; actorId?: string; reason?: string },
): Promise<ConvertPlannerDraftProposalResult> {
  const proposal = await requiredPlannerDraftProposal(db, input.draftId, input.proposalId);
  if (!isConvertibleProposalKind(proposal.kind)) {
    return {
      proposalId: input.proposalId,
      status: "blocked",
      reason: `conversion is not supported for proposal kind: ${proposal.kind}`,
    };
  }

  const libraryDraftId = `library-draft-${hash(`${input.draftId}:${input.proposalId}`).slice(0, 20)}`;
  await upsertRuntimeResourcePg(db, {
    id: libraryDraftId,
    resourceType: "library_object_draft",
    resourceKey: libraryDraftId,
    scope: "planner",
    status: "draft",
    title: `Library draft for ${input.proposalId}`,
    payload: {
      schemaVersion: "southstar.library_object_draft.v1",
      draftId: libraryDraftId,
      sourceProposalId: proposal.proposalId,
      sourcePlannerDraftId: proposal.draftId,
      kind: proposal.kind,
      status: "draft",
      risk: proposal.risk,
      reason: proposal.reason,
      createdBy: input.actorId ?? "planner-proposal-converter",
      createdReason: input.reason,
      createdAt: new Date().toISOString(),
    },
    summary: {
      sourceProposalId: proposal.proposalId,
      sourcePlannerDraftId: proposal.draftId,
      kind: proposal.kind,
      status: "draft",
    },
  });

  await updatePostgresPlannerDraftProposalStatus(db, {
    draftId: input.draftId,
    proposalId: input.proposalId,
    status: "converted",
    actorId: input.actorId,
    reason: input.reason,
    libraryDraftId,
  });

  return {
    proposalId: input.proposalId,
    status: "converted",
    libraryDraftId,
  };
}

async function buildContextForTask(
  db: SouthstarDb,
  workflow: SouthstarWorkflowManifest,
  taskId: string,
  runId: string,
  flowTemplateRef: string,
): Promise<void> {
  const task = workflow.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const domainPack = domainPackForWorkflow(workflow);
  await buildContextPacketWithKnowledgeCards(db, {
    runId,
    taskId: task.id,
    rootSessionId: `root-${runId}-${task.id}`,
    goalPrompt: workflow.goalPrompt,
    domainPack,
    roleRef: task.roleRef,
    agentProfileRef: task.agentProfileRef,
    artifactContractRefs: task.requiredArtifactRefs,
    priorArtifactRefs: [],
    intent: workflow.intent,
    flowTemplateRef,
    promptTemplateRef: task.promptTemplateRef,
    skillRefs: task.skillRefs,
  });
}

async function allocateRunId(db: SouthstarDb, workflowId: string): Promise<string> {
  const base = `run-${workflowId}`;
  if (!await runExists(db, base)) return base;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = `${base}-${Date.now().toString(36)}-${attempt}`;
    if (!await runExists(db, candidate)) return candidate;
  }
  throw new Error(`unable to allocate run id for workflow ${workflowId}`);
}

async function runExists(db: SouthstarDb, runId: string): Promise<boolean> {
  return Boolean(await db.maybeOne("select 1 from southstar.workflow_runs where id = $1", [runId]));
}

function inferIntent(goalPrompt: string): "implement_feature" | "fix_bug" {
  return /fix|bug|failing|修正|錯誤/i.test(goalPrompt) ? "fix_bug" : "implement_feature";
}

function domainPackForWorkflow(workflow: SouthstarWorkflowManifest): DomainPack {
  return {
    ...softwareDomainPack,
    id: workflow.domain ?? softwareDomainPack.id,
    roles: workflow.roles ?? softwareDomainPack.roles,
    agentProfiles: workflow.agentProfiles ?? softwareDomainPack.agentProfiles,
    artifactContracts: workflow.artifactContracts ?? softwareDomainPack.artifactContracts,
    evaluatorPipelines: workflow.evaluatorPipelines ?? softwareDomainPack.evaluatorPipelines,
    contextPolicies: workflow.contextPolicies ?? softwareDomainPack.contextPolicies,
    sessionPolicies: workflow.sessionPolicies ?? softwareDomainPack.sessionPolicies,
    memoryPolicies: workflow.memoryPolicies ?? softwareDomainPack.memoryPolicies,
    workspacePolicies: workflow.workspacePolicies ?? softwareDomainPack.workspacePolicies,
    stopConditions: workflow.stopConditions ?? softwareDomainPack.stopConditions,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function didComposerUseFallback(composer: WorkflowComposer): boolean {
  const maybeFallbackAwareComposer = composer as WorkflowComposer & { wasFallbackUsed?: () => boolean };
  return maybeFallbackAwareComposer.wasFallbackUsed?.() === true;
}

function summarizeWorkflowTasks(workflow: SouthstarWorkflowManifest): PlannerDraftTaskSummary[] {
  return workflow.tasks.map((task) => ({
    taskId: task.id,
    taskName: task.name,
    dependsOn: task.dependsOn,
    ...(task.roleRef ? { roleRef: task.roleRef } : {}),
    ...(task.agentProfileRef ? { agentProfileRef: task.agentProfileRef } : {}),
  }));
}

function summarizeWorkflowTasksFromPayload(tasksValue: unknown): PlannerDraftTaskSummary[] {
  if (!Array.isArray(tasksValue)) return [];
  const summaries: PlannerDraftTaskSummary[] = [];
  for (const task of tasksValue) {
    if (!isRecord(task)) continue;
    const taskId = stringValue(task.id);
    if (!taskId) continue;
    summaries.push({
      taskId,
      taskName: stringValue(task.name) ?? taskId,
      dependsOn: parseDependsOn(task.dependsOn),
      ...(stringValue(task.roleRef) ? { roleRef: stringValue(task.roleRef) } : {}),
      ...(stringValue(task.agentProfileRef) ? { agentProfileRef: stringValue(task.agentProfileRef) } : {}),
    });
  }
  return summaries;
}

function parseDependsOn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function unavailableRequirementIssues(
  unavailableRequirements: Array<{ capabilityRef: string; reason: "no_approved_candidate" | "blocked_by_policy" | "requires_approval" }>,
): PlannerDraftValidationIssue[] {
  return unavailableRequirements.map((requirement, index) => ({
    path: `unavailableRequirements.${index}.capabilityRef`,
    code: requirement.reason,
    message: `missing supported candidate for ${requirement.capabilityRef} (${requirement.reason})`,
  }));
}

async function persistGeneratedComponentProposals(
  db: SouthstarDb,
  input: {
    draftId: string;
    proposals: GeneratedComponentProposal[];
    compositionHash: string;
  },
): Promise<void> {
  for (const proposal of input.proposals) {
    const proposalSummary: PlannerDraftProposalSummary = {
      proposalId: proposal.id,
      draftId: input.draftId,
      kind: proposal.kind,
      status: "proposed",
      risk: proposal.risk,
      reason: proposal.reason,
      validationStatus: proposal.validationStatus,
      source: {
        plannerDraftId: input.draftId,
        compositionHash: input.compositionHash,
      },
    };
    const resourceKey = proposalResourceKey(input.draftId, proposal.id);
    await upsertRuntimeResourcePg(db, {
      id: resourceKey,
      resourceType: "library_component_proposal",
      resourceKey,
      scope: "planner",
      status: proposalSummary.status,
      title: `Generated proposal ${proposal.id}`,
      payload: proposalSummary,
      summary: {
        proposalId: proposalSummary.proposalId,
        draftId: proposalSummary.draftId,
        kind: proposalSummary.kind,
        status: proposalSummary.status,
        risk: proposalSummary.risk,
      },
    });
  }
}

async function updatePostgresPlannerDraftProposalStatus(
  db: SouthstarDb,
  input: {
    draftId: string;
    proposalId: string;
    status: PlannerDraftProposalStatus;
    actorId?: string;
    reason?: string;
    libraryDraftId?: string;
  },
): Promise<{ proposalId: string; status: PlannerDraftProposalStatus }> {
  const resourceKey = proposalResourceKey(input.draftId, input.proposalId);
  const row = await db.maybeOne<{ payload_json: unknown }>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'library_component_proposal'
        and resource_key = $1`,
    [resourceKey],
  );
  if (!row) throw new Error(`planner draft proposal not found: ${input.draftId}/${input.proposalId}`);
  const parsed = parsePlannerDraftProposalPayload(row.payload_json);
  if (!parsed) throw new Error(`planner draft proposal payload invalid: ${input.draftId}/${input.proposalId}`);
  if (parsed.draftId !== input.draftId) throw new Error(`planner draft proposal does not belong to draft: ${input.proposalId}`);

  const payload: PlannerDraftProposalSummary & {
    moderation?: {
      actorId?: string;
      reason?: string;
      at: string;
    };
  } = {
    ...parsed,
    status: input.status,
    ...(input.libraryDraftId ? { libraryDraftId: input.libraryDraftId } : {}),
    moderation: {
      actorId: input.actorId,
      reason: input.reason,
      at: new Date().toISOString(),
    },
  };
  await upsertRuntimeResourcePg(db, {
    id: resourceKey,
    resourceType: "library_component_proposal",
    resourceKey,
    scope: "planner",
    status: payload.status,
    title: `Generated proposal ${input.proposalId}`,
    payload,
    summary: {
      proposalId: payload.proposalId,
      draftId: payload.draftId,
      kind: payload.kind,
      status: payload.status,
      risk: payload.risk,
      ...(payload.libraryDraftId ? { libraryDraftId: payload.libraryDraftId } : {}),
    },
  });
  return { proposalId: input.proposalId, status: input.status };
}

async function requiredPlannerDraftProposal(
  db: SouthstarDb,
  draftId: string,
  proposalId: string,
): Promise<PlannerDraftProposalSummary> {
  const resourceKey = proposalResourceKey(draftId, proposalId);
  const row = await db.maybeOne<{ payload_json: unknown }>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'library_component_proposal'
        and resource_key = $1`,
    [resourceKey],
  );
  if (!row) throw new Error(`planner draft proposal not found: ${draftId}/${proposalId}`);
  const proposal = parsePlannerDraftProposalPayload(row.payload_json);
  if (!proposal) throw new Error(`planner draft proposal payload invalid: ${draftId}/${proposalId}`);
  return proposal;
}

function proposalResourceKey(draftId: string, proposalId: string): string {
  return `library-component-proposal:${draftId}:${proposalId}`;
}

function parsePlannerDraftProposalPayload(value: unknown): PlannerDraftProposalSummary | null {
  if (!isRecord(value)) return null;
  const proposalId = stringValue(value.proposalId);
  const draftId = stringValue(value.draftId);
  const kind = libraryDefinitionKindValue(value.kind);
  const status = asPlannerDraftProposalStatus(value.status);
  const risk = riskValue(value.risk);
  const reason = stringValue(value.reason);
  const validationStatus = validationStatusValue(value.validationStatus);
  const sourceRecord = isRecord(value.source) ? value.source : {};
  const sourcePlannerDraftId = stringValue(sourceRecord.plannerDraftId);
  if (!proposalId || !draftId || !kind || !status || !risk || !reason || !validationStatus || !sourcePlannerDraftId) {
    return null;
  }
  return {
    proposalId,
    draftId,
    kind,
    status,
    risk,
    reason,
    validationStatus,
    source: {
      plannerDraftId: sourcePlannerDraftId,
      ...(stringValue(sourceRecord.compositionHash) ? { compositionHash: stringValue(sourceRecord.compositionHash) } : {}),
    },
    ...(stringValue(value.libraryDraftId) ? { libraryDraftId: stringValue(value.libraryDraftId) } : {}),
  };
}

function asPlannerDraftProposalStatus(value: unknown): PlannerDraftProposalStatus | null {
  if (value === "proposed" || value === "approved-for-draft" || value === "rejected" || value === "converted") {
    return value;
  }
  return null;
}

function libraryDefinitionKindValue(value: unknown): LibraryDefinitionKind | null {
  if (
    value === "agent_spec"
    || value === "agent_definition"
    || value === "agent_profile"
    || value === "skill_definition"
    || value === "mcp_tool_grant"
    || value === "artifact_contract"
    || value === "evaluator_profile"
    || value === "capability_spec"
    || value === "contract_spec"
    || value === "validator_spec"
    || value === "policy_bundle"
    || value === "workflow_template"
    || value === "workflow_recipe"
    || value === "tool_definition"
    || value === "instruction_template"
    || value === "vault_lease_policy"
    || value === "skill_spec"
  ) {
    return value;
  }
  return null;
}

function riskValue(value: unknown): "low" | "medium" | "high" | null {
  if (value === "low" || value === "medium" || value === "high") return value;
  return null;
}

function validationStatusValue(value: unknown): "validated" | "unvalidated" | null {
  if (value === "validated" || value === "unvalidated") return value;
  return null;
}

function isConvertibleProposalKind(kind: LibraryDefinitionKind): boolean {
  return kind === "agent_definition"
    || kind === "agent_profile"
    || kind === "skill_definition"
    || kind === "mcp_tool_grant"
    || kind === "artifact_contract"
    || kind === "evaluator_profile"
    || kind === "policy_bundle"
    || kind === "workflow_template"
    || kind === "tool_definition"
    || kind === "instruction_template"
    || kind === "vault_lease_policy"
    || kind === "skill_spec";
}

function buildSanitizedLlmTrace(goalPrompt: string, attempts: CompositionRepairAttempt[]): {
  goalPromptHash: string;
  attempts: Array<{
    attempt: number;
    parseOutcome: "parsed" | "composer_output_error";
    validationOutcome: "valid" | "invalid";
    issueCodes: string[];
    issuesHash: string;
    compositionHash?: string;
  }>;
} {
  return {
    goalPromptHash: hash(goalPrompt),
    attempts: attempts.map((attempt, index) => {
      const issueCodes = [...new Set(attempt.validation.issues.map((issue) => issue.code ?? "unknown_issue"))].sort();
      const issuesHash = hash(JSON.stringify(attempt.validation.issues.map((issue) => ({
        code: issue.code ?? null,
        path: issue.path,
        message: issue.message,
      }))));
      return {
        attempt: Number.isFinite(attempt.attempt) ? attempt.attempt : index,
        parseOutcome: attempt.composition ? "parsed" : "composer_output_error",
        validationOutcome: attempt.validation.ok ? "valid" : "invalid",
        issueCodes,
        issuesHash,
        ...(attempt.composition ? { compositionHash: hash(JSON.stringify(attempt.composition)) } : {}),
      };
    }),
  };
}

function toPlannerDraftValidationIssues(issues: WorkflowCompositionValidationIssue[]): PlannerDraftValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path,
    message: issue.message,
    ...(issue.code ? { code: issue.code } : {}),
  }));
}

function parseValidationIssues(value: unknown): PlannerDraftValidationIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: PlannerDraftValidationIssue[] = [];
  for (const issue of value) {
    if (!isRecord(issue)) continue;
    const path = stringValue(issue.path);
    const message = stringValue(issue.message);
    if (!path || !message) continue;
    issues.push({
      path,
      message,
      ...(stringValue(issue.code) ? { code: stringValue(issue.code) } : {}),
    });
  }
  return issues;
}

function parseTaskSummaries(value: unknown): PlannerDraftTaskSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries: PlannerDraftTaskSummary[] = [];
  for (const task of value) {
    if (!isRecord(task)) continue;
    const taskId = stringValue(task.taskId);
    if (!taskId) continue;
    summaries.push({
      taskId,
      taskName: stringValue(task.taskName) ?? taskId,
      dependsOn: parseDependsOn(task.dependsOn),
      ...(stringValue(task.roleRef) ? { roleRef: stringValue(task.roleRef) } : {}),
      ...(stringValue(task.agentProfileRef) ? { agentProfileRef: stringValue(task.agentProfileRef) } : {}),
    });
  }
  return summaries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizedScope(value: string | undefined): string {
  if (!value) return "software";
  return value.trim().length === 0 ? "software" : value.trim();
}

function scopeToken(scope: string): string {
  return scope.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "software";
}
