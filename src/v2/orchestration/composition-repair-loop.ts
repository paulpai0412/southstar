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
  let previousAttempt: CompositionRepairAttempt | null = null;
  for (let attempt = 0; attempt <= input.maxRepairAttempts; attempt += 1) {
    let composition: WorkflowCompositionPlan | undefined;
    let validation: WorkflowCompositionValidationResult;
    try {
      composition = await input.composer.compose({
        goalPrompt: renderRepairGoal(input.goalPrompt, previousAttempt),
        candidatePacket: input.candidatePacket,
      });
      validation = await validateWorkflowCompositionPlan(
        input.db,
        input.candidatePacket,
        composition,
        { scope: input.scope },
      );
      const currentAttempt = { attempt, validation, composition };
      attempts.push(currentAttempt);
      previousAttempt = currentAttempt;
    } catch (error) {
      if (!(error instanceof LlmComposerOutputError)) {
        throw error;
      }
      validation = { ok: false, issues: error.issues };
      const currentAttempt = { attempt, validation };
      attempts.push(currentAttempt);
      previousAttempt = currentAttempt;
    }
    if (validation.ok) {
      return { composition: composition ?? null, validation, attempts };
    }
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

function renderRepairGoal(goalPrompt: string, previousAttempt: CompositionRepairAttempt | null): string {
  if (!previousAttempt) {
    return goalPrompt;
  }
  const lines = [
    goalPrompt,
    "",
    "Previous composition failed validation. Repair the composition and return a valid plan.",
  ];
  if (previousAttempt.composition) {
    lines.push("Previous composition JSON:");
    lines.push(JSON.stringify(previousAttempt.composition));
  }
  lines.push("Latest validation issues:");
  lines.push(JSON.stringify(previousAttempt.validation.issues));
  return lines.join("\n");
}
