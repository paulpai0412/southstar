import type { SouthstarDb } from "../db/postgres.ts";
import type { GoalValidationResolutionV1 } from "../design-library/types.ts";
import type { LibraryImportLlmProvider } from "../design-library/importers/library-llm-import-analyzer.ts";
import { goalContractHash, type GoalContractV1 } from "./goal-contract.ts";
import type { GoalRequirementDraftV1 } from "./goal-requirement-draft.ts";
import {
  resolveGoalValidationPg,
  type GoalValidationCandidateRankerInputV1,
  type GoalValidationCandidateRecommendationV1,
} from "./goal-validation-resolver.ts";

export type GoalValidationResolver = (
  db: SouthstarDb,
  input: { goalContract: GoalContractV1; requirementDraft: GoalRequirementDraftV1; scope?: string },
) => Promise<GoalValidationResolutionV1>;

export class GoalValidationProviderNotConfiguredError extends Error {
  readonly code = "goal_validation_provider_not_configured";
  readonly status = 503;
  readonly readiness = {
    ready: false as const,
    missing: ["libraryImportLlmProvider"] as const,
    action: "Configure the runtime Library LLM provider, then retry Goal validation resolution.",
  };

  constructor() {
    super("Goal validation resolution requires a configured Library LLM provider");
    this.name = "GoalValidationProviderNotConfiguredError";
  }
}

export function goalValidationResolverFromLibraryLlm(provider?: LibraryImportLlmProvider): GoalValidationResolver {
  if (!provider) throw new GoalValidationProviderNotConfiguredError();
  return async (db, input) => await resolveGoalValidationPg(db, {
    ...input,
    ranker: async (rankInput) => await rankGoalValidationCandidatesWithLlm(provider, rankInput),
  });
}

export function buildGoalValidationImportRequest(input: {
  goalContract: GoalContractV1;
  goalContractHash: string;
  requirementDraft: GoalRequirementDraftV1;
  resolution: GoalValidationResolutionV1;
}): { payload: Record<string, unknown>; prompt: string } {
  const gapRequirementIds = new Set(input.resolution.gaps.map((gap) => gap.requirementId));
  const draftById = new Map(input.requirementDraft.requirements.map((requirement) => [requirement.id, requirement]));
  const payload = {
    schemaVersion: "southstar.goal_validation_import_request.v1",
    goalContractHash: input.goalContractHash,
    goalRequirementDraftHash: input.requirementDraft.draftHash,
    resolutionHash: input.resolution.resolutionHash,
    gaps: input.resolution.gaps.map((gap) => ({
      kind: gap.kind,
      requirementId: gap.requirementId,
      criterionIds: gap.criterionIds,
      ...(gap.requestedRef ? { requestedRef: gap.requestedRef } : {}),
      blocking: gap.blocking,
      message: gap.message,
      boundedExistingCandidateRefs: [...new Set(gap.candidateRefs)].slice(0, 25),
    })),
    requirements: input.goalContract.requirements
      .filter((requirement) => gapRequirementIds.has(requirement.id))
      .map((requirement) => ({
        id: requirement.id,
        statement: requirement.statement,
        acceptanceCriteria: requirement.acceptanceCriteria,
        expectedOutcomeArtifacts: draftById.get(requirement.id)?.expectedOutcomeArtifacts ?? [],
        criterionIntent: draftById.get(requirement.id)?.acceptanceCriteria.map((criterion) => ({
          id: criterion.id,
          statement: criterion.statement,
          evidenceIntent: criterion.evidenceIntent,
        })) ?? [],
        verificationIntent: draftById.get(requirement.id)?.verificationIntent ?? [],
      })),
  };
  return {
    payload,
    prompt: [
      "Create the smallest reusable Library candidate change set needed to close only the confirmed Goal validation gaps in the source document.",
      "Candidates may be artifact contracts and evaluator profiles required by those gaps, including their necessary validatesArtifactRefs relationship.",
      "Do not create unrelated domain, capability, agent, skill, tool, MCP, workflow, or Goal-specific filename candidates.",
      "Preserve the supplied Requirement and criterion meaning. Do not invent Acceptance Criteria or evidence kinds.",
      "Prefer a boundedExistingCandidateRef when it is compatible; otherwise propose reusable domain-scoped candidates.",
      `ConfirmedGapCount: ${input.resolution.gaps.length}`,
    ].join("\n"),
  };
}

async function rankGoalValidationCandidatesWithLlm(
  provider: LibraryImportLlmProvider,
  input: GoalValidationCandidateRankerInputV1,
): Promise<GoalValidationCandidateRecommendationV1[]> {
  const prompt = [
    "Rank only the supplied approved artifact contracts and evaluator profiles for one confirmed Goal Requirement.",
    "Return exactly one JSON object and no markdown: {\"recommendations\":[{\"artifactRef\":\"artifact.example\",\"evaluatorRef\":\"evaluator.example\",\"verificationMode\":\"deterministic\",\"procedureRef\":\"procedure.example\",\"expectedEvidenceKinds\":[\"test-result\"],\"reason\":\"...\",\"artifactVersionRef\":\"...\",\"evaluatorVersionRef\":\"...\"}]}",
    "Allowed verificationMode values: deterministic, browser_interaction, semantic_review, human_approval.",
    "Use only refs and versionRefs supplied below. expectedEvidenceKinds must be a subset of the confirmed criterion evidenceIntent values. Return an empty recommendations array when no compatible approved pair exists.",
    "Do not create, rename, approve, or repair Library objects. Do not add Requirements or Acceptance Criteria.",
    `GoalContractHash: ${goalContractHash(input.goalContract)}`,
    `Requirement: ${JSON.stringify(input.contractRequirement)}`,
    `RequirementDraft: ${JSON.stringify(input.requirement)}`,
    `ApprovedArtifactCandidates: ${JSON.stringify(input.artifactCandidates)}`,
    `ApprovedEvaluatorCandidatesByArtifact: ${JSON.stringify(input.evaluatorCandidatesByArtifact)}`,
  ].join("\n");
  const raw = await provider({
    prompt,
    scope: input.goalContract.domain,
    documents: [],
    requestPrompt: `Resolve validation for confirmed requirement ${input.contractRequirement.id}`,
  });
  const value = unwrapLlmStructuredOutput(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Goal validation ranker must return one JSON object");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, new Set(["recommendations"]), "Goal validation ranker result");
  if (!Array.isArray(record.recommendations)) throw new Error("Goal validation ranker recommendations must be an array");
  return record.recommendations.map((item, index) => normalizeGoalValidationRecommendation(item, index));
}

function normalizeGoalValidationRecommendation(value: unknown, index: number): GoalValidationCandidateRecommendationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Goal validation recommendation ${index} must be an object`);
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(record, new Set([
    "artifactRef", "evaluatorRef", "verificationMode", "procedureRef", "expectedEvidenceKinds", "reason",
    "artifactVersionRef", "evaluatorVersionRef",
  ]), `Goal validation recommendation ${index}`);
  const verificationMode = requiredString(record.verificationMode, "verificationMode", String(index));
  if (!["deterministic", "browser_interaction", "semantic_review", "human_approval"].includes(verificationMode)) {
    throw new Error(`Goal validation recommendation ${index} has unsupported verificationMode: ${verificationMode}`);
  }
  const evidenceKinds = record.expectedEvidenceKinds === undefined
    ? undefined
    : stringArray(record.expectedEvidenceKinds, `Goal validation recommendation ${index}.expectedEvidenceKinds`);
  return {
    artifactRef: requiredString(record.artifactRef, "artifactRef", String(index)),
    evaluatorRef: requiredString(record.evaluatorRef, "evaluatorRef", String(index)),
    verificationMode: verificationMode as GoalValidationCandidateRecommendationV1["verificationMode"],
    procedureRef: requiredString(record.procedureRef, "procedureRef", String(index)),
    ...(evidenceKinds ? { expectedEvidenceKinds: evidenceKinds } : {}),
    ...(optionalString(record.reason) ? { reason: optionalString(record.reason) } : {}),
    ...(optionalString(record.artifactVersionRef) ? { artifactVersionRef: optionalString(record.artifactVersionRef) } : {}),
    ...(optionalString(record.evaluatorVersionRef) ? { evaluatorVersionRef: optionalString(record.evaluatorVersionRef) } : {}),
  };
}

function unwrapLlmStructuredOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.text === "string") return JSON.parse(record.text);
  if (typeof record.output === "string") return JSON.parse(record.output);
  if (record.planBundle !== undefined) return typeof record.planBundle === "string" ? JSON.parse(record.planBundle) : record.planBundle;
  const { sessionId: _sessionId, session_id: _sessionIdSnake, piSessionId: _piSessionId, pi_session_id: _piSessionIdSnake, ...output } = record;
  return output;
}

function assertExactKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value as string[])];
}

function requiredString(value: unknown, field: string, owner: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is missing from ${owner}`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
