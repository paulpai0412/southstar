import type { SouthstarDb } from "../db/postgres.ts";
import type {
  CandidatePacket,
  WorkflowCompositionPatch,
  WorkflowCompositionPlan,
  WorkflowCompositionValidationResult,
} from "../design-library/types.ts";
import type { WorkflowComposer } from "./composer.ts";
import type { PlannerDraftProgressListener } from "../ui-api/postgres-run-api.ts";
import { validateWorkflowCompositionPlan } from "./composition-validator.ts";
import { LlmComposerOutputError } from "./llm-composer.ts";
import type { GoalContractV1 } from "./goal-contract.ts";
import type { GoalDesignPackage } from "./goal-design.ts";
import type { RuntimeBindingCapabilities } from "./runtime-binding-capabilities.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";

export type CompositionRepairAttempt = {
  attempt: number;
  validation: WorkflowCompositionValidationResult;
  composition?: WorkflowCompositionPlan;
  repairPatch?: WorkflowCompositionPatch;
  repairBlockedReason?: string;
};

export type RunCompositionRepairLoopInput = {
  db: SouthstarDb;
  goalPrompt: string;
  goalContract: GoalContractV1;
  goalDesignPackage?: GoalDesignPackage;
  targetRequirementIds?: string[];
  candidatePacket: CandidatePacket;
  composer: WorkflowComposer;
  cwd?: string;
  scope?: string;
  maxRepairAttempts: number;
  onProgress?: PlannerDraftProgressListener;
  onLlmDelta?: (text: string) => void;
  runtimeBindingCapabilities?: RuntimeBindingCapabilities;
};

export type CompositionRepairLoopResult = {
  composition: WorkflowCompositionPlan | null;
  validation: WorkflowCompositionValidationResult;
  attempts: CompositionRepairAttempt[];
};

export async function runCompositionRepairLoop(input: RunCompositionRepairLoopInput): Promise<CompositionRepairLoopResult> {
  const attempts: CompositionRepairAttempt[] = [];
  const composeInput = {
    goalPrompt: input.goalPrompt,
    goalContract: input.goalContract,
    goalDesignPackage: input.goalDesignPackage,
    candidatePacket: input.candidatePacket,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    onLlmDelta: input.onLlmDelta,
  };
  let composition: WorkflowCompositionPlan | undefined;
  let validation: WorkflowCompositionValidationResult;
  try {
    input.onProgress?.({ stage: "composer.started", attempt: 0, message: "Starting canonical workflow composition." });
    composition = await input.composer.compose(composeInput);
    input.onProgress?.({ stage: "composer.completed", attempt: 0, message: "Canonical workflow composition returned a plan." });
    validation = await validateComposition(input, composition);
  } catch (error) {
    if (!(error instanceof LlmComposerOutputError)) throw error;
    validation = { ok: false, issues: error.issues };
    input.onProgress?.({ stage: "composer.failed", attempt: 0, ok: false, issueCount: error.issues.length, message: (error as Error).message });
  }
  input.onProgress?.({
    stage: "validation.completed",
    attempt: 0,
    ok: validation.ok,
    issueCount: validation.issues.length,
    message: validation.ok ? "Canonical workflow composition passed validation." : "Canonical workflow composition failed validation.",
  });
  attempts.push({ attempt: 0, validation, ...(composition ? { composition } : {}) });
  if (validation.ok) return { composition: composition ?? null, validation, attempts };

  // Composition repair is intentionally one bounded patch. Whole-plan
  // regeneration made a single bad ref capable of changing unrelated DAG
  // ownership and dependencies, which broke lineage and made failures hard to
  // diagnose. Library/runtime gaps are blocking inputs, not LLM repair work.
  const nonRepairable = validation.issues.filter((entry) => NON_REPAIRABLE_ISSUE_CODES.has(entry.code));
  if (nonRepairable.length > 0) {
    attempts[0]!.repairBlockedReason = `non_repairable_library_or_runtime_gap:${nonRepairable.map((entry) => entry.code).join(",")}`;
    input.onProgress?.({ stage: "repair.blocked", attempt: 1, ok: false, issueCount: nonRepairable.length, message: attempts[0]!.repairBlockedReason });
    return { composition: composition ?? null, validation, attempts };
  }
  if (!composition || !input.composer.repair || input.maxRepairAttempts < 1) {
    const blocked = attempts[0]!;
    blocked.repairBlockedReason = !composition
      ? "no_base_composition"
      : !input.composer.repair
        ? "composer_does_not_support_bounded_repair"
        : "bounded_repair_disabled";
    return { composition: composition ?? null, validation, attempts };
  }
  let repairPatch: WorkflowCompositionPatch;
  try {
    input.onProgress?.({ stage: "repair.started", attempt: 1, message: "Requesting one bounded composition repair patch." });
    repairPatch = await input.composer.repair({ ...composeInput, baseComposition: composition, validationIssues: validation.issues });
    composition = applyBoundedCompositionPatch(composition, repairPatch);
  } catch (error) {
    if (!(error instanceof LlmComposerOutputError)) throw error;
    validation = { ok: false, issues: error.issues };
    attempts[0]!.repairBlockedReason = "repair_patch_invalid";
    input.onProgress?.({ stage: "repair.failed", attempt: 1, ok: false, issueCount: error.issues.length, message: (error as Error).message });
    return { composition: attempts[0]!.composition ?? null, validation, attempts };
  }
  validation = await validateComposition(input, composition);
  attempts.push({ attempt: 1, validation, composition, repairPatch });
  input.onProgress?.({ stage: "repair.completed", attempt: 1, ok: validation.ok, issueCount: validation.issues.length, message: validation.ok ? "Bounded repair patch passed validation." : "Bounded repair patch still fails validation." });
  if (!validation.ok && sameIssueSet(attempts[0]!.validation.issues, validation.issues)) {
    attempts[1]!.repairBlockedReason = "repeated_validation_error";
    input.onProgress?.({ stage: "repair.blocked", attempt: 1, ok: false, issueCount: validation.issues.length, message: "The same structured validation error recurred after the bounded repair patch." });
  }
  if (validation.ok) return { composition: composition ?? null, validation, attempts };
  const last = attempts.at(-1);
  if (!last) {
    throw new Error("composition repair loop did not execute");
  }
  return {
    composition: last.composition ?? null,
    validation: last.validation,
    attempts,
  };
}

const NON_REPAIRABLE_ISSUE_CODES = new Set([
  "ref_not_in_candidate_packet",
  "profile_does_not_implement_agent",
  "profile_does_not_allow_skill",
  "profile_does_not_allow_tool",
  "profile_does_not_allow_mcp",
  "profile_does_not_allow_vault_lease",
  "profile_does_not_allow_instruction",
  "agent_does_not_produce_artifact",
  "evaluator_does_not_validate_artifact",
  "requirement_missing_producer",
  "requirement_missing_artifact",
  "requirement_missing_evaluator",
  "requirement_evaluator_not_independent",
  "requirement_missing_evidence",
  "input_artifact_not_satisfied",
  "policy_conflict",
]);

async function validateComposition(
  input: RunCompositionRepairLoopInput,
  composition: WorkflowCompositionPlan,
): Promise<WorkflowCompositionValidationResult> {
  return await validateWorkflowCompositionPlan(input.db, input.candidatePacket, composition, {
    scope: input.scope,
    goalContract: input.goalContract,
    goalDesignPackage: input.goalDesignPackage,
    targetRequirementIds: input.targetRequirementIds,
    runtimeBindingCapabilities: input.runtimeBindingCapabilities,
  });
}

export function applyBoundedCompositionPatch(
  base: WorkflowCompositionPlan,
  patch: WorkflowCompositionPatch,
): WorkflowCompositionPlan {
  if (patch.schemaVersion !== "southstar.workflow_composition_patch.v1") throw new Error("invalid workflow composition patch schemaVersion");
  if (patch.basePlanHash !== contentHashForPayload(base)) throw new Error("workflow composition patch basePlanHash does not match current plan");
  if (!Array.isArray(patch.operations) || patch.operations.length !== 1) throw new Error("workflow composition repair must contain exactly one operation");
  const operation = patch.operations[0]!;
  if (operation.op === "replace-ref") {
    const allowedFields = new Set(["agentDefinitionRef", "agentProfileRef", "evaluatorProfileRef", "contextPolicyRef", "workspacePolicyRef"]);
    if (!allowedFields.has(operation.field)) throw new Error(`workflow composition repair cannot replace field ${String(operation.field)}`);
    const task = base.tasks.find((candidate) => candidate.id === operation.taskId);
    if (!task) throw new Error(`workflow composition repair task not found: ${operation.taskId}`);
    if (task[operation.field] !== operation.fromRef) throw new Error(`workflow composition repair fromRef does not match ${operation.taskId}.${String(operation.field)}`);
    return { ...base, tasks: base.tasks.map((candidate) => candidate.id === operation.taskId ? { ...candidate, [operation.field]: operation.toRef } : candidate) };
  }
  if (operation.op === "replace-task") {
    const current = base.tasks.find((candidate) => candidate.id === operation.taskId);
    if (!current || operation.task.id !== operation.taskId) throw new Error(`workflow composition repair task not found or id changed: ${operation.taskId}`);
    const immutableFields = ["id", "sliceId", "requirementIds", "dependsOn", "templateSlotRef"] as const;
    for (const field of immutableFields) {
      if (contentHashForPayload(current[field]) !== contentHashForPayload(operation.task[field])) throw new Error(`workflow composition repair cannot change structural field ${field}`);
    }
    const allowedFields = new Set([
      "name", "responsibility", "nodePromptSpec", "agentDefinitionRef", "agentProfileRef", "instructionRefs",
      "skillRefs", "toolGrantRefs", "mcpGrantRefs", "vaultLeasePolicyRefs", "inputArtifactRefs", "outputArtifactRefs",
      "evaluatorProfileRef", "contextPolicyRef", "workspacePolicyRef", "workspaceMutation", "recoveryStrategyRefs", "rationale",
    ]);
    const changedFields = Object.keys(operation.task).filter((field) => contentHashForPayload(current[field as keyof typeof current]) !== contentHashForPayload(operation.task[field as keyof typeof operation.task]));
    if (changedFields.length === 0 || changedFields.some((field) => !allowedFields.has(field))) throw new Error("workflow composition repair changed a forbidden or empty task field set");
    return { ...base, tasks: base.tasks.map((candidate) => candidate.id === operation.taskId ? operation.task : candidate) };
  }
  throw new Error(`workflow composition repair operation ${operation.op} is not supported`);
}

function sameIssueSet(left: Array<{ code: string; path: string; message: string }>, right: Array<{ code: string; path: string; message: string }>): boolean {
  return contentHashForPayload(left) === contentHashForPayload(right);
}
