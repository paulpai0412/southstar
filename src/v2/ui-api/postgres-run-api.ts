import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type { WorkflowCompositionValidationIssue } from "../design-library/types.ts";
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
import { runCompositionRepairLoop } from "../orchestration/composition-repair-loop.ts";
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

export type PlannerDraftToolPolicyHints = {
  allowedTools?: string[];
  deniedTools?: string[];
  requiresApprovalFor?: string[];
};

export type PlannerDraftLibraryHints = {
  roleRefs?: string[];
  agentProfileRefs?: string[];
  skillRefs?: string[];
  mcpGrantRefs?: string[];
  toolRefs?: string[];
  modelHints?: Record<string, string>;
  vaultLeasePolicyRefs?: string[];
  toolPolicyHints?: PlannerDraftToolPolicyHints;
};

export type PlannerDraftRequestContract = {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: WorkflowComposerMode;
  domainPackId?: string;
  cwd?: string;
  libraryHints?: PlannerDraftLibraryHints;
};

export type CreatePostgresPlannerDraftInput = PlannerDraftRequestContract & {
  composer?: WorkflowComposer;
};

export type RevisePostgresPlannerDraftInput = {
  draftId: string;
  prompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: WorkflowComposerMode;
  composer?: WorkflowComposer;
};

export async function createPostgresPlannerDraft(db: SouthstarDb, input: CreatePostgresPlannerDraftInput): Promise<PostgresPlannerDraftResult> {
  const plannerRequest = plannerRequestSnapshot(input);
  const draftInput: CreatePostgresPlannerDraftInput = { ...plannerRequest, composer: input.composer };
  if (plannerRequest.orchestrationMode === "llm-constrained") {
    return createLibraryConstrainedPlannerDraft(db, draftInput);
  }
  return createDeterministicPlannerDraft(db, draftInput);
}

export async function revisePostgresPlannerDraft(
  db: SouthstarDb,
  input: RevisePostgresPlannerDraftInput,
): Promise<PostgresPlannerDraftResult> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);

  const summary = asRecord(draft.summary);
  const payload = asRecord(draft.payload);
  const workflow = asRecord(payload.workflow);
  const baseGoalPrompt = stringValue(summary.goalPrompt) ?? stringValue(workflow.goalPrompt);
  if (!baseGoalPrompt) throw new Error(`planner draft goalPrompt is missing: ${input.draftId}`);

  const revisedGoalPrompt = `${baseGoalPrompt}\n\nRevision request:\n${input.prompt}`;
  const priorPlannerRequest = plannerRequestFromStored(summary.plannerRequest) ?? plannerRequestFromStored(payload.plannerRequest);
  return createPostgresPlannerDraft(db, {
    ...preservedPlannerRequestFields(priorPlannerRequest),
    goalPrompt: revisedGoalPrompt,
    orchestrationMode: input.orchestrationMode ?? priorPlannerRequest?.orchestrationMode ?? inferDraftOrchestrationMode(summary),
    composerMode: input.composerMode ?? priorPlannerRequest?.composerMode ?? inferDraftComposerMode(payload),
    composer: input.composer,
  });
}

function preservedPlannerRequestFields(input: PlannerDraftRequestContract | undefined): Partial<PlannerDraftRequestContract> {
  if (!input) return {};
  return {
    ...(input.domainPackId !== undefined ? { domainPackId: input.domainPackId } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.libraryHints !== undefined ? { libraryHints: plannerLibraryHintsSnapshot(input.libraryHints) } : {}),
  };
}

function plannerRequestSnapshot(input: PlannerDraftRequestContract): PlannerDraftRequestContract {
  const snapshot: PlannerDraftRequestContract = {
    goalPrompt: input.goalPrompt,
    ...(input.orchestrationMode !== undefined ? { orchestrationMode: input.orchestrationMode } : {}),
    ...(input.composerMode !== undefined ? { composerMode: input.composerMode } : {}),
    ...(input.domainPackId !== undefined ? { domainPackId: input.domainPackId } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };
  if (input.libraryHints) {
    snapshot.libraryHints = plannerLibraryHintsSnapshot(input.libraryHints);
  }
  return snapshot;
}

function plannerLibraryHintsSnapshot(input: PlannerDraftLibraryHints): PlannerDraftLibraryHints {
  return {
    ...(input.roleRefs !== undefined ? { roleRefs: [...input.roleRefs] } : {}),
    ...(input.agentProfileRefs !== undefined ? { agentProfileRefs: [...input.agentProfileRefs] } : {}),
    ...(input.skillRefs !== undefined ? { skillRefs: [...input.skillRefs] } : {}),
    ...(input.mcpGrantRefs !== undefined ? { mcpGrantRefs: [...input.mcpGrantRefs] } : {}),
    ...(input.toolRefs !== undefined ? { toolRefs: [...input.toolRefs] } : {}),
    ...(input.modelHints !== undefined ? { modelHints: { ...input.modelHints } } : {}),
    ...(input.vaultLeasePolicyRefs !== undefined ? { vaultLeasePolicyRefs: [...input.vaultLeasePolicyRefs] } : {}),
    ...(input.toolPolicyHints !== undefined ? { toolPolicyHints: plannerToolPolicyHintsSnapshot(input.toolPolicyHints) } : {}),
  };
}

function plannerToolPolicyHintsSnapshot(input: PlannerDraftToolPolicyHints): PlannerDraftToolPolicyHints {
  return {
    ...(input.allowedTools !== undefined ? { allowedTools: [...input.allowedTools] } : {}),
    ...(input.deniedTools !== undefined ? { deniedTools: [...input.deniedTools] } : {}),
    ...(input.requiresApprovalFor !== undefined ? { requiresApprovalFor: [...input.requiresApprovalFor] } : {}),
  };
}

function plannerRequestFromStored(value: unknown): PlannerDraftRequestContract | undefined {
  const record = asRecord(value);
  const goalPrompt = stringValue(record.goalPrompt);
  if (!goalPrompt) return undefined;
  return plannerRequestSnapshot({
    goalPrompt,
    orchestrationMode: plannerRequestOrchestrationMode(record.orchestrationMode),
    composerMode: plannerRequestComposerMode(record.composerMode),
    domainPackId: stringValue(record.domainPackId),
    cwd: stringValue(record.cwd),
    libraryHints: plannerLibraryHintsFromStored(record.libraryHints),
  });
}

function plannerLibraryHintsFromStored(value: unknown): PlannerDraftLibraryHints | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  return plannerLibraryHintsSnapshot({
    roleRefs: stringArrayValue(record.roleRefs),
    agentProfileRefs: stringArrayValue(record.agentProfileRefs),
    skillRefs: stringArrayValue(record.skillRefs),
    mcpGrantRefs: stringArrayValue(record.mcpGrantRefs),
    toolRefs: stringArrayValue(record.toolRefs),
    modelHints: stringRecordValue(record.modelHints),
    vaultLeasePolicyRefs: stringArrayValue(record.vaultLeasePolicyRefs),
    toolPolicyHints: plannerToolPolicyHintsFromStored(record.toolPolicyHints),
  });
}

function plannerToolPolicyHintsFromStored(value: unknown): PlannerDraftToolPolicyHints | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  return plannerToolPolicyHintsSnapshot({
    allowedTools: stringArrayValue(record.allowedTools),
    deniedTools: stringArrayValue(record.deniedTools),
    requiresApprovalFor: stringArrayValue(record.requiresApprovalFor),
  });
}

function plannerRequestOrchestrationMode(value: unknown): PlannerDraftRequestContract["orchestrationMode"] {
  return value === "deterministic" || value === "llm-constrained" ? value : undefined;
}

function plannerRequestComposerMode(value: unknown): WorkflowComposerMode | undefined {
  return value === "fixture" || value === "llm" || value === "llm-with-fixture-fallback" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : [];
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  const strings = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(strings);
}

async function createDeterministicPlannerDraft(
  db: SouthstarDb,
  input: CreatePostgresPlannerDraftInput,
): Promise<PostgresPlannerDraftResult> {
  const draftRunId = `draft-software-${hash(input.goalPrompt).slice(0, 12)}`;
  const plan = generateConstrainedWorkflowPlan({
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    domainPack: softwareDomainPack,
    intentId: inferIntent(input.goalPrompt),
  });
  const workflow = materializeGenerationPlan({ plan, domainPack: softwareDomainPack, goalPrompt: input.goalPrompt });
  const bundle: PlanBundle & { generationPlan: typeof plan; plannerRequest: PlannerDraftRequestContract } = {
    workflow,
    plannerTrace: { model: "southstar-postgres-constrained-planner", promptHash: hash(input.goalPrompt), generatedAt: new Date().toISOString() },
    generationPlan: plan,
    plannerRequest: plannerRequestSnapshot(input),
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
      plannerRequest: plannerRequestSnapshot(input),
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
  input: CreatePostgresPlannerDraftInput,
): Promise<PostgresPlannerDraftResult> {
  const draftRunId = `draft-library-${hash(input.goalPrompt).slice(0, 12)}`;
  await seedSoftwareLibraryGraph(db);
  const requirementSpec = analyzeRequirementDeterministically(input.goalPrompt);
  const candidatePacket = await resolveWorkflowCandidates(db, {
    requirementSpec,
    scope: "software",
  });
  const workflowId = `wf-composed-${hash(draftRunId).slice(0, 12)}`;
  const draftId = `draft-${workflowId}`;

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
        requirementSpec,
        candidatePacket,
        unavailableRequirements: candidatePacket.unavailableRequirements,
        plannerRequest: plannerRequestSnapshot(input),
      },
      summary: {
        goalPrompt: input.goalPrompt,
        workflowId,
        planner: "library-constrained-llm",
        status,
        validationIssues,
        taskSummaries,
        plannerRequest: plannerRequestSnapshot(input),
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
    scope: "software",
    maxRepairAttempts: 2,
  });
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
        requirementSpec,
        candidatePacket,
        repairAttempts: repairResult.attempts,
        validationIssues,
        plannerRequest: plannerRequestSnapshot(input),
      },
      summary: {
        goalPrompt: input.goalPrompt,
        workflowId,
        planner: "library-constrained-llm",
        status,
        validationIssues,
        taskSummaries,
        plannerRequest: plannerRequestSnapshot(input),
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
  });
  const bundle: PlanBundle & {
    orchestrationSnapshot: ReturnType<typeof compileWorkflowComposition> extends Promise<infer T> ? T["orchestrationSnapshot"] : never;
    repairAttempts: typeof repairResult.attempts;
    plannerRequest: PlannerDraftRequestContract;
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
    plannerRequest: plannerRequestSnapshot(input),
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
      plannerRequest: plannerRequestSnapshot(input),
    },
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

function inferDraftOrchestrationMode(summary: Record<string, unknown>): "deterministic" | "llm-constrained" {
  const planner = stringValue(summary.planner);
  return planner === "library-constrained-llm" ? "llm-constrained" : "deterministic";
}

function inferDraftComposerMode(payload: Record<string, unknown>): WorkflowComposerMode | undefined {
  const plannerTrace = asRecord(payload.plannerTrace);
  const composerMode = stringValue(plannerTrace.composerMode);
  if (composerMode === "fixture" || composerMode === "llm" || composerMode === "llm-with-fixture-fallback") return composerMode;
  return undefined;
}
