import { contentHashForPayload } from "../design-library/canonical-json.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  resolveApprovedValidationCandidates,
  type ApprovedValidationCandidatesV1,
} from "./candidate-resolver.ts";
import type {
  CandidateSummary,
  GoalValidationGapV1,
  GoalValidationResolutionV1,
  LibraryObjectSummary,
  RequirementCoveragePreviewV1,
  RequirementValidationBindingV1,
  RequirementValidationMode,
} from "../design-library/types.ts";
import {
  goalContractHash,
  type GoalContractV1,
  type GoalRequirementV1,
} from "./goal-contract.ts";
import {
  goalRequirementDraftHash,
  type GoalAcceptanceCriterionDraftV1,
  type GoalRequirementDraftItemV1,
  type GoalRequirementDraftV1,
} from "./goal-requirement-draft.ts";

export type GoalValidationCandidateRecommendationV1 = {
  artifactRef: string;
  evaluatorRef: string;
  verificationMode: RequirementValidationMode;
  procedureRef: string;
  expectedEvidenceKinds?: string[];
  reason?: string;
  artifactVersionRef?: string;
  evaluatorVersionRef?: string;
};

export type GoalValidationCandidateRankerInputV1 = {
  goalContract: GoalContractV1;
  contractRequirement: GoalRequirementV1;
  requirement: GoalRequirementDraftItemV1;
  artifactCandidates: CandidateSummary[];
  evaluatorCandidatesByArtifact: Record<string, CandidateSummary[]>;
  /** Explicit aliases make the ranker input readable to library authors. */
  artifactContractCandidates: CandidateSummary[];
  evaluatorCandidates: Record<string, CandidateSummary[]>;
};

export type GoalValidationCandidateRankerResultV1 =
  | GoalValidationCandidateRecommendationV1
  | GoalValidationCandidateRecommendationV1[]
  | { recommendations: GoalValidationCandidateRecommendationV1[] };

/**
 * Semantic ranking is deliberately injectable. The resolver never trusts a
 * ranker's refs or evidence claims until they are checked against the
 * approved graph and object state.
 */
export type GoalValidationCandidateRanker = {
  rank(input: GoalValidationCandidateRankerInputV1):
    | GoalValidationCandidateRankerResultV1
    | Promise<GoalValidationCandidateRankerResultV1>;
} | ((input: GoalValidationCandidateRankerInputV1) =>
  | GoalValidationCandidateRankerResultV1
  | Promise<GoalValidationCandidateRankerResultV1>);

export type ResolveGoalValidationInput = {
  goalContract: GoalContractV1;
  requirementDraft: GoalRequirementDraftV1;
  ranker: GoalValidationCandidateRanker;
  scope?: string;
};

export class GoalValidationNotReadyError extends Error {
  readonly code = "goal_validation_not_ready";

  constructor(readonly resolution: GoalValidationResolutionV1) {
    super("Goal Validation is not ready for composition: one or more blocking requirements remain unresolved");
    this.name = "GoalValidationNotReadyError";
  }
}

export type { GoalValidationResolutionV1 } from "../design-library/types.ts";
export type {
  GoalValidationGapV1,
  RequirementCoveragePreviewV1,
  RequirementValidationBindingV1,
} from "../design-library/types.ts";

type RequirementAttempt = {
  binding?: RequirementValidationBindingV1;
  gaps: GoalValidationGapV1[];
  missingKinds: Set<"artifact" | "evaluator" | "capability" | "domain">;
};

export async function resolveGoalValidationPg(
  db: SouthstarDb,
  input: ResolveGoalValidationInput,
): Promise<GoalValidationResolutionV1> {
  const candidates = await resolveApprovedValidationCandidates(db, { scope: input.scope });
  const artifactCandidates = candidates.artifactContracts.map((object) => candidateSummary(object, "approved artifact contract"));
  const evaluatorCandidatesByArtifact = Object.fromEntries(
    Object.entries(candidates.evaluatorProfilesByArtifact)
      .map(([artifactRef, evaluators]) => [
        artifactRef,
        evaluators.map((object) => candidateSummary(object, `approved evaluator for ${artifactRef}`)),
      ]),
  );
  const contractRequirements = new Map(input.goalContract.requirements.map((requirement) => [requirement.id, requirement]));
  const draftRequirements = new Map(input.requirementDraft.requirements.map((requirement) => [requirement.id, requirement]));
  const previews: RequirementCoveragePreviewV1[] = [];
  const bindings: RequirementValidationBindingV1[] = [];
  const gaps: GoalValidationGapV1[] = [];

  for (const contractRequirement of input.goalContract.requirements) {
    const requirement = draftRequirements.get(contractRequirement.id);
    if (!requirement || requirement.status === "superseded") {
      gaps.push(gap({
        kind: "manual",
        requirementId: contractRequirement.id,
        blocking: contractRequirement.blocking,
        message: `Goal Requirement ${contractRequirement.id} is not present as an active draft requirement`,
      }));
      previews.push(emptyPreview(contractRequirement, "missing", ["artifact", "evaluator"]));
      continue;
    }

    const criteria = criteriaMapping(contractRequirement, requirement);
    if (criteria.gaps.length > 0) {
      gaps.push(...criteria.gaps.map((item) => gap({
        kind: "criteria",
        requirementId: contractRequirement.id,
        criterionIds: item.criterionIds,
        blocking: contractRequirement.blocking,
        message: item.message,
      })));
    }

    const rankingInput: GoalValidationCandidateRankerInputV1 = {
      goalContract: input.goalContract,
      contractRequirement,
      requirement,
      artifactCandidates,
      evaluatorCandidatesByArtifact,
      artifactContractCandidates: artifactCandidates,
      evaluatorCandidates: evaluatorCandidatesByArtifact,
    };
    const ranked = await rank(input.ranker, rankingInput);
    const artifactPreview = artifactCandidates;
    const evaluatorPreview = uniqueCandidates(
      Object.values(evaluatorCandidatesByArtifact).flat(),
    );
    const attempt = criteria.gaps.length > 0
      ? { gaps: [] as GoalValidationGapV1[], missingKinds: new Set<"artifact" | "evaluator" | "capability" | "domain">() }
      : await resolveRequirementAttempt({
      contractRequirement,
      requirement,
      criterionIds: criteria.criterionIds,
      candidates,
      rankings: ranked,
    });
    gaps.push(...attempt.gaps);
    if (attempt.binding) bindings.push(attempt.binding);
    const missingKinds = new Set(attempt.missingKinds);
    if (artifactPreview.length === 0) missingKinds.add("artifact");
    if (evaluatorPreview.length === 0) missingKinds.add("evaluator");
    const status = attempt.binding
      ? attempt.binding.verificationMode === "human_approval" ? "manual" : "ready"
      : artifactPreview.length === 0 || evaluatorPreview.length === 0 ? "missing" : "partial";
    previews.push({
      schemaVersion: "southstar.requirement_coverage_preview.v1",
      requirementId: contractRequirement.id,
      blocking: contractRequirement.blocking,
      status,
      artifactCandidates: artifactPreview.map(toCoverageCandidate),
      evaluatorCandidates: evaluatorPreview.map(toCoverageCandidate),
      missingKinds: [...missingKinds].sort(),
      criterionIds: criteria.criterionIds,
      acceptanceCriteria: [...contractRequirement.acceptanceCriteria],
    });
  }

  for (const requirement of input.requirementDraft.requirements) {
    if (requirement.status === "superseded" || contractRequirements.has(requirement.id)) continue;
    gaps.push(gap({
      kind: "manual",
      requirementId: requirement.id,
      criterionIds: requirement.acceptanceCriteria.map((criterion) => criterion.id),
      blocking: requirement.blocking,
      message: `Draft Requirement ${requirement.id} is not represented by the confirmed Goal Contract`,
    }));
  }

  const resolvedGaps = uniqueGaps(gaps).map((item) => {
    if (item.candidateRefs.length > 0) return item;
    const preview = previews.find((candidate) => candidate.requirementId === item.requirementId);
    const previewArtifactRefs = preview?.artifactCandidates.map((candidate) => candidate.ref) ?? [];
    const previewEvaluatorRefs = preview?.evaluatorCandidates.map((candidate) => candidate.ref) ?? [];
    const candidateRefs = item.kind === "artifact"
      ? previewArtifactRefs.length > 0 ? previewArtifactRefs : candidates.artifactContracts.map((candidate) => candidate.objectKey)
      : item.kind === "evaluator" || item.kind === "edge" || item.kind === "procedure" || item.kind === "evidence" || item.kind === "independence"
        ? previewEvaluatorRefs.length > 0 ? previewEvaluatorRefs : candidates.evaluatorProfiles.map((candidate) => candidate.objectKey)
        : [];
    return candidateRefs.length > 0 ? { ...item, candidateRefs } : item;
  });
  const resolutionWithoutHash = {
    schemaVersion: "southstar.goal_validation_resolution.v1" as const,
    goalContractHash: goalContractHash(input.goalContract),
    requirementDraftHash: input.requirementDraft.draftHash || goalRequirementDraftHash(input.requirementDraft),
    previews,
    bindings,
    gaps: resolvedGaps,
    ready: false,
  };
  const blockingRequirementIds = new Set(
    previews.filter((preview) => preview.blocking).map((preview) => preview.requirementId),
  );
  const bindingRequirementIds = new Set(bindings.map((binding) => binding.requirementId));
  resolutionWithoutHash.ready = !resolutionWithoutHash.gaps.some((item) => item.blocking)
    && previews.filter((preview) => blockingRequirementIds.has(preview.requirementId)).every((preview) =>
      preview.status === "ready" && bindingRequirementIds.has(preview.requirementId));
  return {
    ...resolutionWithoutHash,
    resolutionHash: contentHashForPayload(resolutionWithoutHash),
  };
}

export function goalValidationResolutionReady(resolution: GoalValidationResolutionV1): boolean {
  return resolution.ready && !resolution.gaps.some((gap) => gap.blocking);
}

export function assertGoalValidationResolutionReady(resolution: GoalValidationResolutionV1): void {
  if (!goalValidationResolutionReady(resolution)) throw new GoalValidationNotReadyError(resolution);
}

async function resolveRequirementAttempt(input: {
  contractRequirement: GoalRequirementV1;
  requirement: GoalRequirementDraftItemV1;
  criterionIds: string[];
  candidates: ApprovedValidationCandidatesV1;
  rankings: GoalValidationCandidateRecommendationV1[];
}): Promise<RequirementAttempt> {
  const missingKinds = new Set<"artifact" | "evaluator" | "capability" | "domain">();
  const gaps: GoalValidationGapV1[] = [];
  if (input.rankings.length === 0) {
    if (input.candidates.artifactContracts.length === 0) missingKinds.add("artifact");
    if (Object.values(input.candidates.evaluatorProfilesByArtifact).some((items) => items.length > 0) === false) {
      missingKinds.add("evaluator");
    }
    gaps.push(gap({
      kind: "manual",
      requirementId: input.contractRequirement.id,
      criterionIds: input.criterionIds,
      blocking: input.contractRequirement.blocking,
      message: "No candidate ranking recommendation was returned for this requirement",
    }));
    return { gaps, missingKinds };
  }

  for (const recommendation of input.rankings) {
    const artifact = input.candidates.artifactContracts.find((candidate) => candidate.objectKey === recommendation.artifactRef);
    const evaluator = input.candidates.evaluatorProfiles.find((candidate) => candidate.objectKey === recommendation.evaluatorRef);
    if (!artifact) {
      missingKinds.add("artifact");
      gaps.push(gap({
        kind: "artifact",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: recommendation.artifactRef,
        blocking: input.contractRequirement.blocking,
        message: `Artifact candidate is not in the approved closed set: ${recommendation.artifactRef}`,
      }));
    }
    if (!evaluator) {
      missingKinds.add("evaluator");
      gaps.push(gap({
        kind: "evaluator",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: recommendation.evaluatorRef,
        blocking: input.contractRequirement.blocking,
        message: `Evaluator candidate is not in the approved closed set: ${recommendation.evaluatorRef}`,
      }));
    }
    if (!artifact || !evaluator) continue;
    if (artifact.headVersionId === null || (recommendation.artifactVersionRef !== undefined && recommendation.artifactVersionRef !== artifact.headVersionId)) {
      gaps.push(gap({
        kind: "version",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: recommendation.artifactRef,
        blocking: input.contractRequirement.blocking,
        message: `Artifact candidate does not match its current approved version: ${recommendation.artifactRef}`,
      }));
      continue;
    }
    const artifactContractIssue = validateArtifactContract(artifact);
    if (artifactContractIssue) {
      missingKinds.add("artifact");
      gaps.push(gap({
        kind: "artifact",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: recommendation.artifactRef,
        blocking: input.contractRequirement.blocking,
        message: artifactContractIssue,
      }));
      continue;
    }
    if (evaluator.headVersionId === null || (recommendation.evaluatorVersionRef !== undefined && recommendation.evaluatorVersionRef !== evaluator.headVersionId)) {
      gaps.push(gap({
        kind: "version",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: recommendation.evaluatorRef,
        blocking: input.contractRequirement.blocking,
        message: `Evaluator candidate does not match its current approved version: ${recommendation.evaluatorRef}`,
      }));
      continue;
    }
    const linkedEvaluator = input.candidates.evaluatorProfilesByArtifact[artifact.objectKey]?.some(
      (candidate) => candidate.objectKey === evaluator.objectKey,
    ) ?? false;
    if (!linkedEvaluator) {
      missingKinds.add("evaluator");
      gaps.push(gap({
        kind: "edge",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: recommendation.evaluatorRef,
        blocking: input.contractRequirement.blocking,
        message: `Evaluator ${recommendation.evaluatorRef} has no active version-compatible validates_artifact edge to ${artifact.objectKey}`,
      }));
      continue;
    }
    const bindingResult = buildBinding({
      contractRequirement: input.contractRequirement,
      requirement: input.requirement,
      criterionIds: input.criterionIds,
      artifact,
      evaluator,
      recommendation,
    });
    if (bindingResult.gaps.length > 0 || !bindingResult.binding) {
      gaps.push(...bindingResult.gaps);
      if (bindingResult.missingKinds) for (const kind of bindingResult.missingKinds) missingKinds.add(kind);
      continue;
    }
    return { binding: bindingResult.binding, gaps, missingKinds };
  }
  return { gaps: uniqueGaps(gaps), missingKinds };
}

function buildBinding(input: {
  contractRequirement: GoalRequirementV1;
  requirement: GoalRequirementDraftItemV1;
  criterionIds: string[];
  artifact: LibraryObjectSummary;
  evaluator: LibraryObjectSummary;
  recommendation: GoalValidationCandidateRecommendationV1;
}): { binding?: RequirementValidationBindingV1; gaps: GoalValidationGapV1[]; missingKinds?: Set<"artifact" | "evaluator" | "capability" | "domain"> } {
  const state = input.evaluator.state;
  const modes = stringArray(state.verificationModes ?? state.supportedVerificationModes);
  if (!modes.includes(input.recommendation.verificationMode)) {
    return {
      gaps: [gap({
        kind: "procedure",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: input.evaluator.objectKey,
        blocking: input.contractRequirement.blocking,
        message: `Evaluator ${input.evaluator.objectKey} does not support verification mode ${input.recommendation.verificationMode}`,
      })],
    };
  }
  const procedure = procedureById(state, input.recommendation.procedureRef);
  if (!procedure) {
    return {
      gaps: [gap({
        kind: "procedure",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: input.recommendation.procedureRef,
        blocking: input.contractRequirement.blocking,
        message: `Evaluator ${input.evaluator.objectKey} has no approved verification procedure ${input.recommendation.procedureRef}`,
      })],
    };
  }
  const procedureMode = typeof procedure.verificationMode === "string"
    ? procedure.verificationMode
    : typeof procedure.checkKind === "string"
      ? procedure.checkKind
      : undefined;
  if (procedureMode !== input.recommendation.verificationMode) {
    return {
      gaps: [gap({
        kind: "procedure",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: input.recommendation.procedureRef,
        blocking: input.contractRequirement.blocking,
        message: `Verification procedure ${input.recommendation.procedureRef} is not compatible with ${input.recommendation.verificationMode}`,
      })],
    };
  }
  if (state.independencePolicy !== "independent" && state.independence !== "independent") {
    return {
      gaps: [gap({
        kind: "independence",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: input.evaluator.objectKey,
        blocking: input.contractRequirement.blocking,
        message: `Evaluator ${input.evaluator.objectKey} does not declare an independent evaluation policy`,
      })],
    };
  }
  const expectedEvidenceKinds = uniqueStrings(
    input.requirement.acceptanceCriteria.flatMap((criterion) => criterion.evidenceIntent),
  );
  const rankerEvidenceKinds = uniqueStrings(input.recommendation.expectedEvidenceKinds ?? []);
  const inventedEvidenceKinds = rankerEvidenceKinds.filter((kind) => !expectedEvidenceKinds.includes(kind));
  const procedureEvidenceKinds = uniqueStrings(procedure.allowedEvidenceKinds);
  const evaluatorEvidenceKinds = uniqueStrings(state.evidenceKinds);
  const artifactEvidenceKinds = uniqueStrings([
    ...stringArray(input.artifact.state.evidenceKinds),
    ...stringArray(input.artifact.state.acceptableEvidenceKinds),
  ]);
  const resultSchemaRef = typeof state.resultSchemaRef === "string" ? state.resultSchemaRef.trim() : "";
  const unsupportedByProcedure = expectedEvidenceKinds.filter((kind) => !procedureEvidenceKinds.includes(kind));
  const unsupportedByEvaluator = expectedEvidenceKinds.filter((kind) => !evaluatorEvidenceKinds.includes(kind));
  const unsupportedByArtifact = expectedEvidenceKinds.filter((kind) => !artifactEvidenceKinds.includes(kind));
  if (!resultSchemaRef || procedureEvidenceKinds.length === 0 || evaluatorEvidenceKinds.length === 0 || artifactEvidenceKinds.length === 0
    || inventedEvidenceKinds.length > 0 || unsupportedByProcedure.length > 0 || unsupportedByEvaluator.length > 0 || unsupportedByArtifact.length > 0) {
    const details = [
      !resultSchemaRef ? "evaluator resultSchemaRef is missing" : "",
      procedureEvidenceKinds.length === 0 ? "verification procedure allowedEvidenceKinds is missing" : "",
      evaluatorEvidenceKinds.length === 0 ? "evaluator evidenceKinds is missing" : "",
      artifactEvidenceKinds.length === 0 ? "artifact evidenceKinds is missing" : "",
      inventedEvidenceKinds.length > 0 ? `ranker invented evidence kinds ${inventedEvidenceKinds.join(", ")}` : "",
      unsupportedByProcedure.length > 0 ? `procedure does not allow ${unsupportedByProcedure.join(", ")}` : "",
      unsupportedByEvaluator.length > 0 ? `evaluator does not allow ${unsupportedByEvaluator.join(", ")}` : "",
      unsupportedByArtifact.length > 0 ? `artifact does not accept ${unsupportedByArtifact.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    return {
      gaps: [gap({
        kind: "evidence",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: input.recommendation.procedureRef,
        blocking: input.contractRequirement.blocking,
        message: `Evidence compatibility failed: ${details}`,
      })],
    };
  }
  const criterionChecks = input.requirement.acceptanceCriteria.map((criterion) => ({
    criterionId: criterion.id,
    procedureRef: input.recommendation.procedureRef,
    expectedEvidenceKinds: uniqueStrings(criterion.evidenceIntent),
  }));
  const bindingWithoutId = {
    schemaVersion: "southstar.requirement_validation_binding.v1" as const,
    requirementId: input.contractRequirement.id,
    criterionIds: [...input.criterionIds],
    acceptanceCriteria: [...input.contractRequirement.acceptanceCriteria],
    artifactContractRefs: [input.artifact.objectKey],
    artifactContractVersionRefs: [input.artifact.headVersionId!],
    evaluatorProfileRef: input.evaluator.objectKey,
    evaluatorProfileVersionRef: input.evaluator.headVersionId!,
    verificationMode: input.recommendation.verificationMode,
    criterionChecks,
    requiredEvidenceKinds: expectedEvidenceKinds,
    independence: "independent" as const,
    failureClassifications: stringArray(input.evaluator.state.failureClassifications),
  };
  return {
    gaps: [],
    binding: {
      ...bindingWithoutId,
      id: `binding-${contentHashForPayload(bindingWithoutId).slice(0, 16)}`,
    },
  };
}

function criteriaMapping(
  contractRequirement: GoalRequirementV1,
  requirement: GoalRequirementDraftItemV1,
): { criterionIds: string[]; gaps: Array<{ criterionIds: string[]; message: string }> } {
  const byStatement = new Map<string, GoalAcceptanceCriterionDraftV1[]>();
  for (const criterion of requirement.acceptanceCriteria) {
    const key = normalize(criterion.statement);
    const existing = byStatement.get(key) ?? [];
    existing.push(criterion);
    byStatement.set(key, existing);
  }
  const criterionIds: string[] = [];
  const gaps: Array<{ criterionIds: string[]; message: string }> = [];
  for (const statement of contractRequirement.acceptanceCriteria) {
    const matches = byStatement.get(normalize(statement)) ?? [];
    const criterion = matches.shift();
    if (!criterion) {
      gaps.push({ criterionIds: [], message: `Confirmed acceptance criterion is not preserved in the Requirement Draft: ${statement}` });
      continue;
    }
    criterionIds.push(criterion.id);
  }
  const expectedCount = contractRequirement.acceptanceCriteria.length;
  if (criterionIds.length !== expectedCount || requirement.acceptanceCriteria.length !== expectedCount) {
    gaps.push({
      criterionIds,
      message: `Requirement acceptance criteria drifted between draft and confirmed contract (draft=${requirement.acceptanceCriteria.length}, contract=${expectedCount})`,
    });
  }
  return { criterionIds: uniqueStrings(criterionIds), gaps };
}

async function rank(
  ranker: GoalValidationCandidateRanker,
  input: GoalValidationCandidateRankerInputV1,
): Promise<GoalValidationCandidateRecommendationV1[]> {
  const result = typeof ranker === "function" ? await ranker(input) : await ranker.rank(input);
  const recommendations = Array.isArray(result)
    ? result
    : isRecommendation(result)
      ? [result]
      : result.recommendations;
  if (!Array.isArray(recommendations)) return [];
  return recommendations.filter(isRecommendation).slice(0, 16);
}

function isRecommendation(value: unknown): value is GoalValidationCandidateRecommendationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.artifactRef === "string"
    && typeof item.evaluatorRef === "string"
    && typeof item.verificationMode === "string"
    && ["deterministic", "browser_interaction", "semantic_review", "human_approval"].includes(item.verificationMode)
    && typeof item.procedureRef === "string";
}

function validateArtifactContract(object: LibraryObjectSummary): string | undefined {
  const state = object.state;
  if (typeof state.artifactType !== "string" || state.artifactType.trim().length === 0) {
    return `Approved artifact ${object.objectKey} is missing artifactType`;
  }
  if (!Array.isArray(state.validationRules) && typeof state.schemaRef !== "string" && !Array.isArray(state.requiredFields)) {
    return `Approved artifact ${object.objectKey} is missing validationRules, schemaRef, or requiredFields`;
  }
  return undefined;
}

function procedureById(state: Record<string, unknown>, procedureRef: string): Record<string, unknown> | undefined {
  const procedures = Array.isArray(state.verificationProcedures) ? state.verificationProcedures : [];
  return procedures.find((value): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).id === procedureRef),
  );
}

function candidateSummary(object: LibraryObjectSummary, reason: string): CandidateSummary {
  const displayName = typeof object.state.title === "string"
    ? object.state.title
    : typeof object.state.displayName === "string"
      ? object.state.displayName
      : object.objectKey;
  return {
    ref: object.objectKey,
    versionRef: object.headVersionId,
    kind: object.objectKind,
    displayName,
    state: object.state,
    reason,
  };
}

function toCoverageCandidate(candidate: CandidateSummary): { ref: string; versionRef: string; reason: string } {
  if (!candidate.versionRef) throw new Error(`approved candidate missing version ref: ${candidate.ref}`);
  return { ref: candidate.ref, versionRef: candidate.versionRef, reason: candidate.reason };
}

function emptyPreview(
  requirement: GoalRequirementV1,
  status: RequirementCoveragePreviewV1["status"],
  missingKinds: RequirementCoveragePreviewV1["missingKinds"],
): RequirementCoveragePreviewV1 {
  return {
    schemaVersion: "southstar.requirement_coverage_preview.v1",
    requirementId: requirement.id,
    blocking: requirement.blocking,
    status,
    artifactCandidates: [],
    evaluatorCandidates: [],
    missingKinds,
    criterionIds: [],
    acceptanceCriteria: [...requirement.acceptanceCriteria],
  };
}

function gap(input: {
  kind: GoalValidationGapV1["kind"];
  requirementId: string;
  criterionIds?: string[];
  requestedRef?: string;
  blocking: boolean;
  message: string;
  candidateRefs?: string[];
}): GoalValidationGapV1 {
  return {
    schemaVersion: "southstar.goal_validation_gap.v1",
    kind: input.kind,
    requirementId: input.requirementId,
    criterionIds: uniqueStrings(input.criterionIds ?? []),
    ...(input.requestedRef !== undefined ? { requestedRef: input.requestedRef } : {}),
    blocking: input.blocking,
    message: input.message,
    candidateRefs: uniqueStrings(input.candidateRefs ?? []),
  };
}

function uniqueGaps(values: GoalValidationGapV1[]): GoalValidationGapV1[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = contentHashForPayload(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueCandidates(values: CandidateSummary[]): CandidateSummary[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.ref)) return false;
    seen.add(value.ref);
    return true;
  }).sort((left, right) => left.ref.localeCompare(right.ref));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
