import type { SouthstarDb } from "../../db/postgres.ts";
import { syncLibraryFileToGraph, writeLibraryFile } from "../files/library-file-store.ts";
import { findLibraryEdgesFrom, findLibraryObjectByKey } from "../library-graph-store.ts";
import type { LibraryDefinitionKind } from "../types.ts";
import {
  validateGeneratedNodeProfile,
  type GeneratedProfileValidationResult,
} from "./generated-profile-validator.ts";

export type NodeProfileDraft = {
  draftId: string;
  profile: {
    profileId: string;
    nodeId: string;
    scope: string;
    title: string;
    agentRef: string;
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    instructionRefs: string[];
  };
  validation: GeneratedProfileValidationResult;
};

export type ComposeNodeProfileDraftInput = {
  scope: string;
  nodeId: string;
  requirement: string;
  preferredAgentRef: string;
  templateId?: string;
};

export type SaveNodeProfileDraftInput = {
  root: string;
  draft: NodeProfileDraft;
  templateId: string;
  actor: string;
  reason: string;
};

export async function composeNodeProfileDraft(
  db: SouthstarDb,
  input: ComposeNodeProfileDraftInput,
): Promise<NodeProfileDraft> {
  const profileSlug = input.templateId
    ? slug(input.templateId.replace(/^template\./, ""))
    : slug(input.requirement);
  const nodeSlug = slug(input.nodeId);
  const profile = {
    profileId: `profile.generated.${profileSlug}.${nodeSlug}`,
    nodeId: nodeSlug,
    scope: input.scope,
    title: titleFromNodeId(input.nodeId),
    agentRef: input.preferredAgentRef,
    skillRefs: await approvedEdgeRefs(db, input.preferredAgentRef, "supports_skill", "skill_spec", input.scope),
    toolGrantRefs: [] as string[],
    mcpGrantRefs: [] as string[],
    instructionRefs: [] as string[],
  };

  profile.toolGrantRefs = await approvedRefsRequiredBySkills(db, profile.skillRefs, "requires_tool", "tool_definition", input.scope);
  profile.mcpGrantRefs = await approvedRefsRequiredBySkills(db, profile.skillRefs, "allows_mcp_grant", "mcp_tool_grant", input.scope);
  profile.instructionRefs = await approvedRefsRequiredBySkills(
    db,
    profile.skillRefs,
    "uses_instruction",
    "instruction_template",
    input.scope,
  );

  const validation = await validateGeneratedNodeProfile(db, profile);
  return { draftId: `${profile.profileId}@draft`, profile, validation };
}

export async function saveNodeProfileDraft(
  db: SouthstarDb,
  input: SaveNodeProfileDraftInput,
): Promise<{ relativePath: string; sync: Awaited<ReturnType<typeof syncLibraryFileToGraph>> }> {
  if (!input.draft.validation.ok) throw new Error("cannot save invalid node profile draft");
  const templateSlug = slug(input.templateId.replace(/^template\./, ""));
  const nodeSlug = slug(input.draft.profile.nodeId);
  const canonicalDraft: NodeProfileDraft = {
    ...input.draft,
    draftId: `profile.generated.${templateSlug}.${nodeSlug}@draft`,
    profile: {
      ...input.draft.profile,
      profileId: `profile.generated.${templateSlug}.${nodeSlug}`,
      nodeId: nodeSlug,
      title: titleFromNodeId(input.draft.profile.nodeId),
    },
  };
  const validation = await validateGeneratedNodeProfile(db, canonicalDraft.profile);
  if (!validation.ok) throw new Error("cannot save invalid node profile draft");

  const relativePath = `profiles/generated/${templateSlug}/${nodeSlug}.profile.yaml`;
  await writeLibraryFile({
    root: input.root,
    relativePath,
    content: renderProfileYaml(canonicalDraft.profile, {
      templateId: input.templateId,
      actor: input.actor,
      reason: input.reason,
    }),
  });
  const sync = await syncLibraryFileToGraph(db, { root: input.root, relativePath });
  return { relativePath, sync };
}

async function approvedRefsRequiredBySkills(
  db: SouthstarDb,
  skillRefs: string[],
  edgeType: "requires_tool" | "allows_mcp_grant" | "uses_instruction",
  expectedKind: LibraryDefinitionKind,
  scope: string,
): Promise<string[]> {
  const refs = await Promise.all(
    skillRefs.map((skillRef) => approvedEdgeRefs(db, skillRef, edgeType, expectedKind, scope)),
  );
  return uniqueSorted(refs.flat());
}

async function approvedEdgeRefs(
  db: SouthstarDb,
  fromObjectKey: string,
  edgeType: "supports_skill" | "requires_tool" | "allows_mcp_grant" | "uses_instruction",
  expectedKind: LibraryDefinitionKind,
  scope: string,
): Promise<string[]> {
  const edges = await findLibraryEdgesFrom(db, fromObjectKey, edgeType, { scope });
  const refs = [];
  for (const edge of edges) {
    const object = await findLibraryObjectByKey(db, edge.toObjectKey);
    if (!object || object.status !== "approved" || object.objectKind !== expectedKind) continue;
    if (!objectVisibleInScope(object.state, scope)) continue;
    refs.push(edge.toObjectKey);
  }
  return uniqueSorted(refs);
}

function renderProfileYaml(
  profile: NodeProfileDraft["profile"],
  source: { templateId: string; actor: string; reason: string },
): string {
  return `schemaVersion: southstar.library.generated_agent_profile_file.v1
id: ${yamlScalar(profile.profileId)}
title: ${yamlScalar(profile.title)}
scope: ${yamlScalar(profile.scope)}
status: draft
agentRef: ${yamlScalar(profile.agentRef)}
skillRefs:
${yamlList(profile.skillRefs)}
toolGrantRefs:
${yamlList(profile.toolGrantRefs)}
mcpGrantRefs:
${yamlList(profile.mcpGrantRefs)}
instructionRefs:
${yamlList(profile.instructionRefs)}
source:
  kind: profile-draft-compose
  templateRef: ${yamlScalar(source.templateId)}
  nodeId: ${yamlScalar(profile.nodeId)}
  actor: ${yamlScalar(source.actor)}
  reason: ${yamlScalar(source.reason)}
`;
}

function objectVisibleInScope(state: Record<string, unknown>, scope: string): boolean {
  const objectScope = typeof state.scope === "string" && state.scope.length > 0 ? state.scope : "global";
  if (objectScope === "global" || objectScope === scope) return true;
  return Array.isArray(state.domainRefs) && state.domainRefs.includes(scope);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function titleFromNodeId(nodeId: string): string {
  const title = slug(nodeId).split("-").filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
  return title || nodeId;
}

function yamlList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `  - ${yamlScalar(value)}`).join("\n") : "  []";
}

function yamlScalar(value: string): string {
  if (/^[a-zA-Z0-9._/-]+$/.test(value) && !/^(true|false|null|[-]?\d+)$/i.test(value)) return value;
  return JSON.stringify(value);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 64) || "profile";
}
