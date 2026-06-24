import type { SouthstarDb } from "../db/postgres.ts";
import {
  findApprovedLibraryObjectsByKind,
  findLibraryEdgesFrom,
  findLibraryEdgesTo,
  findLibraryObjectByKey,
} from "../design-library/library-graph-store.ts";
import type { CandidatePacket, CandidateSummary, LibraryEdgeType, RequirementSpecV2 } from "../design-library/types.ts";

export type ResolveWorkflowCandidatesInput = {
  requirementSpec: RequirementSpecV2;
  scope: string;
};

export async function resolveWorkflowCandidates(db: SouthstarDb, input: ResolveWorkflowCandidatesInput): Promise<CandidatePacket> {
  const workflowTemplateCandidates = (
    await findApprovedLibraryObjectsByKind(db, "workflow_template", input.scope)
  ).map((object) => summary(object.objectKey, object.headVersionId, object.objectKind, object.state, "approved workflow template"));

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
  for (const agentCandidates of Object.values(agentCandidatesByCapability)) {
    for (const agentCandidate of agentCandidates) {
      const profileEdges = await findLibraryEdgesTo(db, agentCandidate.ref, "implements", { scope: input.scope });
      profileCandidatesByAgent[agentCandidate.ref] = await summariesForRefs(
        db,
        profileEdges.map((edge) => edge.fromObjectKey),
        `implements ${agentCandidate.ref}`,
      );
    }
  }

  const skillCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const toolCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const mcpGrantCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const vaultLeaseCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const instructionCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  for (const profileCandidates of Object.values(profileCandidatesByAgent)) {
    for (const profileCandidate of profileCandidates) {
      skillCandidatesByProfile[profileCandidate.ref] = await linkedSummaries(db, profileCandidate.ref, "supports_skill", input.scope);
      toolCandidatesByProfile[profileCandidate.ref] = await linkedSummaries(db, profileCandidate.ref, "allows_tool", input.scope);
      mcpGrantCandidatesByProfile[profileCandidate.ref] = await linkedSummaries(db, profileCandidate.ref, "allows_mcp_grant", input.scope);
      vaultLeaseCandidatesByProfile[profileCandidate.ref] = await linkedSummaries(
        db,
        profileCandidate.ref,
        "requires_secret_group",
        input.scope,
      );
      instructionCandidatesByProfile[profileCandidate.ref] = await linkedSummaries(
        db,
        profileCandidate.ref,
        "uses_instruction",
        input.scope,
      );
    }
  }

  const artifactContractCandidates = await summariesForRefs(
    db,
    input.requirementSpec.expectedArtifacts,
    "required by expectation",
  );
  const evaluatorCandidatesByArtifact: Record<string, CandidateSummary[]> = {};
  for (const artifact of artifactContractCandidates) {
    const validatorEdges = await findLibraryEdgesTo(db, artifact.ref, "validates_artifact", { scope: input.scope });
    evaluatorCandidatesByArtifact[artifact.ref] = await summariesForRefs(
      db,
      validatorEdges.map((edge) => edge.fromObjectKey),
      `validates ${artifact.ref}`,
    );
  }

  const policyConstraints = (
    await findApprovedLibraryObjectsByKind(db, "policy_bundle", input.scope)
  ).map((object) => summary(object.objectKey, object.headVersionId, object.objectKind, object.state, "approved policy bundle"));

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
    unavailableRequirements,
  };
}

async function linkedSummaries(
  db: SouthstarDb,
  fromRef: string,
  edgeType: LibraryEdgeType,
  scope: string,
): Promise<CandidateSummary[]> {
  const edges = await findLibraryEdgesFrom(db, fromRef, edgeType, { scope });
  return summariesForRefs(db, edges.map((edge) => edge.toObjectKey), `${edgeType} from ${fromRef}`);
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
