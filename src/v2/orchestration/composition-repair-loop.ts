import type { SouthstarDb } from "../db/postgres.ts";
import type {
  CandidatePacket,
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

export type CompositionRepairAttempt = {
  attempt: number;
  validation: WorkflowCompositionValidationResult;
  composition?: WorkflowCompositionPlan;
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
  let previousAttempt: CompositionRepairAttempt | null = null;
  for (let attempt = 0; attempt <= input.maxRepairAttempts; attempt += 1) {
    let composition: WorkflowCompositionPlan | undefined;
    let validation: WorkflowCompositionValidationResult;
    try {
      input.onProgress?.({ stage: "composer.started", attempt, message: `Starting workflow composition attempt ${attempt + 1}.` });
      composition = await input.composer.compose({
        goalPrompt: renderRepairGoal(input.goalPrompt, previousAttempt, input.runtimeBindingCapabilities),
        goalContract: input.goalContract,
        goalDesignPackage: input.goalDesignPackage,
        candidatePacket: input.candidatePacket,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        onLlmDelta: input.onLlmDelta,
      });
      input.onProgress?.({ stage: "composer.completed", attempt, message: `Workflow composition attempt ${attempt + 1} returned a plan.` });
      validation = await validateWorkflowCompositionPlan(
        input.db,
        input.candidatePacket,
        composition,
        {
          scope: input.scope,
          goalContract: input.goalContract,
          goalDesignPackage: input.goalDesignPackage,
          targetRequirementIds: input.targetRequirementIds,
          runtimeBindingCapabilities: input.runtimeBindingCapabilities,
        },
      );
      input.onProgress?.({
        stage: "validation.completed",
        attempt,
        ok: validation.ok,
        issueCount: validation.issues.length,
        message: validation.ok
          ? `Workflow composition attempt ${attempt + 1} passed validation.`
          : `Workflow composition attempt ${attempt + 1} failed validation.`,
      });
      const currentAttempt = { attempt, validation, composition };
      attempts.push(currentAttempt);
      previousAttempt = currentAttempt;
    } catch (error) {
      if (!(error instanceof LlmComposerOutputError)) {
        throw error;
      }
      validation = { ok: false, issues: error.issues };
      input.onProgress?.({ stage: "composer.failed", attempt, ok: false, issueCount: error.issues.length, message: (error as Error).message });
      input.onProgress?.({ stage: "validation.completed", attempt, ok: false, issueCount: error.issues.length, message: `Workflow composition attempt ${attempt + 1} failed contract validation.` });
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

function renderRepairGoal(
  goalPrompt: string,
  previousAttempt: CompositionRepairAttempt | null,
  runtimeBindingCapabilities?: RuntimeBindingCapabilities,
): string {
  const lines = [goalPrompt];
  if (runtimeBindingCapabilities) {
    lines.push(
      "",
      "Runtime host advertised bindings (authoritative; use exact values):",
      JSON.stringify(runtimeBindingCapabilities),
      "For every advertised field, select one exact listed value in each generated agent profile. Do not invent aliases or fallback bindings.",
    );
  }
  if (!previousAttempt) return lines.join("\n");
  lines.push("", "Previous composition failed validation. Repair the composition and return a valid plan.");
  if (previousAttempt.composition) {
    lines.push("Previous composition JSON:");
    lines.push(JSON.stringify(previousAttempt.composition));
  }
  lines.push("Latest validation issues:");
  lines.push(JSON.stringify(previousAttempt.validation.issues));
  return lines.join("\n");
}
