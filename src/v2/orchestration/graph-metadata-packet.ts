import type { SouthstarDb } from "../db/postgres.ts";
import { listLibraryEdges, listLibraryObjects } from "../design-library/library-graph-store.ts";
import { isRuntimeProfilePrimitiveCandidate } from "../design-library/profile-composer/graph-profile-candidate-resolver.ts";
import type {
  GraphMetadataCandidatePacket,
  GraphMetadataEdgeCandidate,
  GraphMetadataNodeCandidate,
  LibraryDefinitionKind,
  RequirementSpecV2,
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
  input: { scope: string; requirementSpec?: RequirementSpecV2 },
): Promise<GraphMetadataCandidatePacket> {
  const approvedObjects = await listLibraryObjects(db, { status: "approved" });
  const executableObjects = approvedObjects
    .filter((object) => INCLUDED_KINDS.has(object.objectKind) && isRuntimeProfilePrimitiveCandidate(object));
  const executableKeys = new Set(executableObjects.map((object) => object.objectKey));
  const objectsByKey = new Map(approvedObjects.map((object) => [object.objectKey, object]));
  const activeEdges = await listLibraryEdges(db, { status: "active" });
  const unavailableSkillRefs = new Set(
    activeEdges
      .filter((edge) => {
        const source = objectsByKey.get(edge.fromObjectKey);
        const target = objectsByKey.get(edge.toObjectKey);
        if (source?.objectKind !== "skill_spec" || !target || executableKeys.has(target.objectKey)) return false;
        if (target.objectKind === "tool_definition") {
          return ["requires_tool", "allows_tool", "uses"].includes(edge.edgeType);
        }
        if (target.objectKind === "mcp_tool_grant") {
          return ["allows_mcp_grant", "uses"].includes(edge.edgeType);
        }
        if (target.objectKind === "instruction_template") {
          return ["uses_instruction", "uses"].includes(edge.edgeType);
        }
        return false;
      })
      .map((edge) => edge.fromObjectKey),
  );
  const objects = executableObjects.filter((object) => !unavailableSkillRefs.has(object.objectKey));
  const availableKeys = new Set(objects.map((object) => object.objectKey));
  const edges = activeEdges
    .filter((edge) => availableKeys.has(edge.fromObjectKey) && availableKeys.has(edge.toObjectKey));
  const requiredRefs = new Set([
    ...(input.requirementSpec?.requiredCapabilities ?? []),
    ...(input.requirementSpec?.expectedArtifacts ?? []),
  ]);
  const pinnedRefs = new Set(requiredRefs);
  for (const edge of edges) {
    if (requiredRefs.has(edge.fromObjectKey)) pinnedRefs.add(edge.toObjectKey);
    if (requiredRefs.has(edge.toObjectKey)) pinnedRefs.add(edge.fromObjectKey);
  }
  const queryTokens = requirementTokens(input.requirementSpec);
  const nodes = selectRankedNodes(
    objects.map(toNode),
    { scope: input.scope, queryTokens, pinnedRefs },
  );
  const selectedKeys = new Set(nodes.map((node) => node.ref));
  const selectedEdges = edges
    .filter((edge) => selectedKeys.has(edge.fromObjectKey) && selectedKeys.has(edge.toObjectKey));

  return {
    schemaVersion: "southstar.graph_metadata_candidates.v1",
    scope: input.scope,
    nodes,
    edges: selectedEdges.map(toEdge).sort((left, right) => `${left.from}|${left.type}|${left.to}`.localeCompare(`${right.from}|${right.type}|${right.to}`)),
  };
}

function selectRankedNodes(
  nodes: GraphMetadataNodeCandidate[],
  input: { scope: string; queryTokens: Set<string>; pinnedRefs: Set<string> },
): GraphMetadataNodeCandidate[] {
  const byKind = new Map<LibraryDefinitionKind, GraphMetadataNodeCandidate[]>();
  for (const node of nodes) {
    const bucket = byKind.get(node.kind) ?? [];
    bucket.push(node);
    byKind.set(node.kind, bucket);
  }
  const selected: GraphMetadataNodeCandidate[] = [];
  for (const [kind, candidates] of byKind) {
    candidates.sort((left, right) => {
      const scoreDelta = relevanceScore(right, input) - relevanceScore(left, input);
      return scoreDelta || left.ref.localeCompare(right.ref);
    });
    selected.push(...candidates);
  }
  return [...new Map(selected.map((node) => [node.ref, node])).values()]
    .sort((left, right) => {
      const scoreDelta = relevanceScore(right, input) - relevanceScore(left, input);
      return scoreDelta || left.ref.localeCompare(right.ref);
    });
}

function relevanceScore(
  node: GraphMetadataNodeCandidate,
  input: { scope: string; queryTokens: Set<string>; pinnedRefs: Set<string> },
): number {
  let score = input.pinnedRefs.has(node.ref) ? 10_000 : 0;
  if (node.scope === input.scope) score += 100;
  if (node.scope === "global") score += 25;
  const haystack = [node.ref, node.title, node.description, node.bodyPreview, ...node.aliases]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
  for (const token of input.queryTokens) {
    if (haystack.includes(token)) score += token.length >= 6 ? 12 : 5;
  }
  return score;
}

function requirementTokens(requirementSpec: RequirementSpecV2 | undefined): Set<string> {
  if (!requirementSpec) return new Set();
  const text = [
    requirementSpec.summary,
    requirementSpec.workType,
    ...requirementSpec.requiredCapabilities,
    ...requirementSpec.expectedArtifacts,
    ...requirementSpec.acceptanceCriteria,
    ...requirementSpec.riskNotes,
    ...requirementSpec.workspaceAssumptions,
  ].join(" ").toLocaleLowerCase();
  return new Set((text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length >= 2));
}

function toNode(object: Awaited<ReturnType<typeof listLibraryObjects>>[number]): GraphMetadataNodeCandidate {
  const state = object.state;
  const title = stringValue(state.title) ?? stringValue(state.displayName) ?? object.objectKey;
  const bodyPreview = previewBody(stringValue(state.body));
  const description = stringValue(state.description) ?? descriptionFromBody(stringValue(state.body));
  return {
    ref: object.objectKey,
    kind: object.objectKind,
    status: object.status,
    versionRef: object.headVersionId,
    scope: stringValue(state.scope) ?? "global",
    title,
    ...(description ? { description } : {}),
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
  if (kind === "tool_definition") return pickDefined(state, ["runtimeToolNames", "operations", "allowedCommands", "access"]);
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
    .filter((line) => Boolean(line) && line !== "---" && !/^# (Identity|Source Definition)$/i.test(line) && !/^Imported .+ candidate from library import draft/i.test(line))
    .slice(0, 2)
    .join("\n");
  return compact.length > 0 ? compact.slice(0, BODY_PREVIEW_CHARS) : undefined;
}

function descriptionFromBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const match = body.match(/^description:\s*["']?(.+?)["']?\s*$/mi);
  return match?.[1]?.trim().slice(0, BODY_PREVIEW_CHARS);
}
