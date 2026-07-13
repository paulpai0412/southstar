import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type {
  CandidatePacket,
  RequirementSpecV2,
  WorkflowCompositionPlan,
  WorkflowCompositionValidationIssue,
} from "../design-library/types.ts";
import type { PlanBundle, SouthstarWorkflowManifest } from "../manifests/types.ts";
import { validateWorkflowManifest } from "../manifests/validate.ts";
import type { AgentProfile, PlannerDraftTaskProfileOverride } from "../design-library/runtime-types.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import { resolveWorkflowCandidates } from "../orchestration/candidate-resolver.ts";
import { compileWorkflowComposition, type CompiledWorkflowComposition } from "../orchestration/composition-compiler.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { createWorkflowComposerRegistry, type WorkflowComposerMode } from "../orchestration/composer-registry.ts";
import { runCompositionRepairLoop } from "../orchestration/composition-repair-loop.ts";
import { parseWorkflowCompositionPlanFromText } from "../orchestration/llm-composer.ts";
import {
  finalizeGoalContract,
  GoalContractVocabularyGapError,
  goalContractHash,
  requirementSpecFromGoalContract,
  type GoalContractInterpreter,
  type GoalContractVocabularyGapV1,
  type GoalContractV1,
} from "../orchestration/goal-contract.ts";
import { validateGoalDesignPackage, type GoalDesignPackageV1 } from "../orchestration/goal-design.ts";
import type { GoalRequirementDraftV1 } from "../orchestration/goal-requirement-draft.ts";
import { captureRunLibrarySnapshotPg } from "../orchestration/run-library-snapshot.ts";
import {
  appendHistoryEventPg,
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import {
  patchPlannerDraftTaskProfileOverridePg,
  type PatchPlannerDraftTaskProfileOverrideInput,
  type PatchPlannerDraftTaskProfileOverrideResult,
} from "./planner-draft-task-overrides.ts";
import { assertWorkspaceMountAllowed } from "../workspace/workspace-mount-policy.ts";

export type {
  PatchPlannerDraftTaskProfileOverrideInput,
  PatchPlannerDraftTaskProfileOverrideResult,
} from "./planner-draft-task-overrides.ts";

const PLANNER_DRAFT_STATUS_VALIDATED = "validated";
const PLANNER_DRAFT_STATUS_INVALID = "invalid";
const PLANNER_DRAFT_STATUS_NEEDS_VALIDATION = "needs_validation";
const PLANNER_DRAFT_STATUS_NEEDS_INPUT = "needs_input";
const PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT = "needs_library_input";
const PLANNER_DRAFT_STATUS_READY_FOR_REVIEW = "ready_for_review";
const PLANNER_DRAFT_STATUS_TEMPLATE_INCOMPATIBLE = "template_incompatible";
const PLANNER_DRAFT_STATUS_REQUIREMENTS_REVIEW = "requirements_review";
const PLANNER_DRAFT_STATUS_VALIDATION_RESOLVING = "validation_resolving";
const PLANNER_DRAFT_STATUS_LIBRARY_REVIEW = "library_review";
const PLANNER_DRAFT_STATUS_VALIDATION_READY = "validation_ready";

export type PostgresPlannerDraftStatus =
  | typeof PLANNER_DRAFT_STATUS_NEEDS_INPUT
  | typeof PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT
  | typeof PLANNER_DRAFT_STATUS_INVALID
  | typeof PLANNER_DRAFT_STATUS_NEEDS_VALIDATION
  | typeof PLANNER_DRAFT_STATUS_READY_FOR_REVIEW
  | typeof PLANNER_DRAFT_STATUS_TEMPLATE_INCOMPATIBLE
  | typeof PLANNER_DRAFT_STATUS_VALIDATED
  | typeof PLANNER_DRAFT_STATUS_REQUIREMENTS_REVIEW
  | typeof PLANNER_DRAFT_STATUS_VALIDATION_RESOLVING
  | typeof PLANNER_DRAFT_STATUS_LIBRARY_REVIEW
  | typeof PLANNER_DRAFT_STATUS_VALIDATION_READY;

export type PostgresPlannerDraftResult = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
  status: PostgresPlannerDraftStatus;
  goalContractHash: string;
  goalRequirementDraftHash?: string;
  goalDesignPhase?: string;
  goalRequirementDraft?: GoalRequirementDraftV1;
  goalDesignPackageHash?: string;
  goalDesignPackage?: GoalDesignPackageV1;
  blockers: string[];
  validationIssues: PlannerDraftValidationIssue[];
  taskSummaries: PlannerDraftTaskSummary[];
  vocabularyGaps?: GoalContractVocabularyGapV1[];
  libraryImportDraftId?: string;
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
  orchestrationMode?: "llm-constrained";
  composerMode?: WorkflowComposerMode;
  cwd?: string;
  compositionPlan?: WorkflowCompositionPlan;
  libraryHints?: PlannerDraftLibraryHints;
};

export type PlannerDraftProgressEvent = {
  stage: string;
  message: string;
  attempt?: number;
  ok?: boolean;
  issueCount?: number;
  draftId?: string;
  draftStatus?: string;
  goalDesignPackageHash?: string;
  package?: unknown;
};

export type PlannerDraftProgressListener = (event: PlannerDraftProgressEvent) => void;
export type PlannerDraftPersistence = (resource: Parameters<typeof upsertRuntimeResourcePg>[1]) => Promise<void>;

export type CreatePostgresPlannerDraftInput = PlannerDraftRequestContract & {
  goalInterpreter: GoalContractInterpreter;
  goalDesignPackage?: GoalDesignPackageV1;
  composer?: WorkflowComposer;
  onProgress?: PlannerDraftProgressListener;
  onGoalContractDelta?: (text: string) => void;
  onLlmDelta?: (text: string) => void;
  persistDraft?: PlannerDraftPersistence;
};

export type RevisePostgresPlannerDraftInput = {
  draftId: string;
  prompt: string;
  orchestrationMode?: "llm-constrained";
  composerMode?: WorkflowComposerMode;
  goalInterpreter: GoalContractInterpreter;
  composer?: WorkflowComposer;
  onProgress?: PlannerDraftProgressListener;
  onGoalContractDelta?: (text: string) => void;
  onLlmDelta?: (text: string) => void;
};

type InterpretedPlannerDraftInput = CreatePostgresPlannerDraftInput & {
  goalContract: GoalContractV1;
  goalContractHash: string;
};

export async function createPostgresPlannerDraft(db: SouthstarDb, input: CreatePostgresPlannerDraftInput): Promise<PostgresPlannerDraftResult> {
  const plannerRequest = plannerRequestSnapshot(input);
  input.onProgress?.({ stage: "request.normalized", message: "Planner draft request normalized." });
  const libraryVocabulary = await loadGoalContractLibraryVocabularyPg(db);
  let goalContract: GoalContractV1;
  try {
    goalContract = await input.goalInterpreter.interpret({
      goalPrompt: plannerRequest.goalPrompt,
      cwd: plannerRequest.cwd ?? process.cwd(),
      libraryVocabulary,
      onDelta: input.onGoalContractDelta,
    });
  } catch (error) {
    if (error instanceof GoalContractVocabularyGapError) {
      return await persistGoalContractVocabularyGapDraftPg(db, {
        plannerRequest,
        error,
        onProgress: input.onProgress,
        persistDraft: input.persistDraft,
      });
    }
    throw error;
  }
  const contractHash = goalContractHash(goalContract);
  input.onProgress?.({ stage: "goal_contract.interpreted", message: "Goal Contract interpreted." });
  if (goalContract.blockingInputs.length > 0) {
    return persistNeedsInputPlannerDraft(db, plannerRequest, goalContract, contractHash, input.onProgress, input.persistDraft);
  }
  const draftInput: InterpretedPlannerDraftInput = {
    ...plannerRequest,
    goalInterpreter: input.goalInterpreter,
    goalDesignPackage: input.goalDesignPackage,
    goalContract,
    goalContractHash: contractHash,
    composer: input.composer,
    onProgress: input.onProgress,
    onGoalContractDelta: input.onGoalContractDelta,
    onLlmDelta: input.onLlmDelta,
    persistDraft: input.persistDraft,
  };
  if (plannerRequest.compositionPlan) {
    return createPlannerDraftFromComposition(db, draftInput, plannerRequest.compositionPlan);
  }
  return createLibraryConstrainedPlannerDraft(db, draftInput);
}

export async function persistGoalContractVocabularyGapDraftPg(
  db: SouthstarDb,
  input: {
    plannerRequest: PlannerDraftRequestContract & Record<string, unknown>;
    error: GoalContractVocabularyGapError;
    libraryImportDraftId?: string;
    onProgress?: PlannerDraftProgressListener;
    persistDraft?: PlannerDraftPersistence;
  },
): Promise<PostgresPlannerDraftResult> {
  const goalContract = input.error.goalContract;
  const contractHash = goalContractHash(goalContract);
  const draftId = `draft-goal-${contractHash.slice(0, 12)}`;
  const blockers = input.error.gaps.map((gap) => `Approve Library ${gap.kind}: ${gap.requestedRef}`);
  await persistPlannerDraft(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT,
    title: "Planner Draft Needs Library Input",
    payload: {
      goalContract,
      goalContractHash: contractHash,
      plannerRequest: input.plannerRequest,
      vocabularyGaps: input.error.gaps,
      ...(input.libraryImportDraftId ? { libraryImportDraftId: input.libraryImportDraftId } : {}),
    },
    summary: {
      goalPrompt: input.plannerRequest.goalPrompt,
      workflowId: "",
      planner: "goal-contract-interpreter",
      status: PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT,
      blockers,
      vocabularyGaps: input.error.gaps,
      ...(input.libraryImportDraftId ? { libraryImportDraftId: input.libraryImportDraftId } : {}),
      validationIssues: [],
      taskSummaries: [],
      plannerRequest: input.plannerRequest,
      ...goalContractSummary(goalContract, contractHash),
    },
  }, input.persistDraft);
  input.onProgress?.({
    stage: "draft.needs_library_input",
    ok: false,
    issueCount: input.error.gaps.length,
    message: "Planner draft needs approved Library vocabulary.",
    draftId,
    draftStatus: PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT,
  });
  return {
    draftId,
    goalPrompt: input.plannerRequest.goalPrompt,
    workflowId: "",
    status: PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT,
    goalContractHash: contractHash,
    blockers,
    validationIssues: [],
    taskSummaries: [],
    vocabularyGaps: input.error.gaps,
    ...(input.libraryImportDraftId ? { libraryImportDraftId: input.libraryImportDraftId } : {}),
  };
}

export async function loadGoalContractLibraryVocabularyPg(db: SouthstarDb): Promise<{
  scopes: string[];
  capabilityRefs: string[];
  artifactRefs: string[];
  evaluatorRefs: string[];
}> {
  const result = await db.query<{ object_key: string; object_kind: string; scope: string | null }>(
    `select object_key, object_kind, nullif(state_json->>'scope', '') as scope
      from southstar.library_objects
      where status = 'approved'
        and object_kind in ('domain_taxonomy', 'capability_spec', 'artifact_contract', 'evaluator_profile')
      order by object_key`,
  );
  return {
    scopes: [...new Set(result.rows.flatMap((row) => row.object_kind === "domain_taxonomy" && row.scope ? [row.scope] : []))].sort(),
    capabilityRefs: result.rows.filter((row) => row.object_kind === "capability_spec").map((row) => row.object_key).sort(),
    artifactRefs: result.rows.filter((row) => row.object_kind === "artifact_contract").map((row) => row.object_key).sort(),
    evaluatorRefs: result.rows.filter((row) => row.object_kind === "evaluator_profile").map((row) => row.object_key).sort(),
  };
}

async function persistPlannerDraft(
  db: SouthstarDb,
  resource: Parameters<typeof upsertRuntimeResourcePg>[1],
  persist?: PlannerDraftPersistence,
): Promise<void> {
  if (persist) return await persist(resource);
  await upsertRuntimeResourcePg(db, resource);
}

async function persistNeedsInputPlannerDraft(
  db: SouthstarDb,
  plannerRequest: PlannerDraftRequestContract,
  goalContract: GoalContractV1,
  contractHash: string,
  onProgress?: PlannerDraftProgressListener,
  persistDraft?: PlannerDraftPersistence,
): Promise<PostgresPlannerDraftResult> {
  const draftId = `draft-goal-${contractHash.slice(0, 12)}`;
  const status = PLANNER_DRAFT_STATUS_NEEDS_INPUT;
  const blockers = [...goalContract.blockingInputs];
  await persistPlannerDraft(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status,
    title: "Planner Draft Needs Input",
    payload: {
      goalContract,
      goalContractHash: contractHash,
      plannerRequest,
    },
    summary: {
      goalPrompt: plannerRequest.goalPrompt,
      workflowId: "",
      planner: "goal-contract-interpreter",
      status,
      validationIssues: [],
      taskSummaries: [],
      plannerRequest,
      ...goalContractSummary(goalContract, contractHash),
    },
  }, persistDraft);
  onProgress?.({ stage: "draft.persisted", ok: false, issueCount: blockers.length, message: "Planner draft needs input." });
  return {
    draftId,
    goalPrompt: plannerRequest.goalPrompt,
    workflowId: "",
    status,
    goalContractHash: contractHash,
    blockers,
    validationIssues: [],
    taskSummaries: [],
  };
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
  const previousContract = storedOrLegacyGoalContract(payload, summary, input.draftId);
  const baseGoalPrompt = previousContract.originalPrompt;
  const priorPlannerRequest = plannerRequestFromStored(summary.plannerRequest) ?? plannerRequestFromStored(payload.plannerRequest);
  const revisedDraft = await createPostgresPlannerDraft(db, {
    ...preservedPlannerRequestFields(priorPlannerRequest),
    goalPrompt: baseGoalPrompt,
    cwd: priorPlannerRequest?.cwd ?? previousContract.workspace.cwd,
    orchestrationMode: input.orchestrationMode ?? priorPlannerRequest?.orchestrationMode ?? inferDraftOrchestrationMode(summary),
    composerMode: input.composerMode ?? priorPlannerRequest?.composerMode ?? inferDraftComposerMode(payload),
    goalInterpreter: {
      interpret: (interpreterInput) => input.goalInterpreter.interpret({
        ...interpreterInput,
        previousContract,
        revisionPrompt: input.prompt,
      }),
    },
    composer: input.composer,
    onProgress: input.onProgress,
    onGoalContractDelta: input.onGoalContractDelta,
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
  const contract = storedOrLegacyGoalContract(payload, summary, input.draftId);
  const contractHash = storedGoalContractHash(summary, payload, contract);
  if (
    draft.status === PLANNER_DRAFT_STATUS_NEEDS_INPUT
    || draft.status === PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT
    || contract.blockingInputs.length > 0
  ) {
    const workflow = asRecord(payload.workflow);
    const workflowId = stringValue(summary.workflowId) ?? stringValue(workflow.workflowId) ?? "";
    const validationIssues = parseValidationIssues(summary.validationIssues);
    const taskSummaries = parseTaskSummaries(summary.taskSummaries).length > 0
      ? parseTaskSummaries(summary.taskSummaries)
      : summarizeWorkflowTasksFromPayload(workflow.tasks);
    const storedContract = goalContractFromStored(payload.goalContract);
    const canonicalHash = goalContractHash(contract);
    const blockedStatus = draft.status === PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT
      ? PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT
      : PLANNER_DRAFT_STATUS_NEEDS_INPUT;
    if (
      draft.status !== blockedStatus
      || !storedContract
      || stringValue(payload.goalContractHash) !== canonicalHash
      || stringValue(summary.goalContractHash) !== canonicalHash
    ) {
      await upsertRuntimeResourcePg(db, {
        id: draft.id,
        resourceType: "planner_draft",
        resourceKey: input.draftId,
        ...(draft.runId ? { runId: draft.runId } : {}),
        ...(draft.taskId ? { taskId: draft.taskId } : {}),
        ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
        scope: draft.scope,
        status: blockedStatus,
        ...(draft.title ? { title: draft.title } : {}),
        payload: { ...payload, goalContract: contract, goalContractHash: canonicalHash },
        summary: {
          ...summary,
          status: blockedStatus,
          workflowId,
          goalPrompt: contract.originalPrompt,
          validationIssues,
          taskSummaries,
          ...goalContractSummary(contract, canonicalHash),
        },
        metrics: draft.metrics,
        ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}),
      });
    }
    return {
      draftId: input.draftId,
      goalPrompt: contract.originalPrompt,
      workflowId,
      status: blockedStatus,
      goalContractHash: canonicalHash,
      blockers: blockedStatus === PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT
        ? parseVocabularyGapBlockers(payload.vocabularyGaps)
        : [...contract.blockingInputs],
      validationIssues,
      taskSummaries,
    };
  }
  const workflow = asWorkflowManifest(payload.workflow);
  const canonicalPayload = { ...payload, goalContract: contract, goalContractHash: contractHash };
  const workflowId = stringValue(summary.workflowId) ?? workflow.workflowId ?? "";
  const goalPrompt = stringValue(summary.goalPrompt) ?? workflow.goalPrompt ?? "";
  const refreshed = await refreshPlannerDraftCompilation(db, {
    draftId: input.draftId,
    goalPrompt,
    payload: canonicalPayload,
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
      ...canonicalPayload,
      workflow: refreshed.workflow,
      validationIssues: issues,
      orchestrationSnapshot,
      goalRequirementCoverage: refreshed.goalRequirementCoverage,
    },
    summary: {
      ...summary,
      status,
      validationIssues: issues,
      taskSummaries,
      workflowId,
      goalPrompt,
      ...goalContractSummary(contract, contractHash),
    },
    metrics: draft.metrics,
    ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}),
  });

  return {
    draftId: input.draftId,
    goalPrompt,
    workflowId,
    status,
    goalContractHash: contractHash,
    blockers: [...contract.blockingInputs],
    validationIssues: issues,
    taskSummaries,
  };
}

function preservedPlannerRequestFields(input: PlannerDraftRequestContract | undefined): Partial<PlannerDraftRequestContract> {
  if (!input) return {};
  return {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.libraryHints !== undefined ? { libraryHints: plannerLibraryHintsSnapshot(input.libraryHints) } : {}),
  };
}

function plannerRequestSnapshot(input: PlannerDraftRequestContract): PlannerDraftRequestContract {
  const snapshot: PlannerDraftRequestContract = {
    goalPrompt: input.goalPrompt,
    ...(input.orchestrationMode !== undefined ? { orchestrationMode: input.orchestrationMode } : {}),
    ...(input.composerMode !== undefined ? { composerMode: input.composerMode } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.compositionPlan !== undefined ? { compositionPlan: input.compositionPlan } : {}),
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
  return value === "llm-constrained" ? value : undefined;
}

function plannerRequestComposerMode(value: unknown): WorkflowComposerMode | undefined {
  return value === "llm" ? value : undefined;
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

async function createPlannerDraftFromComposition(
  db: SouthstarDb,
  input: InterpretedPlannerDraftInput,
  composition: WorkflowCompositionPlan,
): Promise<PostgresPlannerDraftResult> {
  const draftRunId = `draft-composition-${hash(`${JSON.stringify(composition)}:${input.goalContractHash}`).slice(0, 12)}`;
  const requirementSpec = requirementSpecFromGoalContract(input.goalContract);
  input.onProgress?.({ stage: "candidate.resolving", message: "Resolving workflow library candidates." });
  const candidatePacket = await resolveWorkflowCandidates(db, {
    requirementSpec,
    scope: input.goalContract.domain,
    templatePolicy: input.goalDesignPackage?.templatePolicy,
  });
  input.onProgress?.({ stage: "candidate.resolved", message: "Workflow library candidates resolved." });
  input.onProgress?.({ stage: "composition.compiling", message: "Compiling existing workflow composition." });
  const compiled = await compileWorkflowComposition(db, {
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    goalContract: input.goalContract,
    candidatePacket,
    composition,
    goalDesignPackage: input.goalDesignPackage,
    scope: input.goalContract.domain,
    manifestDomain: input.goalContract.domain,
  });
  input.onProgress?.({ stage: "composition.compiled", message: "Existing workflow composition compiled." });

  const workflowId = compiled.workflow.workflowId;
  const draftId = `draft-${workflowId}`;
  const validationIssues = toPlannerDraftValidationIssues(compiled.orchestrationSnapshot.validation.issues);
  const taskSummaries = summarizeWorkflowTasks(compiled.workflow);
  const status = validationIssues.length === 0 ? "validated" : "invalid";
  const bundle: PlanBundle & {
    orchestrationSnapshot: CompiledWorkflowComposition["orchestrationSnapshot"];
    goalRequirementCoverage: CompiledWorkflowComposition["goalRequirementCoverage"];
    plannerRequest: PlannerDraftRequestContract;
    goalContract: GoalContractV1;
    goalContractHash: string;
  } = {
    workflow: compiled.workflow,
    goalRequirementCoverage: compiled.goalRequirementCoverage,
    goalContract: input.goalContract,
    goalContractHash: input.goalContractHash,
    ...(input.goalDesignPackage
      ? {
          goalDesignPackage: input.goalDesignPackage,
          goalDesignPackageHash: input.goalDesignPackage.packageHash,
        }
      : {}),
    plannerTrace: {
      model: "southstar-existing-composition-compiler",
      promptHash: hash(input.goalPrompt),
      generatedAt: new Date().toISOString(),
      analyzerType: "goal-contract-v1",
      composerMode: "existing-composition",
      composerFallbackUsed: false,
      validatorAttempts: 1,
      repairAttempts: 0,
      finalValidationOk: status === "validated",
      candidatePacketHash: compiled.orchestrationSnapshot.candidatePacketHash,
      compositionHash: hash(JSON.stringify(composition)),
    },
    orchestrationSnapshot: compiled.orchestrationSnapshot,
    plannerRequest: plannerRequestSnapshot(input),
  };

  await persistPlannerDraft(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status,
    title: compiled.workflow.title,
    payload: bundle,
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId,
      planner: "existing-composition-compiler",
      status,
      validationIssues,
      taskSummaries,
      plannerRequest: plannerRequestSnapshot(input),
      ...goalContractSummary(input.goalContract, input.goalContractHash),
    },
  }, input.persistDraft);
  input.onProgress?.({ stage: "draft.persisted", ok: status === "validated", issueCount: validationIssues.length, message: "Planner draft persisted from existing DAG." });
  return {
    draftId,
    goalPrompt: input.goalPrompt,
    workflowId,
    status,
    goalContractHash: input.goalContractHash,
    blockers: [...input.goalContract.blockingInputs],
    validationIssues,
    taskSummaries,
  };
}

async function createLibraryConstrainedPlannerDraft(
  db: SouthstarDb,
  input: InterpretedPlannerDraftInput,
): Promise<PostgresPlannerDraftResult> {
  const draftRunId = `draft-library-${hash(`${input.goalPrompt}:${input.goalContractHash}`).slice(0, 12)}`;
  const requirementSpec = requirementSpecFromGoalContract(input.goalContract);
  input.onProgress?.({ stage: "candidate.resolving", message: "Resolving workflow library candidates." });
  const candidatePacket = await resolveWorkflowCandidates(db, {
    requirementSpec,
    scope: input.goalContract.domain,
    templatePolicy: input.goalDesignPackage?.templatePolicy,
  });
  input.onProgress?.({ stage: "candidate.resolved", message: "Workflow library candidates resolved." });
  const workflowId = `wf-composed-${hash(draftRunId).slice(0, 12)}`;
  const draftId = `draft-${workflowId}`;

  if (candidatePacket.unavailableRequirements.length > 0 && !hasGraphMetadataCandidates(candidatePacket)) {
    const validationIssues = unavailableRequirementIssues(candidatePacket.unavailableRequirements);
    const status = "invalid";
    const taskSummaries: PlannerDraftTaskSummary[] = [];
    await persistPlannerDraft(db, {
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
        goalContract: input.goalContract,
        goalContractHash: input.goalContractHash,
      },
      summary: {
        goalPrompt: input.goalPrompt,
        workflowId,
        planner: "library-constrained-llm",
        status,
        validationIssues,
        taskSummaries,
        plannerRequest: plannerRequestSnapshot(input),
        ...goalContractSummary(input.goalContract, input.goalContractHash),
      },
    }, input.persistDraft);
    input.onProgress?.({ stage: "draft.persisted", ok: false, issueCount: validationIssues.length, message: "Invalid planner draft persisted." });
    return {
      draftId,
      goalPrompt: input.goalPrompt,
      workflowId,
      status,
      goalContractHash: input.goalContractHash,
      blockers: [...input.goalContract.blockingInputs],
      validationIssues,
      taskSummaries,
    };
  }

  const registry = createWorkflowComposerRegistry({ llmComposer: input.composer });
  const composerMode = input.composerMode ?? "llm";
  const composer = registry.resolve({ composerMode });
  const repairResult = await runCompositionRepairLoop({
    db,
    goalPrompt: input.goalPrompt,
    goalContract: input.goalContract,
    goalDesignPackage: input.goalDesignPackage,
    candidatePacket,
    composer,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    scope: input.goalContract.domain,
    maxRepairAttempts: 2,
    onProgress: input.onProgress,
    onLlmDelta: input.onLlmDelta,
  });
  if (!repairResult.validation.ok) {
    const validationIssues = toPlannerDraftValidationIssues(repairResult.validation.issues);
    const status = input.goalDesignPackage?.templatePolicy.mode === "require"
      ? PLANNER_DRAFT_STATUS_TEMPLATE_INCOMPATIBLE
      : "invalid";
    const taskSummaries: PlannerDraftTaskSummary[] = [];
    await persistPlannerDraft(db, {
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
        goalContract: input.goalContract,
        goalContractHash: input.goalContractHash,
      },
      summary: {
        goalPrompt: input.goalPrompt,
        workflowId,
        planner: "library-constrained-llm",
        status,
        validationIssues,
        taskSummaries,
        plannerRequest: plannerRequestSnapshot(input),
        ...goalContractSummary(input.goalContract, input.goalContractHash),
      },
    }, input.persistDraft);
    input.onProgress?.({ stage: "draft.persisted", ok: false, issueCount: validationIssues.length, message: "Invalid planner draft persisted." });
    return {
      draftId,
      goalPrompt: input.goalPrompt,
      workflowId,
      status,
      goalContractHash: input.goalContractHash,
      blockers: [...input.goalContract.blockingInputs],
      validationIssues,
      taskSummaries,
    };
  }
  const composition = repairResult.composition;
  if (!composition) {
    throw new Error("composition repair loop returned ok validation without composition");
  }
  await persistTemplateFallbackIfNeeded(db, {
    draftId,
    goalDesignPackage: input.goalDesignPackage,
    attempts: repairResult.attempts,
    finalComposition: composition,
  });
  input.onProgress?.({ stage: "composition.compiling", message: "Compiling workflow composition." });
  const compiled = await compileWorkflowComposition(db, {
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    goalContract: input.goalContract,
    candidatePacket,
    composition,
    goalDesignPackage: input.goalDesignPackage,
    scope: input.goalContract.domain,
    manifestDomain: input.goalContract.domain,
  });
  input.onProgress?.({ stage: "composition.compiled", message: "Workflow composition compiled." });
  const bundle: PlanBundle & {
    orchestrationSnapshot: CompiledWorkflowComposition["orchestrationSnapshot"];
    goalRequirementCoverage: CompiledWorkflowComposition["goalRequirementCoverage"];
    repairAttempts: typeof repairResult.attempts;
    plannerRequest: PlannerDraftRequestContract;
    goalContract: GoalContractV1;
    goalContractHash: string;
  } = {
    workflow: compiled.workflow,
    goalRequirementCoverage: compiled.goalRequirementCoverage,
      goalContract: input.goalContract,
      goalContractHash: input.goalContractHash,
      ...(input.goalDesignPackage
        ? {
            goalDesignPackage: input.goalDesignPackage,
            goalDesignPackageHash: input.goalDesignPackage.packageHash,
          }
        : {}),
      plannerTrace: {
      model: `southstar-library-constrained-${composerMode}-composer`,
      promptHash: hash(input.goalPrompt),
      generatedAt: new Date().toISOString(),
      analyzerType: "goal-contract-v1",
      composerMode,
      composerFallbackUsed: false,
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

  await persistPlannerDraft(db, {
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
      ...goalContractSummary(input.goalContract, input.goalContractHash),
    },
  }, input.persistDraft);
  input.onProgress?.({ stage: "draft.persisted", ok: true, issueCount: validationIssues.length, message: "Planner draft persisted." });
  return {
    draftId,
    goalPrompt: input.goalPrompt,
    workflowId: compiled.workflow.workflowId,
    status,
    goalContractHash: input.goalContractHash,
    blockers: [...input.goalContract.blockingInputs],
    validationIssues,
    taskSummaries,
  };
}

async function persistTemplateFallbackIfNeeded(
  db: SouthstarDb,
  input: {
    draftId: string;
    goalDesignPackage?: GoalDesignPackageV1;
    attempts: Array<{
      validation: { ok: boolean; issues: WorkflowCompositionValidationIssue[] };
      composition?: WorkflowCompositionPlan;
    }>;
    finalComposition: WorkflowCompositionPlan;
  },
): Promise<void> {
  const policy = input.goalDesignPackage?.templatePolicy;
  if (policy?.mode !== "prefer") return;
  const rejectedPinnedAttempt = input.attempts.find((attempt) => (
    attempt.composition?.selectedWorkflowTemplateRef === policy.templateRef
    && !attempt.validation.ok
  ));
  if (!rejectedPinnedAttempt) return;
  if (input.finalComposition.selectedWorkflowTemplateRef === policy.templateRef) return;
  await upsertRuntimeResourcePg(db, {
    resourceType: "template_fallback",
    resourceKey: input.draftId,
    scope: "planner",
    status: "persisted",
    title: "Workflow Template Fallback",
    payload: {
      draftId: input.draftId,
      templatePolicy: policy,
      rejectedIssues: rejectedPinnedAttempt.validation.issues,
      finalSelectedWorkflowTemplateRef: input.finalComposition.selectedWorkflowTemplateRef ?? null,
    },
    summary: {
      draftId: input.draftId,
      templateRef: policy.templateRef,
      versionRef: policy.versionRef,
      issueCount: rejectedPinnedAttempt.validation.issues.length,
      finalSelectedWorkflowTemplateRef: input.finalComposition.selectedWorkflowTemplateRef ?? null,
    },
  });
}

export async function createPostgresRunFromDraft(db: SouthstarDb, input: { draftId: string }): Promise<PostgresRunResult> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  if (draft.status !== "validated") throw new Error(`planner draft is not validated: ${input.draftId}`);
  const draftPayload = asRecord(draft.payload);
  const draftSummary = asRecord(draft.summary);
  const contract = storedOrLegacyGoalContract(draftPayload, draftSummary, input.draftId);
  const contractHash = goalContractHash(contract);
  assertStoredGoalContractHashes(draftPayload, draftSummary, contractHash);
  if (contract.blockingInputs.length > 0) {
    await validatePostgresPlannerDraft(db, input);
    throw new Error(`planner draft has blocking inputs: ${input.draftId}`);
  }
  const bundle = draft.payload as PlanBundle & { generationPlan?: { templateRef?: string } };
  const materializedWorkflow = materializeWorkflowTaskProfileOverrides(bundle.workflow);
  const workflow = { ...materializedWorkflow, domain: materializedWorkflow.domain ?? contract.domain };
  const runId = await allocateRunId(db, workflow.workflowId);
  const plannerRequest = plannerRequestFromStored(draftSummary.plannerRequest) ?? plannerRequestFromStored(draftPayload.plannerRequest);
  const cwd = plannerRequest?.cwd;
  if (cwd) assertWorkspaceMountAllowed(cwd);
  const orchestrationCompiler = asRecord(asRecord(draftPayload.orchestrationSnapshot).compiler);
  const libraryObjectVersionRefs = workflow.compiledFrom?.libraryObjectVersionRefs ?? [];
  if (libraryObjectVersionRefs.length === 0 || !Array.isArray(orchestrationCompiler.libraryObjectVersionRefs)) {
    throw new Error(`planner draft is missing immutable Library selection metadata: ${input.draftId}`);
  }
  const coverage = asRecord(draftPayload.goalRequirementCoverage);
  if (coverage.schemaVersion !== "southstar.goal_requirement_coverage.v1") {
    throw new Error(`planner draft is missing Goal Contract coverage: ${input.draftId}`);
  }
  const manifestHash = contentHashForPayload(workflow);
  const runtimeContext = {
    draftId: input.draftId,
    goalContractHash: contractHash,
    manifestHash,
    scope: workflow.domain,
    outcomeStatus: "in_progress",
    ...(cwd ? { cwd, projectRoot: cwd } : {}),
  };
  const taskIds: string[] = [];

  await db.tx(async (tx) => {
    await createWorkflowRunPg(tx, {
      id: runId,
      status: "created",
      domain: workflow.domain,
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({ executor: "pending" }),
      snapshotJson: JSON.stringify({ activeTaskIds: [] }),
      runtimeContextJson: JSON.stringify(runtimeContext),
      metricsJson: JSON.stringify({}),
    });
    const librarySnapshot = await captureRunLibrarySnapshotPg(tx, {
      runId,
      goalContractHash: contractHash,
      manifestHash,
      libraryObjectVersionRefs,
      libraryRoot: process.env.SOUTHSTAR_LIBRARY_ROOT ?? `${process.cwd()}/library`,
    });
    await tx.query(
      `update southstar.workflow_runs
          set runtime_context_json = $2::jsonb,
              updated_at = now()
        where id = $1`,
      [runId, JSON.stringify({ ...runtimeContext, librarySnapshotHash: librarySnapshot.snapshotHash })],
    );
    await upsertRuntimeResourcePg(tx, {
      id: `goal-requirement-coverage:${runId}`,
      resourceType: "goal_requirement_coverage",
      resourceKey: runId,
      runId,
      scope: "run",
      status: "frozen",
      title: "Goal Requirement Coverage",
      payload: coverage,
      summary: { goalContractHash: contractHash },
    });
    await appendHistoryEventPg(tx, {
      runId,
      eventType: "run.created",
      actorType: "orchestrator",
      payload: { draftId: input.draftId, workflowId: workflow.workflowId },
    });
    for (const [index, task] of workflow.tasks.entries()) {
      await createWorkflowTaskPg(tx, {
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
      await appendHistoryEventPg(tx, {
        runId,
        taskId: task.id,
        eventType: "task.created",
        actorType: "orchestrator",
        payload: { taskKey: task.name ?? task.id, dependsOn: task.dependsOn },
      });
      taskIds.push(task.id);
    }
  });
  return { runId, taskIds };
}

function assertStoredGoalContractHashes(
  payload: Record<string, unknown>,
  summary: Record<string, unknown>,
  canonicalHash: string,
): void {
  const hashes = [
    { label: "payload.goalContractHash", value: payload.goalContractHash },
    { label: "summary.goalContractHash", value: summary.goalContractHash },
    {
      label: "goalRequirementCoverage.goalContractHash",
      value: asRecord(payload.goalRequirementCoverage).goalContractHash,
    },
    {
      label: "orchestrationSnapshot.goalContractHash",
      value: asRecord(payload.orchestrationSnapshot).goalContractHash,
    },
  ];
  for (const hash of hashes) {
    if (hash.value === undefined) continue;
    if (hash.value === canonicalHash) continue;
    throw new Error(
      `Goal Contract hash mismatch at ${hash.label}: expected ${canonicalHash}, received ${String(hash.value)}`,
    );
  }
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
  const contract = storedOrLegacyGoalContract(payload, summary, input.draftId);
  const status = plannerDraftStatus(draft.status);
  const vocabularyGaps = parseVocabularyGaps(payload.vocabularyGaps);

  return {
    draftId: input.draftId,
    goalPrompt,
    workflowId,
    status,
    goalContractHash: storedGoalContractHash(summary, payload, contract),
    ...(stringValue(payload.goalRequirementDraftHash) ? { goalRequirementDraftHash: stringValue(payload.goalRequirementDraftHash) } : {}),
    ...(stringValue(payload.goalDesignPhase) ? { goalDesignPhase: stringValue(payload.goalDesignPhase) } : {}),
    ...(payload.goalRequirementDraft && typeof payload.goalRequirementDraft === "object"
      ? { goalRequirementDraft: payload.goalRequirementDraft as GoalRequirementDraftV1 }
      : {}),
    blockers: status === PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT
      ? parseVocabularyGapBlockers(vocabularyGaps)
      : [...contract.blockingInputs],
    validationIssues,
    taskSummaries,
    ...(vocabularyGaps.length > 0 ? { vocabularyGaps } : {}),
    ...(stringValue(payload.libraryImportDraftId) ? { libraryImportDraftId: stringValue(payload.libraryImportDraftId) } : {}),
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
  const contract = storedOrLegacyGoalContract(payload, summary, draftId);
  const contractHash = storedGoalContractHash(summary, payload, contract);
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
      goalContract: contract,
      goalContractHash: contractHash,
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
      ...goalContractSummary(contract, contractHash),
    },
    metrics: draft.metrics,
    ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {}),
  });

  return {
    draftId,
    goalPrompt,
    workflowId,
    status: PLANNER_DRAFT_STATUS_NEEDS_VALIDATION,
    goalContractHash: contractHash,
    blockers: [...contract.blockingInputs],
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
  goalRequirementCoverage: unknown;
  issues: PlannerDraftValidationIssue[];
}> {
  const candidatePacket = maybeCandidatePacket(input.payload.candidatePacket);
  const currentSnapshot = input.payload.orchestrationSnapshot;
  const currentCoverage = input.payload.goalRequirementCoverage;
  let composition: WorkflowCompositionPlan | null;
  try {
    composition = maybeWorkflowCompositionPlan(asRecord(currentSnapshot).selectedCompositionPlan);
  } catch (error) {
    return {
      workflow: input.workflow,
      orchestrationSnapshot: currentSnapshot,
      goalRequirementCoverage: currentCoverage,
      issues: [{
        path: "orchestrationSnapshot.selectedCompositionPlan",
        code: "composition_needs_regeneration",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  if (!candidatePacket || !composition) {
    return {
      workflow: input.workflow,
      orchestrationSnapshot: currentSnapshot,
      goalRequirementCoverage: currentCoverage,
      issues: [],
    };
  }

  try {
    const contract = requiredStoredGoalContract(input.payload.goalContract, input.draftId);
    const compiled = await compileWorkflowComposition(db, {
      runId: input.draftId,
      goalPrompt: input.goalPrompt,
      goalContract: contract,
      candidatePacket,
      composition: applyWorkflowTaskSelectionsToComposition(composition, input.workflow),
      goalDesignPackage: storedGoalDesignPackage(input.payload.goalDesignPackage),
      scope: contract.domain,
      manifestDomain: contract.domain,
    });
    return {
      workflow: copyProfileOverridesToWorkflow(compiled.workflow, input.workflow),
      orchestrationSnapshot: compiled.orchestrationSnapshot,
      goalRequirementCoverage: compiled.goalRequirementCoverage,
      issues: [],
    };
  } catch (error) {
    return {
      workflow: input.workflow,
      orchestrationSnapshot: currentSnapshot,
      goalRequirementCoverage: currentCoverage,
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
    ...(input.harnessRef !== undefined ? { harnessRef: input.harnessRef } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    ...(input.skillRefs !== undefined ? { skillRefs: [...input.skillRefs] } : {}),
    ...(input.mcpGrantRefs !== undefined ? { mcpGrantRefs: [...input.mcpGrantRefs] } : {}),
    ...(input.toolGrantRefs !== undefined ? { toolGrantRefs: [...input.toolGrantRefs] } : {}),
    ...(input.vaultLeasePolicyRefs !== undefined ? { vaultLeasePolicyRefs: [...input.vaultLeasePolicyRefs] } : {}),
    ...(input.nodePromptSpec !== undefined ? { nodePromptSpec: { ...input.nodePromptSpec } } : {}),
  };
}

function asWorkflowManifest(value: unknown): SouthstarWorkflowManifest {
  return asRecord(value) as SouthstarWorkflowManifest;
}

function goalContractSummary(contract: GoalContractV1, contractHash: string): Record<string, unknown> {
  return {
    goalContractHash: contractHash,
    domain: contract.domain,
    intent: contract.intent,
    blockers: [...contract.blockingInputs],
    requirementCount: contract.requirements.length,
  };
}

function goalContractFromStored(value: unknown): GoalContractV1 | undefined {
  const contract = asRecord(value);
  if (contract.schemaVersion !== "southstar.goal_contract.v1") return undefined;
  if (typeof contract.originalPrompt !== "string" || typeof contract.domain !== "string") return undefined;
  if (!Array.isArray(contract.requirements) || !Array.isArray(contract.blockingInputs)) return undefined;
  return contract as GoalContractV1;
}

function requiredStoredGoalContract(value: unknown, draftId: string): GoalContractV1 {
  const contract = goalContractFromStored(value);
  if (!contract) throw new Error(`planner draft Goal Contract is missing: ${draftId}`);
  return contract;
}

function storedGoalDesignPackage(value: unknown): GoalDesignPackageV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pkg = value as GoalDesignPackageV1;
  return validateGoalDesignPackage(pkg).length === 0 ? pkg : undefined;
}

function storedOrLegacyGoalContract(
  payload: Record<string, unknown>,
  summary: Record<string, unknown>,
  draftId: string,
): GoalContractV1 {
  return goalContractFromStored(payload.goalContract)
    ?? legacyGoalContractFromStored(payload, summary, draftId);
}

function legacyGoalContractFromStored(
  payload: Record<string, unknown>,
  summary: Record<string, unknown>,
  draftId: string,
): GoalContractV1 {
  const workflow = asRecord(payload.workflow);
  const plannerRequest = asRecord(summary.plannerRequest);
  const payloadPlannerRequest = asRecord(payload.plannerRequest);
  const goalPrompt = stringValue(summary.goalPrompt)
    ?? stringValue(workflow.goalPrompt)
    ?? stringValue(plannerRequest.goalPrompt)
    ?? stringValue(payloadPlannerRequest.goalPrompt);
  if (!goalPrompt) throw new Error(`planner draft goalPrompt is missing: ${draftId}`);
  const requirementSpec = legacyRequirementSpec(payload);
  const acceptanceCriteria = stringArrayValue(requirementSpec.acceptanceCriteria) ?? [];
  const fallbackRequirement = stringValue(requirementSpec.summary) ?? goalPrompt;
  return finalizeGoalContract({
    goalPrompt,
    cwd: stringValue(plannerRequest.cwd) ?? stringValue(payloadPlannerRequest.cwd) ?? "/",
    interpretation: {
      domain: stringValue(workflow.domain) ?? stringValue(summary.domain) ?? "general",
      intent: stringValue(workflow.intent) ?? "legacy_planner_draft",
      workType: workTypeValue(requirementSpec.workType) ?? "general",
      summary: stringValue(requirementSpec.summary) ?? goalPrompt,
      requirements: (acceptanceCriteria.length > 0 ? acceptanceCriteria : [fallbackRequirement]).map((criterion) => ({
        statement: criterion,
        acceptanceCriteria: [criterion],
        blocking: false,
        source: "inferred" as const,
      })),
      expectedArtifactRefs: stringArrayValue(requirementSpec.expectedArtifacts) ?? [],
      requiredCapabilities: [],
      nonGoals: stringArrayValue(requirementSpec.nonGoals) ?? [],
      assumptions: stringArrayValue(requirementSpec.workspaceAssumptions) ?? [],
      blockingInputs: stringArrayValue(requirementSpec.missingInputs) ?? [],
      riskTags: stringArrayValue(requirementSpec.riskNotes) ?? [],
      requestedSideEffects: [],
    },
  });
}

function workTypeValue(value: unknown): GoalContractV1["workType"] | undefined {
  return value === "software_feature"
    || value === "bugfix"
    || value === "research"
    || value === "data_analysis"
    || value === "migration"
    || value === "ops_recovery"
    || value === "general"
    ? value
    : undefined;
}

function legacyRequirementSpec(payload: Record<string, unknown>): Partial<RequirementSpecV2> & Record<string, unknown> {
  const candidatePacket = asRecord(payload.candidatePacket);
  const orchestrationSnapshot = asRecord(payload.orchestrationSnapshot);
  const value = candidatePacket.requirementSpec
    ?? orchestrationSnapshot.requirementSpec
    ?? payload.requirementSpec;
  return asRecord(value) as Partial<RequirementSpecV2> & Record<string, unknown>;
}

function storedGoalContractHash(
  summary: Record<string, unknown>,
  payload: Record<string, unknown>,
  contract: GoalContractV1,
): string {
  if (!goalContractFromStored(payload.goalContract)) return goalContractHash(contract);
  return stringValue(summary.goalContractHash)
    ?? stringValue(payload.goalContractHash)
    ?? goalContractHash(contract);
}

function plannerDraftStatus(value: string): PostgresPlannerDraftStatus {
  if (
    value === PLANNER_DRAFT_STATUS_NEEDS_INPUT
    || value === PLANNER_DRAFT_STATUS_NEEDS_LIBRARY_INPUT
    || value === PLANNER_DRAFT_STATUS_INVALID
    || value === PLANNER_DRAFT_STATUS_NEEDS_VALIDATION
    || value === PLANNER_DRAFT_STATUS_READY_FOR_REVIEW
    || value === PLANNER_DRAFT_STATUS_TEMPLATE_INCOMPATIBLE
    || value === PLANNER_DRAFT_STATUS_VALIDATED
    || value === PLANNER_DRAFT_STATUS_REQUIREMENTS_REVIEW
    || value === PLANNER_DRAFT_STATUS_VALIDATION_RESOLVING
    || value === PLANNER_DRAFT_STATUS_LIBRARY_REVIEW
    || value === PLANNER_DRAFT_STATUS_VALIDATION_READY
  ) return value;
  throw new Error(`unsupported planner draft status: ${value}`);
}

function parseVocabularyGapBlockers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const gap = asRecord(item);
    const kind = stringValue(gap.kind);
    const requestedRef = stringValue(gap.requestedRef);
    return kind && requestedRef ? [`Approve Library ${kind}: ${requestedRef}`] : [];
  });
}

function parseVocabularyGaps(value: unknown): GoalContractVocabularyGapV1[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const gap = asRecord(item);
    const kind = gap.kind;
    const requestedRef = stringValue(gap.requestedRef);
    const allowedRefs = stringArrayValue(gap.allowedRefs);
    if ((kind !== "domain" && kind !== "capability" && kind !== "artifact") || !requestedRef || !allowedRefs) return [];
    return [{ kind, requestedRef, allowedRefs }];
  });
}

function maybeCandidatePacket(value: unknown): CandidatePacket | null {
  const record = asRecord(value);
  if (!record.requirementSpec) return null;
  if (!Array.isArray(record.workflowTemplateCandidates)) return null;
  return record as CandidatePacket;
}

function maybeWorkflowCompositionPlan(value: unknown): WorkflowCompositionPlan | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value);
  if (record.schemaVersion !== "southstar.workflow_composition_plan.v1") {
    throw new Error("persisted workflow composition needs regeneration: invalid schemaVersion");
  }
  if (typeof record.title !== "string" || typeof record.rationale !== "string" || !Array.isArray(record.tasks)) {
    throw new Error("persisted workflow composition needs regeneration: invalid composition shape");
  }
  for (const [index, task] of record.tasks.entries()) {
    const taskRecord = asRecord(task);
    if (!Array.isArray(taskRecord.requirementIds)) {
      throw new Error(`persisted workflow composition needs regeneration: tasks.${index}.requirementIds missing`);
    }
  }
  return record as WorkflowCompositionPlan;
}

type WorkflowTaskWithProfileOverride = SouthstarWorkflowManifest["tasks"][number] & {
  profileOverride?: PlannerDraftTaskProfileOverride;
};

function materializeWorkflowTaskProfileOverrides(workflow: SouthstarWorkflowManifest): SouthstarWorkflowManifest {
  const agentProfiles = required(workflow.agentProfiles, `missing workflow agentProfiles in manifest ${workflow.workflowId}`).map(cloneAgentProfile);
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
      ...(override.harnessRef !== undefined ? { harnessRef: override.harnessRef } : {}),
      ...(override.provider !== undefined ? { provider: override.provider } : {}),
      ...(override.model !== undefined ? { model: override.model } : {}),
      ...(override.thinkingLevel !== undefined ? { thinkingLevel: override.thinkingLevel } : {}),
      ...(override.instruction !== undefined ? { instruction: override.instruction } : {}),
      ...(override.skillRefs !== undefined ? { skillRefs: [...override.skillRefs] } : {}),
      ...(override.mcpGrantRefs !== undefined ? { mcpGrantRefs: [...override.mcpGrantRefs] } : {}),
      ...(override.vaultLeasePolicyRefs !== undefined ? { vaultLeasePolicyRefs: [...override.vaultLeasePolicyRefs] } : {}),
      ...(override.toolGrantRefs !== undefined
        ? { toolPolicy: { ...baseProfile.toolPolicy, allowedTools: [...override.toolGrantRefs] } }
        : {}),
    };

    outputProfiles.push(overrideProfile);
    profileById.set(overrideProfile.id, overrideProfile);
    task.agentProfileRef = overrideProfile.id;
    if (override.skillRefs !== undefined) task.skillRefs = [...override.skillRefs];
    if (override.mcpGrantRefs !== undefined) task.mcpGrantRefs = [...override.mcpGrantRefs];
    if (override.toolGrantRefs !== undefined) task.toolGrantRefs = [...override.toolGrantRefs];
    if (override.vaultLeasePolicyRefs !== undefined) task.vaultLeasePolicyRefs = [...override.vaultLeasePolicyRefs];
    if (override.nodePromptSpec !== undefined) {
      task.promptInputs = { ...task.promptInputs, nodePromptSpec: { ...override.nodePromptSpec } };
    }
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
    ...(profile.vaultLeasePolicyRefs !== undefined ? { vaultLeasePolicyRefs: [...profile.vaultLeasePolicyRefs] } : {}),
    memoryScopes: [...profile.memoryScopes],
    toolPolicy: {
      allowedTools: [...profile.toolPolicy.allowedTools],
      deniedTools: [...profile.toolPolicy.deniedTools],
      requiresApprovalFor: [...profile.toolPolicy.requiresApprovalFor],
    },
    budgetPolicy: { ...profile.budgetPolicy },
  };
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function hasGraphMetadataCandidates(candidatePacket: CandidatePacket): boolean {
  return Boolean(candidatePacket.graphMetadataCandidates?.nodes.length);
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

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inferDraftOrchestrationMode(summary: Record<string, unknown>): "llm-constrained" {
  const planner = stringValue(summary.planner);
  if (planner && planner !== "library-constrained-llm" && planner !== "existing-composition-compiler") {
    throw new Error(`planner draft uses retired planner mode: ${planner}`);
  }
  return "llm-constrained";
}

function inferDraftComposerMode(payload: Record<string, unknown>): WorkflowComposerMode | undefined {
  const plannerTrace = asRecord(payload.plannerTrace);
  const composerMode = stringValue(plannerTrace.composerMode);
  if (composerMode === "llm") return composerMode;
  return undefined;
}
