import type { CandidatePacket, WorkflowCompositionPlan } from "../design-library/types.ts";
import type { LibraryObjectVersionRef } from "../manifests/types.ts";

export type CandidateSelectionSummary = {
  workflowTemplateRefs: string[];
  agentDefinitionRefs: string[];
  agentProfileRefs: string[];
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  artifactContractRefs: string[];
  evaluatorProfileRefs: string[];
  policyRefs: string[];
};

export function isLibraryBackedRef(ref: string): boolean {
  return !ref.startsWith("repo:");
}

export function summarizeCandidates(packet: CandidatePacket): CandidateSelectionSummary {
  return {
    workflowTemplateRefs: uniqueSorted([
      ...packet.workflowTemplateCandidates.map((candidate) => candidate.ref),
      ...graphRefsByKind(packet, "workflow_template"),
    ]),
    agentDefinitionRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.agentCandidatesByCapability),
      ...graphRefsByKind(packet, "agent_definition"),
    ]),
    agentProfileRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.profileCandidatesByAgent),
    ]),
    skillRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.skillCandidatesByProfile),
      ...graphRefsByKind(packet, "skill_spec"),
    ]),
    toolGrantRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.toolCandidatesByProfile),
      ...graphRefsByKind(packet, "tool_definition"),
    ]),
    mcpGrantRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.mcpGrantCandidatesByProfile),
      ...graphRefsByKind(packet, "mcp_tool_grant"),
    ]),
    artifactContractRefs: uniqueSorted([
      ...packet.artifactContractCandidates.map((candidate) => candidate.ref),
      ...graphRefsByKind(packet, "artifact_contract"),
    ]),
    evaluatorProfileRefs: uniqueSorted([
      ...flattenCandidateRefs(packet.evaluatorCandidatesByArtifact),
      ...graphRefsByKind(packet, "evaluator_profile"),
    ]),
    policyRefs: uniqueSorted([
      ...packet.policyConstraints.map((candidate) => candidate.ref),
      ...graphRefsByKind(packet, "policy_bundle"),
    ]),
  };
}

export function collectSelectedObjectVersionRefs(
  packet: CandidatePacket,
  composition: WorkflowCompositionPlan,
  additionalRefs: string[] = [],
): LibraryObjectVersionRef[] {
  const versionRefsByRef = new Map(candidateEntries(packet)
    .filter((candidate): candidate is { ref: string; versionRef: string } => Boolean(candidate.versionRef))
    .map((candidate) => [candidate.ref, candidate.versionRef]));
  const missingAdditionalRefs = uniqueSorted(additionalRefs).filter((ref) => !versionRefsByRef.has(ref));
  if (missingAdditionalRefs.length > 0) {
    throw new Error(`missing immutable Library candidates for resolved profile refs: ${missingAdditionalRefs.join(", ")}`);
  }
  return collectSelectedRefs(packet, composition, additionalRefs).map((objectKey) => ({
    objectKey,
    versionRef: requiredVersionRef(versionRefsByRef, objectKey),
  }));
}

export function collectSelectedRefs(
  packet: CandidatePacket,
  composition: WorkflowCompositionPlan,
  additionalRefs: string[] = [],
): string[] {
  const availableRefs = new Set(candidateEntries(packet).map((candidate) => candidate.ref));
  const selectedRefs = new Set<string>([composition.selectedWorkflowTemplateRef]);
  for (const task of composition.tasks) {
    selectedRefs.add(task.agentDefinitionRef);
    selectedRefs.add(task.agentProfileRef);
    selectedRefs.add(task.evaluatorProfileRef);
    addRefs(selectedRefs, task.skillRefs);
    addRefs(selectedRefs, task.toolGrantRefs);
    addRefs(selectedRefs, task.mcpGrantRefs);
    addRefs(selectedRefs, task.vaultLeasePolicyRefs);
    addRefs(selectedRefs, task.instructionRefs);
    addRefs(selectedRefs, task.inputArtifactRefs);
    addRefs(selectedRefs, task.outputArtifactRefs);
    addRefs(selectedRefs, task.recoveryStrategyRefs);
    if (task.contextPolicyRef) selectedRefs.add(task.contextPolicyRef);
    if (task.workspacePolicyRef) selectedRefs.add(task.workspacePolicyRef);
  }
  addRefs(selectedRefs, additionalRefs);
  return uniqueSorted([...selectedRefs].filter((ref) => availableRefs.has(ref)));
}

function requiredVersionRef(versionRefsByRef: Map<string, string>, objectKey: string): string {
  const versionRef = versionRefsByRef.get(objectKey);
  if (!versionRef) throw new Error(`missing immutable Library version for selected object: ${objectKey}`);
  return versionRef;
}

function candidateEntries(packet: CandidatePacket): Array<{ ref: string; versionRef?: string | null }> {
  return [
    ...packet.workflowTemplateCandidates,
    ...Object.values(packet.agentCandidatesByCapability).flat(),
    ...Object.values(packet.profileCandidatesByAgent).flat(),
    ...Object.values(packet.skillCandidatesByProfile).flat(),
    ...Object.values(packet.toolCandidatesByProfile).flat(),
    ...Object.values(packet.mcpGrantCandidatesByProfile).flat(),
    ...Object.values(packet.vaultLeaseCandidatesByProfile).flat(),
    ...Object.values(packet.instructionCandidatesByProfile).flat(),
    ...packet.artifactContractCandidates,
    ...Object.values(packet.evaluatorCandidatesByArtifact).flat(),
    ...packet.policyConstraints,
    ...(packet.graphMetadataCandidates?.nodes ?? []),
  ];
}

function addRefs(target: Set<string>, refs: string[]): void {
  for (const ref of refs) {
    target.add(ref);
  }
}

function flattenCandidateRefs(values: Record<string, Array<{ ref: string }>>): string[] {
  return uniqueSorted(Object.values(values).flat().map((candidate) => candidate.ref));
}

function graphRefsByKind(packet: CandidatePacket, kind: string): string[] {
  return (packet.graphMetadataCandidates?.nodes ?? [])
    .filter((node) => node.kind === kind)
    .map((node) => node.ref);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
