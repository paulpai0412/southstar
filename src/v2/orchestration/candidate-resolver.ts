import type { SouthstarDb } from "../db/postgres.ts";
import {
  findApprovedLibraryObjectsByKind,
  findLibraryEdgesTo,
  findLibraryObjectByKey,
} from "../design-library/library-graph-store.ts";
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
  _input: { scope?: string } = {},
): Promise<ApprovedValidationCandidatesV1> {
  // Validation contracts are reusable graph objects, not files scoped to the
  // Goal's display domain. An artifact can live in `product` while its
  // evaluator lives in `testing`, with a version-pinned validation edge in a
  // third scope. Filtering either side by one Goal scope silently drops that
  // valid pair. Candidate ranking and the edge/version checks below remain the
  // governing constraints, so discovery must read the full approved graph.
  const artifacts = (await approvedObjectsForValidation(db, "artifact_contract"))
    .filter((object) => object.headVersionId !== null);
  const evaluators = (await approvedObjectsForValidation(db, "evaluator_profile"))
    .filter((object) => object.headVersionId !== null);
  const approvedEvaluators = new Map(evaluators.map((evaluator) => [evaluator.objectKey, evaluator]));
  const evaluatorProfilesByArtifact: Record<string, LibraryObjectSummary[]> = {};
  for (const artifact of artifacts) {
    const edges = await validationEdgesTo(db, artifact.objectKey);
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
): Promise<LibraryObjectSummary[]> {
  return await findApprovedLibraryObjectsByKind(db, kind);
}

async function validationEdgesTo(
  db: SouthstarDb,
  artifactRef: string,
) {
  const edges = [
    ...(await findLibraryEdgesTo(db, artifactRef, "validates_artifact")),
    ...(await findLibraryEdgesTo(db, artifactRef, "validates")),
  ];
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

  const graphMetadataCandidates = await buildGraphMetadataCandidatePacket(db, {
    scope: input.scope,
    requirementSpec: input.requirementSpec,
  });
  const runtimeCandidates = new Map(graphMetadataCandidates.nodes.map((node) => [node.ref, node]));
  const availableAgentCount = graphMetadataCandidates.nodes.filter((node) => node.kind === "agent_definition").length;
  const unavailableRequirements: CandidatePacket["unavailableRequirements"] = [];
  const agentCandidatesByCapability: Record<string, CandidateSummary[]> = {};
  for (const capabilityRef of input.requirementSpec.requiredCapabilities) {
    const providerEdges = await findLibraryEdgesTo(db, capabilityRef, "provides_capability");
    const candidates = (await summariesForRefs(
      db,
      providerEdges.map((edge) => edge.fromObjectKey),
      `provides ${capabilityRef}`,
    )).filter((candidate) => runtimeCandidates.has(candidate.ref));
    agentCandidatesByCapability[capabilityRef] = candidates.filter((candidate) => candidate.kind === "agent_definition");
    if (!runtimeCandidates.has(capabilityRef) || candidates.length === 0 || availableAgentCount === 0) {
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
      // Validation contracts may deliberately cross domain boundaries. The
      // artifact/evaluator object scopes and the edge scope are metadata for
      // ranking/audit, not a hard candidate filter. The approved graph and
      // requirement artifact reference are the authoritative relationship.
      ...(await findLibraryEdgesTo(db, artifact.ref, "validates_artifact")),
      ...(await findLibraryEdgesTo(db, artifact.ref, "validates")),
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
  const refsForKinds = (...kinds: typeof graphMetadataCandidates.nodes[number]["kind"][]) => graphMetadataCandidates.nodes
    .filter((node) => kinds.includes(node.kind))
    .map((node) => node.ref)
    .sort();
  const profilePrimitiveCandidates = {
    agents: refsForKinds("agent_definition"),
    skills: refsForKinds("skill_spec", "skill_definition"),
    tools: refsForKinds("tool_definition"),
    mcpGrants: refsForKinds("mcp_tool_grant"),
    instructions: refsForKinds("instruction_template"),
  };

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
