import type { SouthstarDb } from "../db/postgres.ts";
import type {
  CandidatePacket,
  WorkflowCompositionPlan,
  WorkflowCompositionValidationResult,
} from "../design-library/types.ts";
import type { WorkflowComposer } from "./composer.ts";
import { validateWorkflowCompositionPlan } from "./composition-validator.ts";
import { LlmComposerOutputError } from "./llm-composer.ts";

export type CompositionRepairAttempt = {
  attempt: number;
  validation: WorkflowCompositionValidationResult;
  composition?: WorkflowCompositionPlan;
};

export type RunCompositionRepairLoopInput = {
  db: SouthstarDb;
  goalPrompt: string;
  candidatePacket: CandidatePacket;
  composer: WorkflowComposer;
  scope?: string;
  maxRepairAttempts: number;
};

export type CompositionRepairLoopResult = {
  composition: WorkflowCompositionPlan | null;
  validation: WorkflowCompositionValidationResult;
  attempts: CompositionRepairAttempt[];
};

export async function runCompositionRepairLoop(input: RunCompositionRepairLoopInput): Promise<CompositionRepairLoopResult> {
  const attempts: CompositionRepairAttempt[] = [];
  let latestValidation: WorkflowCompositionValidationResult | null = null;
  for (let attempt = 0; attempt <= input.maxRepairAttempts; attempt += 1) {
    let composition: WorkflowCompositionPlan | undefined;
    let validation: WorkflowCompositionValidationResult;
    try {
      composition = await input.composer.compose({
        goalPrompt: renderRepairGoal(input.goalPrompt, latestValidation),
        candidatePacket: input.candidatePacket,
      });
      validation = await validateWorkflowCompositionPlan(
        input.db,
        input.candidatePacket,
        composition,
        { scope: input.scope },
      );
      attempts.push({ attempt, validation, composition });
    } catch (error) {
      if (!(error instanceof LlmComposerOutputError)) {
        throw error;
      }
      validation = { ok: false, issues: error.issues };
      attempts.push({ attempt, validation });
    }
    if (validation.ok) {
      return { composition: composition ?? null, validation, attempts };
    }
    latestValidation = validation;
  }
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

function renderRepairGoal(goalPrompt: string, latestValidation: WorkflowCompositionValidationResult | null): string {
  if (!latestValidation) {
    return goalPrompt;
  }
  return [
    goalPrompt,
    "",
    "Previous composition failed validation. Repair the composition and return a valid plan.",
    "Latest validation issues:",
    JSON.stringify(latestValidation.issues),
  ].join("\n");
}
