import type { SouthstarDb } from "../db/postgres.ts";
import {
  findApprovedLibraryObjectsByKind,
  findLibraryEdgesTo,
  findLibraryObjectByKey,
  listLibraryObjects,
} from "../design-library/library-graph-store.ts";
import { isRuntimeProfilePrimitiveCandidate, resolveGraphProfileCandidates } from "../design-library/profile-composer/graph-profile-candidate-resolver.ts";
import type {
  CandidatePacket,
  CandidateSummary,
  LibraryObjectSummary,
  RequirementSpecV2,
} from "../design-library/types.ts";
import { buildGraphMetadataCandidatePacket } from "./graph-metadata-packet.ts";
import type { WorkflowTemplatePolicyV1 } from "./goal-design.ts";

export type ResolveWorkflowCandidatesInput = {
  requirementSpec: RequirementSpecV2;
  scope: string;
  templatePolicy?: WorkflowTemplatePolicyV1;
};

/**
 * Closed approved graph set consumed by Goal Validation.  Workflow candidate
 * resolution intentionally remains broader; this helper adds the stricter
 * version pin and edge checks required before a validation binding is frozen.
 */
export type ApprovedValidationCandidatesV1 = {
  artifactContracts: LibraryObjectSummary[];
  evaluatorProfiles: LibraryObjectSummary[];
  evaluatorProfilesByArtifact: Record<string, LibraryObjectSummary[]>;
};

export async function resolveApprovedValidationCandidates(
  db: SouthstarDb,
  input: { scope?: string } = {},
): Promise<ApprovedValidationCandidatesV1> {
  const artifacts = (await approvedObjectsForValidation(db, "artifact_contract", input.scope))
    .filter((object) => object.headVersionId !== null);
  const evaluators = (await approvedObjectsForValidation(db, "evaluator_profile", input.scope))
    .filter((object) => object.headVersionId !== null);
  const approvedEvaluators = new Map(evaluators.map((evaluator) => [evaluator.objectKey, evaluator]));
  const evaluatorProfilesByArtifact: Record<string, LibraryObjectSummary[]> = {};
  for (const artifact of artifacts) {
    const edges = await validationEdgesTo(db, artifact.objectKey, input.scope);
    evaluatorProfilesByArtifact[artifact.objectKey] = edges
      .filter((edge) => edge.status === "active")
      .filter((edge) => {
        const evaluator = approvedEvaluators.get(edge.fromObjectKey);
        return evaluator !== undefined
          && evaluator.headVersionId !== null
          && edge.fromVersionRef === evaluator.headVersionId
          && edge.toVersionRef === artifact.headVersionId;
      })
      .map((edge) => approvedEvaluators.get(edge.fromObjectKey)!)
      .filter((evaluator, index, all) => all.findIndex((candidate) => candidate.objectKey === evaluator.objectKey) === index)
      .sort((left, right) => left.objectKey.localeCompare(right.objectKey));
  }
  return { artifactContracts: artifacts, evaluatorProfiles: evaluators, evaluatorProfilesByArtifact };
}

async function approvedObjectsForValidation(
  db: SouthstarDb,
  kind: "artifact_contract" | "evaluator_profile",
  scope: string | undefined,
): Promise<LibraryObjectSummary[]> {
  const scoped = await findApprovedLibraryObjectsByKind(db, kind, scope);
  if (!scope || scope === "all") return scoped;
  const global = await findApprovedLibraryObjectsByKind(db, kind, "global");
  const byKey = new Map([...scoped, ...global].map((object) => [object.objectKey, object]));
  return [...byKey.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey));
}

async function validationEdgesTo(
  db: SouthstarDb,
  artifactRef: string,
  scope: string | undefined,
) {
  const scopes = scope && scope !== "all" ? [scope, "global"] : [undefined];
  const edges = [];
  for (const edgeScope of scopes) {
    edges.push(
      ...(await findLibraryEdgesTo(db, artifactRef, "validates_artifact", { scope: edgeScope })),
      ...(await findLibraryEdgesTo(db, artifactRef, "validates", { scope: edgeScope })),
    );
  }
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  return [...byId.values()];
}

export async function resolveWorkflowCandidates(db: SouthstarDb, input: ResolveWorkflowCandidatesInput): Promise<CandidatePacket> {
  const approvedWorkflowTemplateCandidates = (
    await findApprovedLibraryObjectsByKind(db, "workflow_template", input.scope)
  ).map((object) => summary(object.objectKey, object.headVersionId, object.objectKind, object.state, "approved workflow template"));
  const workflowTemplateCandidates = await applyTemplatePolicy(db, {
    candidates: approvedWorkflowTemplateCandidates,
    policy: input.templatePolicy,
  });

  const unavailableRequirements: CandidatePacket["unavailableRequirements"] = [];
  const agentCandidatesByCapability: Record<string, CandidateSummary[]> = {};
  for (const capabilityRef of input.requirementSpec.requiredCapabilities) {
    const providerEdges = await findLibraryEdgesTo(db, capabilityRef, "provides_capability", { scope: input.scope });
    const candidates = await summariesForRefs(
      db,
      providerEdges.map((edge) => edge.fromObjectKey),
      `provides ${capabilityRef}`,
    );
    agentCandidatesByCapability[capabilityRef] = candidates.filter((candidate) => candidate.kind === "agent_definition");
    if (agentCandidatesByCapability[capabilityRef].length === 0) {
      unavailableRequirements.push({ capabilityRef, reason: "no_approved_candidate" });
    }
  }

  const profileCandidatesByAgent: Record<string, CandidateSummary[]> = {};
  const skillCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const toolCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const mcpGrantCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const vaultLeaseCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const instructionCandidatesByProfile: Record<string, CandidateSummary[]> = {};

  const artifactContractCandidates = await summariesForRefs(
    db,
    input.requirementSpec.expectedArtifacts,
    "required by expectation",
  );
  const evaluatorCandidatesByArtifact: Record<string, CandidateSummary[]> = {};
  for (const artifact of artifactContractCandidates) {
    const validatorEdges = [
      ...(await findLibraryEdgesTo(db, artifact.ref, "validates_artifact", { scope: input.scope })),
      ...(await findLibraryEdgesTo(db, artifact.ref, "validates", { scope: input.scope })),
    ];
    evaluatorCandidatesByArtifact[artifact.ref] = await summariesForRefs(
      db,
      validatorEdges.map((edge) => edge.fromObjectKey),
      `validates ${artifact.ref}`,
    );
  }

  const policyConstraints = (
    await findApprovedLibraryObjectsByKind(db, "policy_bundle", input.scope)
  ).map((object) => summary(object.objectKey, object.headVersionId, object.objectKind, object.state, "approved policy bundle"));
  const graphProfileCandidates = await resolveGraphProfileCandidates(db, { scope: input.scope });
  const profilePrimitiveCandidates = {
    ...graphProfileCandidates,
    instructions: (
      await listLibraryObjects(db, {
        scope: input.scope,
        status: "approved",
        objectKind: "instruction_template",
      })
    ).filter(isRuntimeProfilePrimitiveCandidate).map((object) => object.objectKey).sort(),
  };
  const graphMetadataCandidates = await buildGraphMetadataCandidatePacket(db, { scope: input.scope });

  return {
    requirementSpec: input.requirementSpec,
    workflowTemplateCandidates,
    agentCandidatesByCapability,
    profileCandidatesByAgent,
    skillCandidatesByProfile,
    toolCandidatesByProfile,
    mcpGrantCandidatesByProfile,
    vaultLeaseCandidatesByProfile,
    instructionCandidatesByProfile,
    artifactContractCandidates,
    evaluatorCandidatesByArtifact,
    policyConstraints,
    profilePrimitiveCandidates,
    graphMetadataCandidates,
    unavailableRequirements,
  };
}

async function applyTemplatePolicy(
  db: SouthstarDb,
  input: { candidates: CandidateSummary[]; policy?: WorkflowTemplatePolicyV1 },
): Promise<CandidateSummary[]> {
  const policy = input.policy;
  if (!policy || policy.mode === "auto") {
    return [...input.candidates].sort(candidateOrder);
  }
  const template = await findLibraryObjectByKey(db, policy.templateRef);
  if (!template || template.objectKind !== "workflow_template" || template.status !== "approved") {
    throw new Error(`workflow_template_policy_unresolved: ${policy.templateRef}`);
  }
  if (template.headVersionId !== policy.versionRef) {
    throw new Error(`workflow_template_version_mismatch: ${policy.templateRef}`);
  }
  const pinned = summary(template.objectKey, template.headVersionId, template.objectKind, template.state, `${policy.mode} workflow template policy`);
  const rest = input.candidates
    .filter((candidate) => candidate.ref !== pinned.ref)
    .sort(candidateOrder);
  return [pinned, ...rest];
}

function candidateOrder(left: CandidateSummary, right: CandidateSummary): number {
  return left.ref.localeCompare(right.ref);
}

async function summariesForRefs(db: SouthstarDb, refs: string[], reason: string): Promise<CandidateSummary[]> {
  const uniqueRefs = [...new Set(refs)].sort();
  const results: CandidateSummary[] = [];
  for (const ref of uniqueRefs) {
    const object = await findLibraryObjectByKey(db, ref);
    if (!object || object.status !== "approved") continue;
    results.push(summary(object.objectKey, object.headVersionId, object.objectKind, object.state, reason));
  }
  return results;
}

function summary(
  ref: string,
  versionRef: string | null,
  kind: CandidateSummary["kind"],
  state: Record<string, unknown>,
  reason: string,
): CandidateSummary {
  const displayName = typeof state.displayName === "string"
    ? state.displayName
    : typeof state.title === "string"
      ? state.title
      : ref;
  return { ref, versionRef, kind, displayName, state, reason };
}
