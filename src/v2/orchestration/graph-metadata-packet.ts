import type { SouthstarDb } from "../db/postgres.ts";
import { listLibraryEdges, listLibraryObjects } from "../design-library/library-graph-store.ts";
import type {
  GraphMetadataCandidatePacket,
  GraphMetadataEdgeCandidate,
  GraphMetadataNodeCandidate,
  LibraryDefinitionKind,
} from "../design-library/types.ts";

const INCLUDED_KINDS: ReadonlySet<LibraryDefinitionKind> = new Set([
  "agent_definition",
  "skill_spec",
  "tool_definition",
  "mcp_tool_grant",
  "instruction_template",
  "artifact_contract",
  "evaluator_profile",
  "capability_spec",
  "policy_bundle",
  "workflow_template",
  "vault_lease_policy",
]);

const BODY_PREVIEW_CHARS = 160;

export async function buildGraphMetadataCandidatePacket(
  db: SouthstarDb,
  input: { scope: string },
): Promise<GraphMetadataCandidatePacket> {
  const objects = (await listLibraryObjects(db, { scope: input.scope, status: "approved" }))
    .filter((object) => INCLUDED_KINDS.has(object.objectKind));
  const objectKeys = new Set(objects.map((object) => object.objectKey));
  const edges = (await listLibraryEdges(db, { scope: input.scope, status: "active" }))
    .filter((edge) => objectKeys.has(edge.fromObjectKey) && objectKeys.has(edge.toObjectKey));

  return {
    schemaVersion: "southstar.graph_metadata_candidates.v1",
    scope: input.scope,
    nodes: objects.map(toNode).sort((left, right) => left.ref.localeCompare(right.ref)),
    edges: edges.map(toEdge).sort((left, right) => `${left.from}|${left.type}|${left.to}`.localeCompare(`${right.from}|${right.type}|${right.to}`)),
  };
}

function toNode(object: Awaited<ReturnType<typeof listLibraryObjects>>[number]): GraphMetadataNodeCandidate {
  const state = object.state;
  const title = stringValue(state.title) ?? stringValue(state.displayName) ?? object.objectKey;
  const bodyPreview = previewBody(stringValue(state.body));
  return {
    ref: object.objectKey,
    kind: object.objectKind,
    status: object.status,
    versionRef: object.headVersionId,
    scope: stringValue(state.scope) ?? "global",
    title,
    ...(stringValue(state.description) ? { description: stringValue(state.description) } : {}),
    aliases: stringArray(state.aliases),
    ...(bodyPreview ? { bodyPreview } : {}),
    runtime: compactRuntimeState(object.objectKind, state),
  };
}

function toEdge(edge: Awaited<ReturnType<typeof listLibraryEdges>>[number]): GraphMetadataEdgeCandidate {
  return {
    from: edge.fromObjectKey,
    type: edge.edgeType,
    to: edge.toObjectKey,
    scope: edge.scope,
    weight: edge.weight,
    ...(stringValue(edge.metadata.rationale) ? { rationale: stringValue(edge.metadata.rationale) } : {}),
  };
}

function compactRuntimeState(kind: LibraryDefinitionKind, state: Record<string, unknown>): Record<string, unknown> {
  if (kind === "tool_definition") return pickDefined(state, ["toolName", "proxyToolName", "allowedCommands", "access"]);
  if (kind === "mcp_tool_grant") return pickDefined(state, ["serverId", "allowedTools"]);
  if (kind === "skill_spec") return pickDefined(state, ["allowedTools", "requiredMounts", "mcpRequirements", "artifactContracts", "sourcePath", "assetBundlePath"]);
  if (kind === "agent_definition") return pickDefined(state, ["runtimeRole"]);
  return {};
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function previewBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const compact = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n");
  return compact.length > 0 ? compact.slice(0, BODY_PREVIEW_CHARS) : undefined;
}
