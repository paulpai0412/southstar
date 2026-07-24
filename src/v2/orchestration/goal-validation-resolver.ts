import { contentHashForPayload } from "../design-library/canonical-json.ts";
import {
  normalizeLibraryImportCandidateKindFields,
  REQUIREMENT_EVALUATOR_RESULT_SCHEMA_REF,
} from "../design-library/importers/library-import-candidate-schema.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { criterionValidationCheckKey } from "../design-library/types.ts";
import {
  resolveApprovedValidationCandidates,
  type ApprovedValidationCandidatesV1,
} from "./candidate-resolver.ts";
import type {
  CandidateSummary,
  CriterionValidationBindingV1,
  GoalValidationGapV1,
  GoalValidationResolutionV2,
  LibraryObjectSummary,
  RequirementCoveragePreviewV1,
  RequirementValidationBindingV3,
  RequirementValidationMode,
} from "../design-library/types.ts";
import {
  goalContractHash,
  type GoalContractV1,
  type GoalCriterionV1,
  type GoalRequirementV1,
} from "./goal-contract.ts";
import {
  goalRequirementDraftHash,
  type GoalAcceptanceCriterionDraftV1,
  type GoalRequirementDraftItemV1,
  type GoalRequirementDraftV1,
} from "./goal-requirement-draft.ts";
import { missingSemanticTags, normalizeSemanticTags } from "./semantic-tags.ts";

export type GoalValidationCandidateRecommendationV1 = {
  artifactRef: string;
  evaluatorRef: string;
  verificationMode: RequirementValidationMode;
  procedureRef: string;
  typedParameters?: Record<string, unknown>;
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
  progress?: GoalValidationProgressListener;
};

export type GoalValidationProgressListener = (progress: {
  event: string;
  data: Record<string, unknown>;
}) => void;

export class GoalValidationNotReadyError extends Error {
  readonly code = "goal_validation_not_ready";

  constructor(readonly resolution: GoalValidationResolutionV2) {
    super("Goal Validation is not ready for composition: one or more blocking requirements remain unresolved");
    this.name = "GoalValidationNotReadyError";
  }
}

export type { GoalValidationResolutionV2 } from "../design-library/types.ts";
export type {
  GoalValidationGapV1,
  RequirementCoveragePreviewV1,
  RequirementValidationBindingV3,
} from "../design-library/types.ts";

type RequirementAttempt = {
  binding?: CriterionValidationBindingV1;
  gaps: GoalValidationGapV1[];
  missingKinds: Set<"artifact" | "evaluator" | "capability" | "domain">;
};

export async function resolveGoalValidationPg(
  db: SouthstarDb,
  input: ResolveGoalValidationInput,
): Promise<GoalValidationResolutionV2> {
  const candidates = await resolveApprovedValidationCandidates(db, { scope: input.scope });
  return await resolveGoalValidationWithCandidates(input, candidates);
}

/**
 * Resolve Goal validation against an explicit approved candidate set.
 *
 * The ordinary runtime path loads that set from Postgres. Library import uses
 * the same resolver with a virtual overlay so a proposal must prove that it
 * closes the current Goal before it can be shown for approval.
 */
export async function resolveGoalValidationWithCandidates(
  input: ResolveGoalValidationInput,
  candidates: ApprovedValidationCandidatesV1,
): Promise<GoalValidationResolutionV2> {
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
  const bindings: RequirementValidationBindingV3[] = [];
  const gaps: GoalValidationGapV1[] = [];
  const activeRequirements = input.goalContract.requirements;
  input.progress?.({
    event: "goal.validation.candidates.loaded",
    data: {
      artifactCandidateCount: artifactCandidates.length,
      evaluatorCandidateCount: Object.values(evaluatorCandidatesByArtifact).flat().length,
      requirementCount: activeRequirements.length,
    },
  });

  const requirementResults = await Promise.all(activeRequirements.map(async (contractRequirement, requirementIndex) => {
    input.progress?.({
      event: "goal.validation.requirement.started",
      data: {
        requirementId: contractRequirement.id,
        requirementIndex,
        requirementNumber: requirementIndex + 1,
        requirementCount: activeRequirements.length,
      },
    });
    const requirement = draftRequirements.get(contractRequirement.id);
    if (!requirement || requirement.status === "superseded") {
      const missingGap = gap({
        kind: "manual",
        requirementId: contractRequirement.id,
        blocking: contractRequirement.acceptanceCriteria.some((criterion) => criterion.blocking),
        message: `Goal Requirement ${contractRequirement.id} is not present as an active draft requirement`,
      });
      const preview = emptyPreview(contractRequirement, "missing", ["artifact", "evaluator"]);
      input.progress?.({
        event: "goal.validation.requirement.completed",
        data: {
          requirementId: contractRequirement.id,
          requirementIndex,
          requirementNumber: requirementIndex + 1,
          requirementCount: activeRequirements.length,
          status: "missing",
          gapCount: 1,
        },
      });
      return { gaps: [missingGap], preview };
    }

    const criteria = criteriaMapping(contractRequirement, requirement);
    const assuranceGaps = contractRequirement.acceptanceCriteria
      .filter((criterion) => criterion.requiredAssurance.length !== 1)
      .map((criterion) => ({
        criterionIds: [criterion.id],
        message: `Criterion ${criterion.id}@${criterion.version} must declare exactly one required assurance; split compound assurance into separate Criteria`,
      }));
    const criteriaGaps = [...criteria.gaps, ...assuranceGaps].map((item) => gap({
      kind: "criteria",
      requirementId: contractRequirement.id,
      criterionIds: item.criterionIds,
      blocking: item.criterionIds.length === 0
        ? contractRequirement.acceptanceCriteria.some((criterion) => criterion.blocking)
        : contractRequirement.acceptanceCriteria.some((criterion) => (
            item.criterionIds.includes(criterion.id) && criterion.blocking
          )),
      message: item.message,
    }));

    const artifactPreview = artifactCandidates;
    const evaluatorPreview = uniqueCandidates(
      Object.values(evaluatorCandidatesByArtifact).flat(),
    );
    const criterionResults = criteriaGaps.length > 0
      ? []
      : await Promise.all(contractRequirement.acceptanceCriteria.map(async (criterion) => {
          const verificationMode = criterion.requiredAssurance[0]!;
            const draftCriterion = requirement.acceptanceCriteria.find((candidate) => candidate.id === criterion.id)!;
            // The ranker resolves one requested check at a time. The frozen
            // binding below preserves the immutable atomic Criterion contract.
            const criterionForMode = {
              ...criterion,
              requiredAssurance: [verificationMode],
            };
            const draftCriterionForMode = {
              ...draftCriterion,
              requiredAssurance: [verificationMode],
            };
            const criterionRequirement = {
              ...contractRequirement,
              blocking: criterion.blocking,
              acceptanceCriteria: [criterionForMode],
            };
            const criterionDraft = {
              ...requirement,
              blocking: criterion.blocking,
              acceptanceCriteria: [draftCriterionForMode],
            };
            const rankings = await rank(input.ranker, {
              goalContract: input.goalContract,
              contractRequirement: criterionRequirement,
              requirement: criterionDraft,
              artifactCandidates,
              evaluatorCandidatesByArtifact,
              artifactContractCandidates: artifactCandidates,
              evaluatorCandidates: evaluatorCandidatesByArtifact,
            });
            const attempt = await resolveRequirementAttempt({
              contractRequirement: criterionRequirement,
              requirement: criterionDraft,
              criterionIds: [criterion.id],
              candidates,
              rankings,
            });
            if (attempt.binding) {
              attempt.binding = {
                ...attempt.binding,
                criterionContract: {
                  ...criterion,
                  verificationIntent: [...criterion.verificationIntent],
                  requiredAssurance: [...criterion.requiredAssurance],
                },
              };
            }
            return attempt;
        }));
    const criterionBindings = criterionResults.flatMap((result) => result.binding ? [result.binding] : []);
    const attemptGaps = criterionResults.flatMap((result) => result.gaps);
    const assuranceEvidenceGaps = contractRequirement.acceptanceCriteria.flatMap((criterion) => {
      const draftCriterion = requirement.acceptanceCriteria.find((candidate) => candidate.id === criterion.id)!;
      const boundEvidenceKinds = new Set(criterionBindings
        .filter((binding) => binding.criterionContract.id === criterion.id)
        .flatMap((binding) => binding.expectedEvidenceKinds));
      const missingEvidenceKinds = draftCriterion.evidenceIntent.filter((kind) => !boundEvidenceKinds.has(kind));
      return missingEvidenceKinds.length === 0
        ? []
        : [gap({
          kind: "evidence",
          requirementId: contractRequirement.id,
          criterionIds: [criterion.id],
          blocking: criterion.blocking,
          message: `Required evidence kinds are not covered by the resolved assurance checks: ${missingEvidenceKinds.join(", ")}`,
        })];
    });
    const missingKinds = new Set<"artifact" | "evaluator" | "capability" | "domain">(
      criterionResults.flatMap((result) => [...result.missingKinds]),
    );
    if (artifactPreview.length === 0) missingKinds.add("artifact");
    if (evaluatorPreview.length === 0) missingKinds.add("evaluator");
    const boundCheckKeys = new Set(criterionBindings.map((binding) => (
      criterionValidationCheckKey(binding.criterionContract.id, binding.verificationMode)
    )));
    const blockingCriteria = contractRequirement.acceptanceCriteria.filter((criterion) => criterion.blocking);
    const blockingReady = blockingCriteria.every((criterion) => (
      criterion.requiredAssurance.length === 1
      && boundCheckKeys.has(criterionValidationCheckKey(criterion.id, criterion.requiredAssurance[0]!))
    ));
    const blockingHumanApproval = criterionBindings.some((binding) => (
      binding.criterionContract.blocking && binding.verificationMode === "human_approval"
    ));
    const status = blockingHumanApproval
      ? "manual"
      : blockingReady
        ? "ready"
      : artifactPreview.length === 0 || evaluatorPreview.length === 0 ? "missing" : "partial";
    const bindingWithoutId = {
      schemaVersion: "southstar.requirement_validation_binding.v3" as const,
      requirementId: contractRequirement.id,
      criterionBindings,
    };
    const binding = criterionBindings.length > 0 ? {
      ...bindingWithoutId,
      id: `binding-${contentHashForPayload(bindingWithoutId).slice(0, 16)}`,
    } : undefined;
    const preview: RequirementCoveragePreviewV1 = {
      schemaVersion: "southstar.requirement_coverage_preview.v1",
      requirementId: contractRequirement.id,
      blocking: blockingCriteria.length > 0,
      status,
      artifactCandidates: artifactPreview.map(toCoverageCandidate),
      evaluatorCandidates: evaluatorPreview.map(toCoverageCandidate),
      missingKinds: [...missingKinds].sort(),
      criterionIds: criteria.criterionIds,
      acceptanceCriteria: contractRequirement.acceptanceCriteria.map((criterion) => criterion.observableClaim),
    };
    input.progress?.({
      event: "goal.validation.requirement.completed",
      data: {
        requirementId: contractRequirement.id,
        requirementIndex,
        requirementNumber: requirementIndex + 1,
        requirementCount: activeRequirements.length,
        status,
        gapCount: criteria.gaps.length + attemptGaps.length + assuranceEvidenceGaps.length,
      },
    });
    return {
      gaps: [...criteriaGaps, ...attemptGaps, ...assuranceEvidenceGaps],
      ...(binding ? { binding } : {}),
      preview,
    };
  }));

  // Promise.all preserves input order even though rank calls complete out of
  // order. Persisted previews, bindings, and gaps therefore remain stable.
  for (const result of requirementResults) {
    gaps.push(...result.gaps);
    if (result.binding) bindings.push(result.binding);
    previews.push(result.preview);
  }

  for (const requirement of input.requirementDraft.requirements) {
    if (requirement.status === "superseded" || contractRequirements.has(requirement.id)) continue;
    gaps.push(gap({
      kind: "manual",
      requirementId: requirement.id,
      criterionIds: requirement.acceptanceCriteria.map((criterion) => criterion.id),
      blocking: requirement.acceptanceCriteria.some((criterion) => criterion.blocking),
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
      : item.kind === "evaluator" || item.kind === "edge" || item.kind === "procedure" || item.kind === "oracle" || item.kind === "evidence" || item.kind === "independence"
        ? previewEvaluatorRefs.length > 0 ? previewEvaluatorRefs : candidates.evaluatorProfiles.map((candidate) => candidate.objectKey)
        : [];
    return candidateRefs.length > 0 ? { ...item, candidateRefs } : item;
  });
  const resolutionWithoutHash = {
    schemaVersion: "southstar.goal_validation_resolution.v2" as const,
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
  const resolution = {
    ...resolutionWithoutHash,
    resolutionHash: contentHashForPayload(resolutionWithoutHash),
  };
  input.progress?.({
    event: "goal.validation.resolution.completed",
    data: {
      ready: resolution.ready,
      bindingCount: resolution.bindings.length,
      gapCount: resolution.gaps.length,
      blockingGapCount: resolution.gaps.filter((gap) => gap.blocking).length,
      resolutionHash: resolution.resolutionHash,
    },
  });
  return resolution;
}

export function goalValidationResolutionReady(resolution: GoalValidationResolutionV2): boolean {
  if (resolution.schemaVersion !== "southstar.goal_validation_resolution.v2"
    || resolution.ready !== true
    || !Array.isArray(resolution.previews)
    || !Array.isArray(resolution.bindings)
    || !Array.isArray(resolution.gaps)
    || resolution.gaps.some((gap) => gap.blocking)
  ) return false;
  const bindingCounts = new Map<string, number>();
  for (const binding of resolution.bindings) {
    const checkKeys = new Set<string>();
    const coverageByCriterion = new Map<string, Set<RequirementValidationMode>>();
    if (binding.schemaVersion !== "southstar.requirement_validation_binding.v3"
      || binding.criterionBindings.length === 0
      || binding.criterionBindings.some((item) => {
        const required = item.criterionContract.requiredAssurance;
        if (required.length !== 1 || new Set(required).size !== required.length || required[0] !== item.verificationMode) return true;
        const key = criterionValidationCheckKey(item.criterionContract.id, item.verificationMode);
        if (checkKeys.has(key)) return true;
        checkKeys.add(key);
        const modes = coverageByCriterion.get(item.criterionContract.id) ?? new Set<RequirementValidationMode>();
        modes.add(item.verificationMode);
        coverageByCriterion.set(item.criterionContract.id, modes);
        return false;
      })) return false;
    const preview = resolution.previews.find((candidate) => candidate.requirementId === binding.requirementId);
    if (!preview || preview.criterionIds.some((criterionId) => {
      const criterionModes = coverageByCriterion.get(criterionId);
      const contract = binding.criterionBindings.find((item) => item.criterionContract.id === criterionId)?.criterionContract;
      return !criterionModes || !contract || contract.requiredAssurance.some((mode) => !criterionModes.has(mode));
    })) return false;
    bindingCounts.set(binding.requirementId, (bindingCounts.get(binding.requirementId) ?? 0) + 1);
  }
  return resolution.previews
    .filter((preview) => preview.blocking)
    .every((preview) => preview.status === "ready" && bindingCounts.get(preview.requirementId) === 1);
}

export function assertGoalValidationResolutionReady(resolution: GoalValidationResolutionV2): void {
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
    const semanticResult = validateSemanticCompatibility({
      contractRequirement: input.contractRequirement,
      requirement: input.requirement,
      artifact,
      evaluator,
    });
    if (semanticResult.gaps.length > 0) {
      gaps.push(...semanticResult.gaps);
      continue;
    }
    const bindingResult = buildBinding({
      contractRequirement: input.contractRequirement,
      requirement: input.requirement,
      criterionIds: input.criterionIds,
      artifact,
      evaluator,
      recommendation,
      approvedOracleRefs: input.candidates.approvedOracleRefs,
      approvedOracleVersionRefs: input.candidates.approvedOracleVersionRefs,
    });
    if (bindingResult.gaps.length > 0 || !bindingResult.binding) {
      gaps.push(...bindingResult.gaps);
      if (bindingResult.missingKinds) for (const kind of bindingResult.missingKinds) missingKinds.add(kind);
      continue;
    }
    // Rankings are alternatives, not cumulative obligations. Once one pair
    // produces a valid binding, rejections from earlier alternatives must not
    // keep the Requirement in a gap state or trigger an unnecessary repair.
    return { binding: bindingResult.binding, gaps: [], missingKinds: new Set() };
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
  approvedOracleRefs?: Set<string>;
  approvedOracleVersionRefs?: Map<string, string>;
}): { binding?: CriterionValidationBindingV1; gaps: GoalValidationGapV1[]; missingKinds?: Set<"artifact" | "evaluator" | "capability" | "domain"> } {
  const state = input.evaluator.state;
  const criterionContract = input.contractRequirement.acceptanceCriteria[0]!;
  const draftCriterion = input.requirement.acceptanceCriteria[0]!;
  if (criterionContract.requiredAssurance.length !== 1
    || criterionContract.requiredAssurance[0] !== input.recommendation.verificationMode) {
    return {
      gaps: [gap({
        kind: "criteria",
        requirementId: input.contractRequirement.id,
        criterionIds: [criterionContract.id],
        blocking: criterionContract.blocking,
        message: `Selected verification mode ${input.recommendation.verificationMode} does not satisfy required assurance ${criterionContract.requiredAssurance.join(", ")}`,
      })],
    };
  }
  const evaluatorContractIssue = validateExecutableContractState("evaluator", input.evaluator);
  if (evaluatorContractIssue) {
    return {
      gaps: [gap({
        kind: "evaluator",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: input.evaluator.objectKey,
        blocking: input.contractRequirement.blocking,
        message: evaluatorContractIssue,
      })],
      missingKinds: new Set(["evaluator"]),
    };
  }
  const modes = stringArray(state.verificationModes);
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
  const procedureMode = typeof procedure.checkKind === "string" ? procedure.checkKind : undefined;
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
  const procedureVersionRef = typeof procedure.procedureVersionRef === "string" && procedure.procedureVersionRef.trim().length > 0
    ? procedure.procedureVersionRef.trim()
    : input.evaluator.headVersionId;
  if (!procedureVersionRef) {
    return {
      gaps: [gap({
        kind: "procedure",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: input.recommendation.procedureRef,
        blocking: input.contractRequirement.blocking,
        message: `Verification procedure ${input.recommendation.procedureRef} has no immutable version ref`,
      })],
    };
  }
  const oracleRef = typeof procedure.oracleRef === "string" ? procedure.oracleRef.trim() : "";
  const oracleVersionRef = typeof procedure.oracleVersionRef === "string" ? procedure.oracleVersionRef.trim() : "";
  if ((oracleRef.length === 0) !== (oracleVersionRef.length === 0)) {
    return {
      gaps: [gap({
        kind: "oracle",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: oracleRef || oracleVersionRef,
        blocking: input.contractRequirement.blocking,
        message: `Verification procedure ${input.recommendation.procedureRef} must pin both oracleRef and oracleVersionRef`,
      })],
    };
  }
  if (oracleRef && (!input.approvedOracleRefs?.has(oracleRef) || input.approvedOracleVersionRefs?.get(oracleRef) !== oracleVersionRef)) {
    return {
      gaps: [gap({
        kind: "oracle",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: oracleRef,
        blocking: input.contractRequirement.blocking,
        message: `Verification procedure ${input.recommendation.procedureRef} references an oracle that is not approved at ${oracleVersionRef}`,
      })],
    };
  }
  const typedParameters = input.recommendation.typedParameters ?? {};
  const parameterSchema = isParameterSchema(procedure.parameterSchema) ? procedure.parameterSchema : {};
  const parameterIssues = validateTypedParameters(parameterSchema, typedParameters);
  if (parameterIssues.length > 0) {
    return {
      gaps: [gap({
        kind: "procedure",
        requirementId: input.contractRequirement.id,
        criterionIds: input.criterionIds,
        requestedRef: input.recommendation.procedureRef,
        blocking: input.contractRequirement.blocking,
        message: `Typed procedure parameters are invalid: ${parameterIssues.join("; ")}`,
      })],
    };
  }
  if (state.independencePolicy !== "independent") {
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
  const rankerEvidenceKinds = uniqueStrings(input.recommendation.expectedEvidenceKinds ?? []);
  const expectedEvidenceKinds = rankerEvidenceKinds.length > 0
    ? rankerEvidenceKinds
    : uniqueStrings(draftCriterion.evidenceIntent);
  const inventedEvidenceKinds = rankerEvidenceKinds.filter((kind) => !expectedEvidenceKinds.includes(kind));
  const procedureEvidenceKinds = uniqueStrings(stringArray(procedure.allowedEvidenceKinds));
  const evaluatorEvidenceKinds = uniqueStrings(stringArray(state.evidenceKinds));
  const artifactEvidenceKinds = uniqueStrings(stringArray(input.artifact.state.evidenceKinds));
  const resultSchemaRef = typeof state.resultSchemaRef === "string" ? state.resultSchemaRef.trim() : "";
  const procedureInstruction = typeof procedure.instruction === "string" ? procedure.instruction.trim() : "";
  const unsupportedByProcedure = expectedEvidenceKinds.filter((kind) => !procedureEvidenceKinds.includes(kind));
  const unsupportedByEvaluator = expectedEvidenceKinds.filter((kind) => !evaluatorEvidenceKinds.includes(kind));
  const unsupportedByArtifact = expectedEvidenceKinds.filter((kind) => !artifactEvidenceKinds.includes(kind));
  if (resultSchemaRef !== REQUIREMENT_EVALUATOR_RESULT_SCHEMA_REF || !procedureInstruction
    || procedureEvidenceKinds.length === 0 || evaluatorEvidenceKinds.length === 0 || artifactEvidenceKinds.length === 0
    || inventedEvidenceKinds.length > 0 || unsupportedByProcedure.length > 0 || unsupportedByEvaluator.length > 0 || unsupportedByArtifact.length > 0) {
    const details = [
      resultSchemaRef !== REQUIREMENT_EVALUATOR_RESULT_SCHEMA_REF ? `evaluator resultSchemaRef must be ${REQUIREMENT_EVALUATOR_RESULT_SCHEMA_REF}` : "",
      !procedureInstruction ? "verification procedure instruction is missing" : "",
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
  return {
    gaps: [],
    binding: {
      criterionContract: {
        ...criterionContract,
        verificationIntent: [...criterionContract.verificationIntent],
        requiredAssurance: [...criterionContract.requiredAssurance],
      },
      artifactContractRef: input.artifact.objectKey,
      artifactContractVersionRef: input.artifact.headVersionId!,
      evaluatorProfileRef: input.evaluator.objectKey,
      evaluatorProfileVersionRef: input.evaluator.headVersionId!,
      verificationMode: input.recommendation.verificationMode,
      procedureRef: input.recommendation.procedureRef,
      procedureVersionRef,
      ...(oracleRef ? { oracleRef, oracleVersionRef } : {}),
      ...(Object.keys(parameterSchema).length > 0 ? { parameterSchema, typedParameters } : {}),
      expectedEvidenceKinds,
      independence: "independent" as const,
      failureClassifications: stringArray(input.evaluator.state.failureClassifications),
    },
  };
}

function isParameterSchema(value: unknown): value is Record<string, { type: "string" | "number" | "boolean" | "string[]" | "object"; required?: boolean }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([name, raw]) => {
    if (!name || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const spec = raw as Record<string, unknown>;
    return (spec.type === "string" || spec.type === "number" || spec.type === "boolean" || spec.type === "string[]" || spec.type === "object")
      && (spec.required === undefined || typeof spec.required === "boolean");
  });
}

function validateTypedParameters(
  schema: Record<string, { type: "string" | "number" | "boolean" | "string[]" | "object"; required?: boolean }>,
  values: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    const value = values[name];
    if (value === undefined) {
      if (spec.required === true) issues.push(`missing required parameter ${name}`);
      continue;
    }
    const valid = spec.type === "string" ? typeof value === "string"
      : spec.type === "number" ? typeof value === "number" && Number.isFinite(value)
        : spec.type === "boolean" ? typeof value === "boolean"
          : spec.type === "string[]" ? Array.isArray(value) && value.every((item) => typeof item === "string")
            : Boolean(value) && typeof value === "object" && !Array.isArray(value);
    if (!valid) issues.push(`parameter ${name} must be ${spec.type}`);
  }
  const unknown = Object.keys(values).filter((name) => !(name in schema));
  if (unknown.length > 0) issues.push(`unknown parameters ${unknown.join(", ")}`);
  return issues;
}

function validateSemanticCompatibility(input: {
  contractRequirement: GoalRequirementV1;
  requirement: GoalRequirementDraftItemV1;
  artifact: LibraryObjectSummary;
  evaluator: LibraryObjectSummary;
}): { gaps: GoalValidationGapV1[] } {
  const requiredTags = normalizeSemanticTags(input.contractRequirement.semanticTags ?? input.requirement.semanticTags);
  const artifactTags = normalizeSemanticTags(input.artifact.state.semanticTags);
  const evaluatorTags = normalizeSemanticTags(input.evaluator.state.semanticTags);
  const base = {
    requirementId: input.contractRequirement.id,
    blocking: input.contractRequirement.blocking,
  } as const;

  // Legacy contracts without semantic metadata remain readable, but as soon
  // as a candidate declares semantic metadata we fail closed rather than
  // silently treating the requirement as universally compatible.
  if (requiredTags.length === 0) {
    if (artifactTags.length === 0 && evaluatorTags.length === 0) return { gaps: [] };
    return {
      gaps: [gap({
        kind: "semantic",
        ...base,
        message: "Requirement semanticTags are missing; confirm the outcome vocabulary before reusing a tagged Library validation pair",
        candidateRefs: [input.artifact.objectKey, input.evaluator.objectKey],
      })],
    };
  }

  const gaps: GoalValidationGapV1[] = [];
  const missingArtifactTags = missingSemanticTags(requiredTags, artifactTags);
  if (artifactTags.length === 0 || missingArtifactTags.length > 0) {
    gaps.push(gap({
      kind: "semantic",
      ...base,
      requestedRef: input.artifact.objectKey,
      message: artifactTags.length === 0
        ? `Artifact ${input.artifact.objectKey} has no semanticTags for the confirmed Requirement`
        : `Artifact ${input.artifact.objectKey} does not cover Requirement semanticTags: ${missingArtifactTags.join(", ")}`,
      candidateRefs: [input.artifact.objectKey],
    }));
  }
  const missingEvaluatorTags = missingSemanticTags(requiredTags, evaluatorTags);
  if (evaluatorTags.length === 0 || missingEvaluatorTags.length > 0) {
    gaps.push(gap({
      kind: "semantic",
      ...base,
      requestedRef: input.evaluator.objectKey,
      message: evaluatorTags.length === 0
        ? `Evaluator ${input.evaluator.objectKey} has no semanticTags for the confirmed Requirement`
        : `Evaluator ${input.evaluator.objectKey} does not cover Requirement semanticTags: ${missingEvaluatorTags.join(", ")}`,
      candidateRefs: [input.evaluator.objectKey],
    }));
  }
  return { gaps };
}

function criteriaMapping(
  contractRequirement: GoalRequirementV1,
  requirement: GoalRequirementDraftItemV1,
): { criterionIds: string[]; gaps: Array<{ criterionIds: string[]; message: string }> } {
  const draftById = new Map(requirement.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  const criterionIds: string[] = [];
  const gaps: Array<{ criterionIds: string[]; message: string }> = [];
  for (const confirmed of contractRequirement.acceptanceCriteria) {
    const draftCriterion = draftById.get(confirmed.id);
    if (
      !draftCriterion
      || !sameConfirmedCriterion(draftCriterion, confirmed)
    ) {
      gaps.push({
        criterionIds: [confirmed.id],
        message: `Confirmed Criterion ${confirmed.id}@${confirmed.version} is not preserved in the Requirement Draft`,
      });
      continue;
    }
    criterionIds.push(draftCriterion.id);
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

function sameConfirmedCriterion(draft: GoalAcceptanceCriterionDraftV1, confirmed: GoalCriterionV1): boolean {
  // A Requirement Draft Criterion version is proposal lineage.  On the first
  // Goal Contract confirmation the host assigns the canonical contract
  // version (currently 1), so a revised draft may legitimately carry a
  // higher proposal version while preserving the same semantic Criterion.
  // Reconfirmation still detects semantic changes below and the frozen
  // contract version remains authoritative for all downstream bindings.
  return draft.id === confirmed.id
    && normalize(draft.observableClaim) === normalize(confirmed.observableClaim)
    && draft.blocking === confirmed.blocking
    && sameNormalizedStrings(draft.verificationIntent, confirmed.verificationIntent)
    && sameNormalizedStrings(draft.requiredAssurance, confirmed.requiredAssurance);
}

function sameNormalizedStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizeAndSort = (values: string[]) => values.map(normalize).sort();
  return JSON.stringify(normalizeAndSort(left)) === JSON.stringify(normalizeAndSort(right));
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
  return validateExecutableContractState("artifact", object);
}

function validateExecutableContractState(
  kind: "artifact" | "evaluator",
  object: LibraryObjectSummary,
): string | undefined {
  try {
    const scope = typeof object.state.scope === "string" ? object.state.scope.trim() : "";
    if (!scope) throw new Error("state.scope must be a non-empty string");
    const record: Record<string, unknown> = {
      objectKey: object.objectKey,
      kind,
      title: typeof object.state.title === "string" ? object.state.title : object.objectKey,
      scope,
      selectedByDefault: true,
    };
    const hostOwnedFields = new Set([
      "schemaVersion", "id", "title", "scope", "status", "body", "sourcePath", "sourceHash",
      "declaredStatus", "reconcileReason", "importDraftId", "importCandidateKey", "importSourcePath",
    ]);
    for (const [key, value] of Object.entries(object.state)) {
      if (!hostOwnedFields.has(key)) record[key] = value;
    }
    normalizeLibraryImportCandidateKindFields(record, kind, object.objectKey);
    return undefined;
  } catch (cause) {
    return `Approved ${kind} ${object.objectKey} has an invalid executable contract: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
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
    acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => criterion.observableClaim),
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
