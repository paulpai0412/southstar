import type { SouthstarDb } from "../db/postgres.ts";
import {
  findApprovedLibraryObjectsByKind,
  findLibraryEdgesTo,
  findLibraryObjectByKey,
  listLibraryObjects,
} from "../design-library/library-graph-store.ts";
import { isRuntimeProfilePrimitiveCandidate, resolveGraphProfileCandidates } from "../design-library/profile-composer/graph-profile-candidate-resolver.ts";
import type { CandidatePacket, CandidateSummary, RequirementSpecV2 } from "../design-library/types.ts";
import { buildGraphMetadataCandidatePacket } from "./graph-metadata-packet.ts";

export type ResolveWorkflowCandidatesInput = {
  requirementSpec: RequirementSpecV2;
  scope: string;
};

export async function resolveWorkflowCandidates(db: SouthstarDb, input: ResolveWorkflowCandidatesInput): Promise<CandidatePacket> {
  const approvedWorkflowTemplateCandidates = (
    await findApprovedLibraryObjectsByKind(db, "workflow_template", input.scope)
  ).map((object) => summary(object.objectKey, object.headVersionId, object.objectKind, object.state, "approved workflow template"));
  const workflowTemplateCandidates = [
    graphDynamicWorkflowTemplateCandidate(input.scope),
    ...approvedWorkflowTemplateCandidates.filter((candidate) => candidate.ref !== GRAPH_DYNAMIC_WORKFLOW_TEMPLATE_REF),
  ];

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
  if (!graphMetadataCandidates.nodes.some((node) => node.ref === GRAPH_DYNAMIC_WORKFLOW_TEMPLATE_REF)) {
    graphMetadataCandidates.nodes.unshift({
      ref: GRAPH_DYNAMIC_WORKFLOW_TEMPLATE_REF,
      kind: "workflow_template",
      status: "approved",
      versionRef: null,
      scope: input.scope,
      title: "Graph Dynamic Workflow",
      description: "Graph-native workflow template for LLM-generated DAGs and generated agent profiles.",
      aliases: ["dynamic workflow", "graph workflow", "generated agent profiles"],
    });
  }

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

const GRAPH_DYNAMIC_WORKFLOW_TEMPLATE_REF = "template.graph-dynamic-workflow";

function graphDynamicWorkflowTemplateCandidate(scope: string): CandidateSummary {
  return {
    ref: GRAPH_DYNAMIC_WORKFLOW_TEMPLATE_REF,
    versionRef: null,
    kind: "workflow_template",
    displayName: "Graph Dynamic Workflow",
    reason: "graph-native template for generated DAGs and generated agent profiles",
    state: {
      scope,
      title: "Graph Dynamic Workflow",
      templateType: "graph_dynamic",
      description: "Use this template when composing a workflow directly from Postgres graph nodes/edges and generated agent profiles.",
      compositionConstraints: {
        schemaVersion: "southstar.composition_constraints.v1",
        templateSlots: [],
        requiredTaskGroups: [],
        requiredGroupDependencies: [],
        initialArtifactRefs: [],
      },
    },
  };
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
