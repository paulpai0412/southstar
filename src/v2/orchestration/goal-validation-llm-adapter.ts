import type { SouthstarDb } from "../db/postgres.ts";
import type { GoalValidationResolutionV1, LibraryObjectSummary } from "../design-library/types.ts";
import type {
  LibraryImportCandidate,
  LibraryImportCandidateCoverageTarget,
  LibraryImportCoverageConstraint,
} from "../design-library/importers/library-candidate-extractor.ts";
import type {
  LibraryImportLlmProvider,
  LibraryImportProposalValidator,
} from "../design-library/importers/library-llm-import-analyzer.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import {
  resolveApprovedValidationCandidates,
  type ApprovedValidationCandidatesV1,
} from "./candidate-resolver.ts";
import { goalContractHash, type GoalContractV1 } from "./goal-contract.ts";
import type { GoalRequirementDraftV1 } from "./goal-requirement-draft.ts";
import {
  resolveGoalValidationPg,
  resolveGoalValidationWithCandidates,
  goalValidationResolutionReady,
  type GoalValidationCandidateRankerInputV1,
  type GoalValidationCandidateRecommendationV1,
  type GoalValidationProgressListener,
} from "./goal-validation-resolver.ts";

export type GoalValidationResolver = (
  db: SouthstarDb,
  input: {
    goalContract: GoalContractV1;
    requirementDraft: GoalRequirementDraftV1;
    scope?: string;
    progress?: GoalValidationProgressListener;
  },
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

export function goalValidationProposalValidatorFromLibraryLlm(input: {
  db: SouthstarDb;
  provider: LibraryImportLlmProvider;
  goalContract: GoalContractV1;
  requirementDraft: GoalRequirementDraftV1;
  resolution: GoalValidationResolutionV1;
  scope?: string;
  progress?: GoalValidationProgressListener;
}): LibraryImportProposalValidator {
  const blockingRequirementIds = new Set(
    input.resolution.gaps.filter((gap) => gap.blocking).map((gap) => gap.requirementId),
  );
  const goalContract = {
    ...input.goalContract,
    requirements: input.goalContract.requirements.filter((requirement) => blockingRequirementIds.has(requirement.id)),
  };
  const requirementDraft = {
    ...input.requirementDraft,
    requirements: input.requirementDraft.requirements.filter((requirement) => blockingRequirementIds.has(requirement.id)),
  };
  return async ({ candidates, candidateCoverageTargets }) => {
    const approved = await resolveApprovedValidationCandidates(input.db, { scope: input.scope });
    const withProposal = validationCandidatesWithProposal(approved, candidates);
    const resolution = await resolveGoalValidationWithCandidates({
      goalContract,
      requirementDraft,
      scope: input.scope,
      // The candidate proposal is already the LLM's semantic ranking result.
      // Re-ranking every requirement here creates a second (and potentially
      // unbounded) LLM round during one Library import.  The host instead
      // derives a bounded recommendation from the proposal's explicit
      // coverage targets and validates the same executable artifact/evaluator
      // contract synchronously below.
      ranker: (rankInput) => rankGoalValidationCandidatesFromProposal({
        rankInput,
        coverageTargets: candidateCoverageTargets,
      }),
    }, withProposal);
    if (goalValidationResolutionReady(resolution)) return;
    const contractById = new Map(goalContract.requirements.map((requirement) => [requirement.id, requirement]));
    const issues = resolution.gaps
      .filter((gap) => gap.blocking)
      .map((gap) => {
        const requirement = contractById.get(gap.requirementId);
        const context = requirement
          ? ` Requirement=${JSON.stringify({ statement: requirement.statement, acceptanceCriteria: requirement.acceptanceCriteria })}`
          : "";
        return `${gap.requirementId}/${gap.kind}: ${gap.message}.${context}`;
      });
    throw new Error(`Proposed Library candidates do not close the confirmed blocking validation gaps: ${issues.join(" | ")}`);
  };
}

function validationCandidatesWithProposal(
  approved: ApprovedValidationCandidatesV1,
  candidates: LibraryImportCandidate[],
): ApprovedValidationCandidatesV1 {
  const proposedObjects = candidates
    .filter((candidate) => candidate.kind === "artifact" || candidate.kind === "evaluator")
    .map(proposalCandidateObject);
  const proposedKeys = new Set(proposedObjects.map((object) => object.objectKey));
  const artifacts = new Map(approved.artifactContracts
    .filter((object) => !proposedKeys.has(object.objectKey))
    .map((object) => [object.objectKey, object]));
  const evaluators = new Map(approved.evaluatorProfiles
    .filter((object) => !proposedKeys.has(object.objectKey))
    .map((object) => [object.objectKey, object]));
  for (const object of proposedObjects) {
    if (object.objectKind === "artifact_contract") artifacts.set(object.objectKey, object);
    if (object.objectKind === "evaluator_profile") evaluators.set(object.objectKey, object);
  }

  const evaluatorProfilesByArtifact: Record<string, LibraryObjectSummary[]> = {};
  for (const artifact of artifacts.values()) {
    evaluatorProfilesByArtifact[artifact.objectKey] = (approved.evaluatorProfilesByArtifact[artifact.objectKey] ?? [])
      .map((evaluator) => evaluators.get(evaluator.objectKey))
      .filter((evaluator): evaluator is LibraryObjectSummary => evaluator !== undefined);
  }
  for (const evaluator of proposedObjects.filter((object) => object.objectKind === "evaluator_profile")) {
    for (const artifactRef of stringArray(
      evaluator.state.validatesArtifactRefs,
      `${evaluator.objectKey}.validatesArtifactRefs`,
    )) {
      if (!artifacts.has(artifactRef)) continue;
      const linked = evaluatorProfilesByArtifact[artifactRef] ?? [];
      evaluatorProfilesByArtifact[artifactRef] = [
        ...linked.filter((candidate) => candidate.objectKey !== evaluator.objectKey),
        evaluator,
      ];
    }
  }
  return {
    artifactContracts: [...artifacts.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey)),
    evaluatorProfiles: [...evaluators.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey)),
    evaluatorProfilesByArtifact: Object.fromEntries(Object.entries(evaluatorProfilesByArtifact).map(([artifactRef, linked]) => [
      artifactRef,
      linked.sort((left, right) => left.objectKey.localeCompare(right.objectKey)),
    ])),
  };
}

function proposalCandidateObject(candidate: LibraryImportCandidate): LibraryObjectSummary {
  const state = candidate.kind === "artifact"
    ? {
      id: candidate.objectKey,
      title: candidate.title,
      scope: candidate.scope,
      status: "approved",
      artifactType: candidate.artifactType,
      mediaTypes: candidate.mediaTypes,
      evidenceKinds: candidate.evidenceKinds,
      validationRules: candidate.validationRules,
      schemaRef: candidate.schemaRef,
      requiredFields: candidate.requiredFields,
      provenanceRequirements: candidate.provenanceRequirements,
    }
    : {
      id: candidate.objectKey,
      title: candidate.title,
      scope: candidate.scope,
      status: "approved",
      validatesArtifactRefs: candidate.validatesArtifactRefs,
      requiredInputs: candidate.requiredInputs,
      evidenceKinds: candidate.evidenceKinds,
      verificationModes: candidate.verificationModes,
      verificationProcedures: candidate.verificationProcedures,
      independencePolicy: candidate.independencePolicy,
      resultSchemaRef: candidate.resultSchemaRef,
      failureClassifications: candidate.failureClassifications,
    };
  const version = `proposal-${contentHashForPayload({ objectKey: candidate.objectKey, state }).slice(0, 32)}`;
  return {
    id: `proposal-${candidate.objectKey}`,
    objectKey: candidate.objectKey,
    objectKind: candidate.kind === "artifact" ? "artifact_contract" : "evaluator_profile",
    status: "approved",
    headVersionId: version,
    state,
  };
}

export function buildGoalValidationImportRequest(input: {
  goalContract: GoalContractV1;
  goalContractHash: string;
  requirementDraft: GoalRequirementDraftV1;
  resolution: GoalValidationResolutionV1;
}): { payload: Record<string, unknown>; prompt: string; coverageConstraints: LibraryImportCoverageConstraint[] } {
  const gapRequirementIds = new Set(input.resolution.gaps.map((gap) => gap.requirementId));
  const draftById = new Map(input.requirementDraft.requirements.map((requirement) => [requirement.id, requirement]));
  const gaps = input.resolution.gaps.map((gap) => {
    const canonicalGap = {
      kind: gap.kind,
      requirementId: gap.requirementId,
      criterionIds: [...gap.criterionIds].sort(),
      ...(gap.requestedRef ? { requestedRef: gap.requestedRef } : {}),
      blocking: gap.blocking,
      message: gap.message,
    };
    return {
      ...canonicalGap,
      gapRef: `gap-${contentHashForPayload(canonicalGap).slice(0, 24)}`,
      boundedExistingCandidateRefs: [...new Set(gap.candidateRefs)].slice(0, 25),
    };
  });
  const coverageConstraints: LibraryImportCoverageConstraint[] = gaps.map((gap) => {
    const requirement = draftById.get(gap.requirementId);
    const contractRequirement = input.goalContract.requirements.find((candidate) => candidate.id === gap.requirementId);
    const targetCriterionIds = gap.criterionIds.length > 0
      ? new Set(gap.criterionIds)
      : new Set(requirement?.acceptanceCriteria.map((criterion) => criterion.id) ?? []);
    return {
      gapRef: gap.gapRef,
      requirementId: gap.requirementId,
      criterionIds: [...targetCriterionIds].sort(),
      requiredEvidenceKinds: [...new Set(
        requirement?.acceptanceCriteria
          .filter((criterion) => targetCriterionIds.has(criterion.id))
          .flatMap((criterion) => criterion.evidenceIntent) ?? [],
      )].sort(),
      blocking: gap.blocking,
      gapKind: gap.kind,
      ...(contractRequirement ? { requirementStatement: contractRequirement.statement } : {}),
      criterionStatements: requirement?.acceptanceCriteria
        .filter((criterion) => targetCriterionIds.has(criterion.id))
        .map((criterion) => ({ criterionId: criterion.id, statement: criterion.statement })) ?? [],
      expectedOutcomeArtifacts: requirement?.expectedOutcomeArtifacts ?? [],
      verificationIntent: requirement?.verificationIntent ?? [],
    };
  });
  const payload = {
    schemaVersion: "southstar.goal_validation_import_request.v1",
    goalContractHash: input.goalContractHash,
    goalRequirementDraftHash: input.requirementDraft.draftHash,
    resolutionHash: input.resolution.resolutionHash,
    gaps,
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
      "Create one complete reusable Library candidate proposal that closes the full current set of confirmed blocking Goal validation gaps in the source document.",
      "Do not return a partial batch. Every blocking gapRef must be covered in candidateCoverageTargets before this proposal can be reviewed or installed.",
      "Candidates may be artifact contracts and evaluator profiles required by those gaps, including their necessary validatesArtifactRefs relationship. Reuse one compatible contract across multiple gaps when its governed evidence shape and procedure genuinely cover them.",
      "Do not create unrelated domain, capability, agent, skill, tool, MCP, workflow, or Goal-specific filename candidates.",
      "Preserve the supplied Requirement and criterion meaning. Do not invent Acceptance Criteria or evidence kinds.",
      "Prefer a boundedExistingCandidateRef when it is compatible; otherwise propose reusable domain-scoped candidates.",
      `ConfirmedGapCount: ${input.resolution.gaps.length}`,
    ].join("\n"),
    coverageConstraints,
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
    "Compatibility is semantic as well as structural. The artifact schema, required fields, validation rules, evaluator inputs, and selected procedure must be able to verify the Requirement statement and every Acceptance Criterion. Do not select a generic evidence container when the Requirement explicitly demands a domain-specific persisted outcome.",
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

export function rankGoalValidationCandidatesFromProposal(input: {
  rankInput: GoalValidationCandidateRankerInputV1;
  coverageTargets: LibraryImportCandidateCoverageTarget[];
}): GoalValidationCandidateRecommendationV1[] {
  const expectedCriterionIds = new Set(
    input.rankInput.requirement.acceptanceCriteria.map((criterion) => criterion.id),
  );
  const expectedEvidenceKinds = uniqueStrings(
    input.rankInput.requirement.acceptanceCriteria.flatMap((criterion) => criterion.evidenceIntent),
  );
  const targetedCriteriaByArtifact = new Map<string, Set<string>>();
  for (const target of input.coverageTargets) {
    if (target.requirementId !== input.rankInput.contractRequirement.id) continue;
    const criteria = targetedCriteriaByArtifact.get(target.candidateObjectKey) ?? new Set<string>();
    for (const criterionId of target.criterionIds) criteria.add(criterionId);
    targetedCriteriaByArtifact.set(target.candidateObjectKey, criteria);
  }

  const recommendations: GoalValidationCandidateRecommendationV1[] = [];
  for (const artifact of input.rankInput.artifactContractCandidates) {
    const targetedCriteria = targetedCriteriaByArtifact.get(artifact.ref);
    if (!targetedCriteria || [...expectedCriterionIds].some((criterionId) => !targetedCriteria.has(criterionId))) continue;
    const evaluators = input.rankInput.evaluatorCandidatesByArtifact[artifact.ref] ?? [];
    for (const evaluator of evaluators) {
      const state = evaluator.state ?? {};
      const modes = asStringArray(state.verificationModes);
      const procedures = Array.isArray(state.verificationProcedures) ? state.verificationProcedures : [];
      const procedure = procedures.find((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
        const value = candidate as Record<string, unknown>;
        const checkKind = value.checkKind;
        const allowedEvidenceKinds = asStringArray(value.allowedEvidenceKinds);
        return typeof checkKind === "string"
          && modes.includes(checkKind)
          && expectedEvidenceKinds.every((kind) => allowedEvidenceKinds.includes(kind));
      });
      if (!procedure || typeof procedure !== "object" || Array.isArray(procedure)) continue;
      const procedureRecord = procedure as Record<string, unknown>;
      if (typeof procedureRecord.id !== "string" || typeof procedureRecord.checkKind !== "string") continue;
      recommendations.push({
        artifactRef: artifact.ref,
        evaluatorRef: evaluator.ref,
        verificationMode: procedureRecord.checkKind as GoalValidationCandidateRecommendationV1["verificationMode"],
        procedureRef: procedureRecord.id,
        expectedEvidenceKinds,
        reason: "LLM proposal coverage target; host-validated artifact/evaluator pair",
        ...(artifact.versionRef ? { artifactVersionRef: artifact.versionRef } : {}),
        ...(evaluator.versionRef ? { evaluatorVersionRef: evaluator.versionRef } : {}),
      });
    }
  }
  return recommendations;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
