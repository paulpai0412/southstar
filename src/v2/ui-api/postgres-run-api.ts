import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type {
  CandidatePacket,
  WorkflowCompositionPlan,
  WorkflowCompositionValidationIssue,
} from "../design-library/types.ts";
import { seedSoftwareLibraryGraph } from "../design-library/software-library-seed.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import type { DomainPack } from "../domain-packs/types.ts";
import { generateConstrainedWorkflowPlan } from "../workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../workflow-generator/materialize.ts";
import type { PlanBundle, SouthstarWorkflowManifest } from "../manifests/types.ts";
import { validateWorkflowManifest } from "../manifests/validate.ts";
import type { AgentProfile, PlannerDraftTaskProfileOverride } from "../domain-packs/types.ts";
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
import {
  patchPlannerDraftTaskProfileOverridePg,
  type PatchPlannerDraftTaskProfileOverrideInput,
  type PatchPlannerDraftTaskProfileOverrideResult,
} from "./planner-draft-task-overrides.ts";

export type {
  PatchPlannerDraftTaskProfileOverrideInput,
  PatchPlannerDraftTaskProfileOverrideResult,
} from "./planner-draft-task-overrides.ts";

const PLANNER_DRAFT_STATUS_VALIDATED = "validated";
const PLANNER_DRAFT_STATUS_INVALID = "invalid";
const PLANNER_DRAFT_STATUS_NEEDS_VALIDATION = "needs_validation";

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

export type PlannerDraftProgressEvent = {
  stage: string;
  message: string;
  attempt?: number;
  ok?: boolean;
  issueCount?: number;
};

export type PlannerDraftProgressListener = (event: PlannerDraftProgressEvent) => void;

export type CreatePostgresPlannerDraftInput = PlannerDraftRequestContract & {
  composer?: WorkflowComposer;
  onProgress?: PlannerDraftProgressListener;
  onLlmDelta?: (text: string) => void;
};

export type RevisePostgresPlannerDraftInput = {
  draftId: string;
  prompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: WorkflowComposerMode;
  composer?: WorkflowComposer;
  onProgress?: PlannerDraftProgressListener;
  onLlmDelta?: (text: string) => void;
};

export async function createPostgresPlannerDraft(db: SouthstarDb, input: CreatePostgresPlannerDraftInput): Promise<PostgresPlannerDraftResult> {
  const plannerRequest = plannerRequestSnapshot(input);
  input.onProgress?.({ stage: "request.normalized", message: "Planner draft request normalized." });
  const draftInput: CreatePostgresPlannerDraftInput = {
    ...plannerRequest,
    composer: input.composer,
    onProgress: input.onProgress,
    onLlmDelta: input.onLlmDelta,
  };
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

  const revisedGoalPrompt = buildPlannerDraftRevisionGoalPrompt({
    baseGoalPrompt,
    revisionPrompt: input.prompt,
    priorContext: priorPlannerDraftRevisionContext(input.draftId, draft.status, summary, payload),
  });
  const priorPlannerRequest = plannerRequestFromStored(summary.plannerRequest) ?? plannerRequestFromStored(payload.plannerRequest);
  const revisedDraft = await createPostgresPlannerDraft(db, {
    ...preservedPlannerRequestFields(priorPlannerRequest),
    goalPrompt: revisedGoalPrompt,
    orchestrationMode: input.orchestrationMode ?? priorPlannerRequest?.orchestrationMode ?? inferDraftOrchestrationMode(summary),
    composerMode: input.composerMode ?? priorPlannerRequest?.composerMode ?? inferDraftComposerMode(payload),
    composer: input.composer,
    onProgress: input.onProgress,
    onLlmDelta: input.onLlmDelta,
  });
  const preservedOverrides = profileOverridesByTaskId(workflow.tasks);
  if (preservedOverrides.size === 0) return revisedDraft;
  return await applyProfileOverridesToPlannerDraft(db, {
    draftId: revisedDraft.draftId,
    profileOverridesByTaskId: preservedOverrides,
  }) ?? revisedDraft;
}

export async function patchPostgresPlannerDraftTaskProfileOverride(
  db: SouthstarDb,
  input: PatchPlannerDraftTaskProfileOverrideInput,
): Promise<PatchPlannerDraftTaskProfileOverrideResult> {
  const result = await patchPlannerDraftTaskProfileOverridePg(db, input);
  await markPlannerDraftNeedsValidation(db, input.draftId);
  return { ...result, status: PLANNER_DRAFT_STATUS_NEEDS_VALIDATION };
}

export async function validatePostgresPlannerDraft(
  db: SouthstarDb,
  input: { draftId: string },
): Promise<PostgresPlannerDraftResult> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  const payload = asRecord(draft.payload);
  const summary = asRecord(draft.summary);
  const workflow = asWorkflowManifest(payload.workflow);
  const workflowId = stringValue(summary.workflowId) ?? workflow.workflowId ?? "";
  const goalPrompt = stringValue(summary.goalPrompt) ?? workflow.goalPrompt ?? "";
  const refreshed = await refreshPlannerDraftCompilation(db, {
    draftId: input.draftId,
    goalPrompt,
    payload,
    workflow,
  });
  const issues = [
    ...refreshed.issues,
    ...validatePlannerDraftWorkflow(refreshed.workflow),
  ];
  const status = issues.length === 0 ? PLANNER_DRAFT_STATUS_VALIDATED : PLANNER_DRAFT_STATUS_INVALID;
  const taskSummaries = summarizeWorkflowTasksFromPayload(refreshed.workflow.tasks);
  const orchestrationSnapshot = refreshDraftValidationSnapshot(refreshed.orchestrationSnapshot, issues);

  await upsertRuntimeResourcePg(db, {
    id: draft.id,
    resourceType: "planner_draft",
    resourceKey: input.draftId,
    ...(draft.runId ? { runId: draft.runId } : {}),
    ...(draft.taskId ? { taskId: draft.taskId } : {}),
    ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
    scope: draft.scope,
    status,
    ...(draft.title ? { title: draft.title } : {}),
    payload: {
      ...payload,
      workflow: refreshed.workflow,
      validationIssues: issues,
      orchestrationSnapshot,
    },
    summary: {
      ...summary,
      status,
      validationIssues: issues,
      taskSummaries,
      workflowId,
      goalPrompt,
    },
    metrics: draft.metrics,
    ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}),
  });

  return {
    draftId: input.draftId,
    goalPrompt,
    workflowId,
    status,
    validationIssues: issues,
    taskSummaries,
  };
}

function buildPlannerDraftRevisionGoalPrompt(input: {
  baseGoalPrompt: string;
  revisionPrompt: string;
  priorContext: Record<string, unknown>;
}): string {
  return [
    input.baseGoalPrompt,
    "",
    "Prior planner draft context:",
    JSON.stringify(input.priorContext),
    "",
    "Revision request:",
    input.revisionPrompt,
  ].join("\n");
}

function priorPlannerDraftRevisionContext(
  draftId: string,
  status: string,
  summary: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const workflow = asRecord(payload.workflow);
  const workflowId = stringValue(summary.workflowId) ?? stringValue(workflow.workflowId) ?? "";
  const validationIssues = parseValidationIssues(summary.validationIssues);
  const taskSummaries = parseTaskSummaries(summary.taskSummaries).length > 0
    ? parseTaskSummaries(summary.taskSummaries)
    : summarizeWorkflowTasksFromPayload(workflow.tasks);
  return {
    draftId,
    workflowId,
    status,
    validationIssues,
    taskSummaries,
    ...(payload.orchestrationSnapshot !== undefined
      ? { orchestrationSnapshot: boundedJsonValue(payload.orchestrationSnapshot, 12_000) }
      : {}),
  };
}

function boundedJsonValue(value: unknown, maxChars: number): unknown {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return value;
  return {
    truncated: true,
    originalJsonChars: text.length,
    jsonPrefix: text.slice(0, maxChars),
  };
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
  input.onProgress?.({ stage: "draft.persisted", ok: true, issueCount: validationIssues.length, message: "Planner draft persisted." });
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
  input.onProgress?.({ stage: "library.seeded", message: "Software workflow library graph is ready." });
  const requirementSpec = analyzeRequirementDeterministically(input.goalPrompt);
  input.onProgress?.({ stage: "requirement.analyzed", message: "Requirement analysis completed." });
  input.onProgress?.({ stage: "candidate.resolving", message: "Resolving workflow library candidates." });
  const candidatePacket = await resolveWorkflowCandidates(db, {
    requirementSpec,
    scope: "software",
  });
  input.onProgress?.({ stage: "candidate.resolved", message: "Workflow library candidates resolved." });
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
    input.onProgress?.({ stage: "draft.persisted", ok: false, issueCount: validationIssues.length, message: "Invalid planner draft persisted." });
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
    onProgress: input.onProgress,
    onLlmDelta: input.onLlmDelta,
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
    input.onProgress?.({ stage: "draft.persisted", ok: false, issueCount: validationIssues.length, message: "Invalid planner draft persisted." });
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
  input.onProgress?.({ stage: "composition.compiling", message: "Compiling workflow composition." });
  const compiled = await compileWorkflowComposition(db, {
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    candidatePacket,
    composition,
  });
  input.onProgress?.({ stage: "composition.compiled", message: "Workflow composition compiled." });
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
  input.onProgress?.({ stage: "draft.persisted", ok: true, issueCount: validationIssues.length, message: "Planner draft persisted." });
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
  const workflow = materializeWorkflowTaskProfileOverrides(bundle.workflow);
  const runId = await allocateRunId(db, workflow.workflowId);
  const draftPayload = asRecord(draft.payload);
  const draftSummary = asRecord(draft.summary);
  const plannerRequest = plannerRequestFromStored(draftSummary.plannerRequest) ?? plannerRequestFromStored(draftPayload.plannerRequest);
  const cwd = plannerRequest?.cwd;

  await createWorkflowRunPg(db, {
    id: runId,
    status: "created",
    domain: workflow.domain,
    goalPrompt: workflow.goalPrompt,
    workflowManifestJson: JSON.stringify(workflow),
    executionProjectionJson: JSON.stringify({ executor: "pending" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({
      draftId: input.draftId,
      scope: workflow.domain,
      ...(cwd ? { cwd, projectRoot: cwd } : {}),
    }),
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
      snapshot: {
        roleRef: task.roleRef,
        agentProfileRef: task.agentProfileRef,
        ...((task as WorkflowTaskWithProfileOverride).profileOverride
          ? { profileOverride: (task as WorkflowTaskWithProfileOverride).profileOverride }
          : {}),
      },
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

async function markPlannerDraftNeedsValidation(db: SouthstarDb, draftId: string): Promise<PostgresPlannerDraftResult> {
  const draft = await getResourceByKeyPg(db, "planner_draft", draftId);
  if (!draft) throw new Error(`planner draft not found: ${draftId}`);
  const payload = asRecord(draft.payload);
  const summary = asRecord(draft.summary);
  const workflow = asWorkflowManifest(payload.workflow);
  const taskSummaries = summarizeWorkflowTasksFromPayload(workflow.tasks);
  const workflowId = stringValue(summary.workflowId) ?? workflow.workflowId ?? "";
  const goalPrompt = stringValue(summary.goalPrompt) ?? workflow.goalPrompt ?? "";
  const validationIssues = draftNeedsValidationIssues();

  await upsertRuntimeResourcePg(db, {
    id: draft.id,
    resourceType: "planner_draft",
    resourceKey: draftId,
    ...(draft.runId ? { runId: draft.runId } : {}),
    ...(draft.taskId ? { taskId: draft.taskId } : {}),
    ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
    scope: draft.scope,
    status: PLANNER_DRAFT_STATUS_NEEDS_VALIDATION,
    ...(draft.title ? { title: draft.title } : {}),
    payload: {
      ...payload,
      workflow,
      validationIssues,
      orchestrationSnapshot: refreshDraftValidationSnapshot(payload.orchestrationSnapshot, validationIssues),
    },
    summary: {
      ...summary,
      status: PLANNER_DRAFT_STATUS_NEEDS_VALIDATION,
      validationIssues,
      taskSummaries,
      workflowId,
      goalPrompt,
    },
    metrics: draft.metrics,
    ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}),
  });

  return {
    draftId,
    goalPrompt,
    workflowId,
    status: PLANNER_DRAFT_STATUS_NEEDS_VALIDATION,
    validationIssues,
    taskSummaries,
  };
}

async function applyProfileOverridesToPlannerDraft(
  db: SouthstarDb,
  input: { draftId: string; profileOverridesByTaskId: Map<string, PlannerDraftTaskProfileOverride> },
): Promise<PostgresPlannerDraftResult | null> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  const payload = asRecord(draft.payload);
  const workflow = asWorkflowManifest(payload.workflow);
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks.map((task) => ({ ...task } as WorkflowTaskWithProfileOverride)) : [];
  let applied = false;

  for (const task of tasks) {
    const override = input.profileOverridesByTaskId.get(task.id);
    if (!override) continue;
    task.profileOverride = cloneProfileOverride(override);
    if (override.skillRefs !== undefined) task.skillRefs = [...override.skillRefs];
    if (override.mcpGrantRefs !== undefined) task.mcpGrantRefs = [...override.mcpGrantRefs];
    applied = true;
  }

  if (!applied) return null;
  await upsertRuntimeResourcePg(db, {
    id: draft.id,
    resourceType: "planner_draft",
    resourceKey: input.draftId,
    ...(draft.runId ? { runId: draft.runId } : {}),
    ...(draft.taskId ? { taskId: draft.taskId } : {}),
    ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
    scope: draft.scope,
    status: draft.status,
    ...(draft.title ? { title: draft.title } : {}),
    payload: {
      ...payload,
      workflow: { ...workflow, tasks },
    },
    summary: draft.summary,
    metrics: draft.metrics,
    ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}),
  });
  return await markPlannerDraftNeedsValidation(db, input.draftId);
}

async function refreshPlannerDraftCompilation(
  db: SouthstarDb,
  input: {
    draftId: string;
    goalPrompt: string;
    payload: Record<string, unknown>;
    workflow: SouthstarWorkflowManifest;
  },
): Promise<{
  workflow: SouthstarWorkflowManifest;
  orchestrationSnapshot: unknown;
  issues: PlannerDraftValidationIssue[];
}> {
  const candidatePacket = maybeCandidatePacket(input.payload.candidatePacket);
  const currentSnapshot = input.payload.orchestrationSnapshot;
  const composition = maybeWorkflowCompositionPlan(asRecord(currentSnapshot).selectedCompositionPlan);
  if (!candidatePacket || !composition) {
    return { workflow: input.workflow, orchestrationSnapshot: currentSnapshot, issues: [] };
  }

  try {
    const compiled = await compileWorkflowComposition(db, {
      runId: input.draftId,
      goalPrompt: input.goalPrompt,
      candidatePacket,
      composition: applyWorkflowTaskSelectionsToComposition(composition, input.workflow),
    });
    return {
      workflow: copyProfileOverridesToWorkflow(compiled.workflow, input.workflow),
      orchestrationSnapshot: compiled.orchestrationSnapshot,
      issues: [],
    };
  } catch (error) {
    return {
      workflow: input.workflow,
      orchestrationSnapshot: currentSnapshot,
      issues: [{
        path: "orchestrationSnapshot.selectedCompositionPlan",
        code: "composition_compile_failed",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

function applyWorkflowTaskSelectionsToComposition(
  composition: WorkflowCompositionPlan,
  workflow: SouthstarWorkflowManifest,
): WorkflowCompositionPlan {
  const workflowTasksById = new Map(workflow.tasks.map((task) => [task.id, task]));
  return {
    ...composition,
    tasks: composition.tasks.map((task) => {
      const workflowTask = workflowTasksById.get(task.id);
      if (!workflowTask) return task;
      return {
        ...task,
        agentProfileRef: workflowTask.agentProfileRef || task.agentProfileRef,
        instructionRefs: workflowTask.instructionRefs?.length ? [...workflowTask.instructionRefs] : task.instructionRefs,
        skillRefs: [...(workflowTask.skillRefs ?? task.skillRefs)],
        toolGrantRefs: [...(workflowTask.toolGrantRefs ?? task.toolGrantRefs)],
        mcpGrantRefs: [...(workflowTask.mcpGrantRefs ?? task.mcpGrantRefs)],
        vaultLeasePolicyRefs: [...(workflowTask.vaultLeasePolicyRefs ?? task.vaultLeasePolicyRefs)],
      };
    }),
  };
}

function copyProfileOverridesToWorkflow(
  target: SouthstarWorkflowManifest,
  source: SouthstarWorkflowManifest,
): SouthstarWorkflowManifest {
  const overrides = profileOverridesByTaskId(source.tasks);
  if (overrides.size === 0) return target;
  return {
    ...target,
    tasks: target.tasks.map((task) => {
      const override = overrides.get(task.id);
      if (!override) return task;
      return {
        ...task,
        profileOverride: cloneProfileOverride(override),
        ...(override.skillRefs !== undefined ? { skillRefs: [...override.skillRefs] } : {}),
        ...(override.mcpGrantRefs !== undefined ? { mcpGrantRefs: [...override.mcpGrantRefs] } : {}),
      } as WorkflowTaskWithProfileOverride;
    }),
  };
}

function validatePlannerDraftWorkflow(workflow: SouthstarWorkflowManifest): PlannerDraftValidationIssue[] {
  const validation = validateWorkflowManifest(workflow);
  const materializedValidation = validateWorkflowManifest(materializeWorkflowTaskProfileOverrides(workflow));
  return [
    ...validation.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    ...materializedValidation.issues.map((issue) => ({
      path: `materialized.${issue.path}`,
      message: issue.message,
    })),
  ];
}

function refreshDraftValidationSnapshot(snapshot: unknown, issues: PlannerDraftValidationIssue[]): unknown {
  const record = asRecord(snapshot);
  if (Object.keys(record).length === 0) {
    return {
      schemaVersion: "southstar.draft_validation_snapshot.v1",
      validation: { ok: issues.length === 0, issues },
    };
  }
  return {
    ...record,
    validation: { ok: issues.length === 0, issues },
  };
}

function draftNeedsValidationIssues(): PlannerDraftValidationIssue[] {
  return [
    {
      path: "plannerDraft.status",
      code: "draft_needs_validation",
      message: "planner draft changed after validation and must be validated before run creation",
    },
  ];
}

function profileOverridesByTaskId(tasksValue: unknown): Map<string, PlannerDraftTaskProfileOverride> {
  const overrides = new Map<string, PlannerDraftTaskProfileOverride>();
  if (!Array.isArray(tasksValue)) return overrides;
  for (const task of tasksValue) {
    if (!isRecord(task)) continue;
    const taskId = stringValue(task.id);
    const override = asRecord(task.profileOverride);
    if (!taskId || Object.keys(override).length === 0) continue;
    overrides.set(taskId, cloneProfileOverride(override as PlannerDraftTaskProfileOverride));
  }
  return overrides;
}

function cloneProfileOverride(input: PlannerDraftTaskProfileOverride): PlannerDraftTaskProfileOverride {
  return {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    ...(input.skillRefs !== undefined ? { skillRefs: [...input.skillRefs] } : {}),
    ...(input.mcpGrantRefs !== undefined ? { mcpGrantRefs: [...input.mcpGrantRefs] } : {}),
  };
}

function asWorkflowManifest(value: unknown): SouthstarWorkflowManifest {
  return asRecord(value) as SouthstarWorkflowManifest;
}

function maybeCandidatePacket(value: unknown): CandidatePacket | null {
  const record = asRecord(value);
  if (!record.requirementSpec) return null;
  if (!Array.isArray(record.workflowTemplateCandidates)) return null;
  return record as CandidatePacket;
}

function maybeWorkflowCompositionPlan(value: unknown): WorkflowCompositionPlan | null {
  const record = asRecord(value);
  if (record.schemaVersion !== "southstar.workflow_composition_plan.v1") return null;
  if (!Array.isArray(record.tasks)) return null;
  return record as WorkflowCompositionPlan;
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
    inlineInstruction: profileOverrideInstruction(task),
  });
}

type WorkflowTaskWithProfileOverride = SouthstarWorkflowManifest["tasks"][number] & {
  profileOverride?: PlannerDraftTaskProfileOverride;
};

function materializeWorkflowTaskProfileOverrides(workflow: SouthstarWorkflowManifest): SouthstarWorkflowManifest {
  const agentProfiles = (workflow.agentProfiles ?? softwareDomainPack.agentProfiles).map(cloneAgentProfile);
  const tasks = workflow.tasks.map((task) => ({ ...task } as WorkflowTaskWithProfileOverride));
  const profileById = new Map(agentProfiles.map((profile) => [profile.id, profile]));
  const outputProfiles = [...agentProfiles];

  for (const task of tasks) {
    const override = task.profileOverride;
    if (!override || Object.keys(override).length === 0) continue;
    if (!task.agentProfileRef) continue;

    const baseProfile = profileById.get(task.agentProfileRef);
    if (!baseProfile) continue;

    const overrideProfileId = `${baseProfile.id}__${task.id}__override`;
    const overrideProfile: AgentProfile = {
      ...cloneAgentProfile(baseProfile),
      id: overrideProfileId,
      name: `${baseProfile.name} (${task.name || task.id})`,
      ...(override.provider !== undefined ? { provider: override.provider } : {}),
      ...(override.model !== undefined ? { model: override.model } : {}),
      ...(override.thinkingLevel !== undefined ? { thinkingLevel: override.thinkingLevel } : {}),
      ...(override.instruction !== undefined ? { instruction: override.instruction } : {}),
      ...(override.skillRefs !== undefined ? { skillRefs: [...override.skillRefs] } : {}),
      ...(override.mcpGrantRefs !== undefined ? { mcpGrantRefs: [...override.mcpGrantRefs] } : {}),
    };

    outputProfiles.push(overrideProfile);
    profileById.set(overrideProfile.id, overrideProfile);
    task.agentProfileRef = overrideProfile.id;
    if (override.skillRefs !== undefined) task.skillRefs = [...override.skillRefs];
    if (override.mcpGrantRefs !== undefined) task.mcpGrantRefs = [...override.mcpGrantRefs];
  }

  return {
    ...workflow,
    agentProfiles: outputProfiles,
    tasks,
  };
}

function cloneAgentProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    agentsMdRefs: [...profile.agentsMdRefs],
    skillRefs: [...profile.skillRefs],
    mcpGrantRefs: [...profile.mcpGrantRefs],
    memoryScopes: [...profile.memoryScopes],
    toolPolicy: {
      allowedTools: [...profile.toolPolicy.allowedTools],
      deniedTools: [...profile.toolPolicy.deniedTools],
      requiresApprovalFor: [...profile.toolPolicy.requiresApprovalFor],
    },
    budgetPolicy: { ...profile.budgetPolicy },
  };
}

function profileOverrideInstruction(task: SouthstarWorkflowManifest["tasks"][number]): string | undefined {
  const profileOverride = (task as WorkflowTaskWithProfileOverride).profileOverride;
  return profileOverride?.instruction;
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
