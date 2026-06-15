import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";
import { softwareDomainPack } from "../../domain-packs/software.ts";

export function buildDomainPacksPageModel(db: SouthstarDb, input: { domainPackId?: string } = {}) {
  const packs = [softwareDomainPack];
  const selected = packs.find((pack) => pack.id === (input.domainPackId ?? softwareDomainPack.id)) ?? softwareDomainPack;
  const validations = listResources(db, { resourceType: "domain_pack_validation" }).filter((resource) => resource.resourceKey.includes(selected.id));
  const previews = listResources(db, { resourceType: "workflow_preview" }).filter((resource) => resource.resourceKey.includes(selected.id));
  const snapshots = listResources(db, { resourceType: "domain_pack_snapshot" }).filter((resource) => resource.resourceKey.includes(selected.id));
  return {
    surface: "southstar.ui.domain-packs.v1" as const,
    domainPacks: packs.map((pack) => ({ id: pack.id, version: pack.version, displayName: pack.displayName, intents: pack.intents.length })),
    selectedPack: {
      id: selected.id,
      version: selected.version,
      displayName: selected.displayName,
      dslText: JSON.stringify(selected, null, 2),
      intents: selected.intents,
      roles: selected.roles,
      agentProfiles: selected.agentProfiles,
      skills: [...new Set(selected.agentProfiles.flatMap((profile) => profile.skillRefs))],
      mcpGrants: [...new Set(selected.agentProfiles.flatMap((profile) => profile.mcpGrantRefs))],
      artifactContracts: selected.artifactContracts,
      evaluatorPipeline: selected.evaluatorPipelines,
      stopConditions: selected.stopConditions,
      workflowTemplates: selected.workflowTemplates,
    },
    validationDiagnostics: validations.map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload })),
    workflowPreviews: previews.map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload })),
    publishedSnapshots: snapshots.map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload })),
  };
}
