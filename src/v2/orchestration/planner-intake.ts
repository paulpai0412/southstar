import { createHash } from "node:crypto";
import type { RunGoalRequest, RunGoalResult } from "./run-goal-service.ts";

export type PlannerIntakeBody = {
  goalPrompt?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  projectRef?: unknown;
  idempotencyKey?: unknown;
  goalDesignMode?: unknown;
  templatePolicy?: unknown;
};

export function buildRunGoalRequestFromPlannerDraftBody(
  body: PlannerIntakeBody,
  defaultCwd = process.cwd(),
): RunGoalRequest {
  const goalPrompt = requiredString(body.goalPrompt, "goalPrompt");
  const cwd = optionalString(body.cwd) ?? defaultCwd;
  const sessionId = optionalString(body.sessionId);
  const projectRef = optionalString(body.projectRef);
  return {
    goalPrompt,
    cwd,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(projectRef !== undefined ? { projectRef } : {}),
    idempotencyKey: optionalString(body.idempotencyKey)
      ?? legacyPlannerDraftIdempotencyKey(goalPrompt, cwd, projectRef),
    ...(goalDesignMode(body.goalDesignMode) !== undefined ? { goalDesignMode: goalDesignMode(body.goalDesignMode) } : {}),
    ...(templatePolicy(body.templatePolicy) !== undefined ? { templatePolicy: templatePolicy(body.templatePolicy) } : {}),
  };
}

export function plannerDraftReceiptFromGoalResult(result: RunGoalResult, goalPrompt = "") {
  return {
    draftId: result.draftId,
    goalPrompt,
    workflowId: "",
    status: result.draftStatus,
    goalContractHash: result.goalContractHash,
    ...(result.goalRequirementDraftId ? { goalRequirementDraftId: result.goalRequirementDraftId } : {}),
    ...(result.goalRequirementDraftHash ? { goalRequirementDraftHash: result.goalRequirementDraftHash } : {}),
    ...(result.goalDesignPhase ? { goalDesignPhase: result.goalDesignPhase } : {}),
    ...(result.confirmable !== undefined ? { confirmable: result.confirmable } : {}),
    ...(result.goalDesignPackageHash ? { goalDesignPackageHash: result.goalDesignPackageHash } : {}),
    ...(result.vocabularyGaps ? { vocabularyGaps: result.vocabularyGaps } : {}),
    ...(result.libraryImportDraftId ? { libraryImportDraftId: result.libraryImportDraftId } : {}),
    blockers: result.blockers,
    validationIssues: result.validationIssues ?? [],
    taskSummaries: [],
  };
}

function legacyPlannerDraftIdempotencyKey(goalPrompt: string, cwd: string, projectRef?: string): string {
  return `planner-draft-${createHash("sha256").update(`${cwd}\n${projectRef ?? ""}\n${goalPrompt}`).digest("hex").slice(0, 24)}`;
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function goalDesignMode(value: unknown): RunGoalRequest["goalDesignMode"] {
  if (value === undefined) return undefined;
  if (value === "review_before_compose" || value === "auto_until_blocked") return value;
  throw new Error("goalDesignMode must be review_before_compose or auto_until_blocked");
}

function templatePolicy(value: unknown): RunGoalRequest["templatePolicy"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("templatePolicy must be an object");
  const policy = value as Record<string, unknown>;
  if (policy.mode === "auto") return { mode: "auto" };
  if (policy.mode === "prefer" || policy.mode === "require") {
    return {
      mode: policy.mode,
      templateRef: requiredString(policy.templateRef, "templatePolicy.templateRef"),
      versionRef: requiredString(policy.versionRef, "templatePolicy.versionRef"),
    };
  }
  throw new Error("templatePolicy.mode must be auto, prefer, or require");
}
