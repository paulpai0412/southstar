import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { createLearningEdge } from "./learning-graph.ts";
import type { LearningEdgeType, WikiLinkReadModel, WikiLinkRelation, WikiLinkStatus, WikiPageReadModel } from "./types.ts";

export type ProposeWikiLinkInput = {
  fromNodeId: string;
  toNodeId: string;
  relation: WikiLinkRelation;
  actor: string;
  reason: string;
  confidence: number;
  evidenceNodeRefs: string[];
};

export type ModerateWikiLinkInput = {
  edgeId: string;
  actor: string;
  reason: string;
};

const RELATION_TO_EDGE_TYPE: Record<WikiLinkRelation, LearningEdgeType> = {
  supports: "SUPPORTED_BY",
  contradicts: "CONFLICTS_WITH",
  supersedes: "SUPERSEDES",
  derived_from: "DERIVED_FROM",
  used_by: "INJECTED_CARD",
  improved: "HELPED",
  regressed: "HURT",
  related_topic: "BASED_ON",
  same_as: "BASED_ON",
  broader_than: "BASED_ON",
  narrower_than: "BASED_ON",
};

const EDGE_TYPE_TO_RELATION: Partial<Record<LearningEdgeType, WikiLinkRelation>> = {
  SUPPORTED_BY: "supports",
  CONFLICTS_WITH: "contradicts",
  SUPERSEDES: "supersedes",
  DERIVED_FROM: "derived_from",
  INJECTED_CARD: "used_by",
  HELPED: "improved",
  HURT: "regressed",
  BASED_ON: "related_topic",
};

export async function getWikiPage(db: SouthstarDb, nodeId: string): Promise<WikiPageReadModel> {
  const node = await getNode(db, nodeId);
  if (!node) throw new Error(`wiki node not found: ${nodeId}`);
  const forwardLinks = await listForwardLinks(db, nodeId);
  const backlinks = await listBacklinks(db, nodeId);
  const allLinks = [...forwardLinks, ...backlinks];
  const payload = asRecord(node.payload_jsonb);
  return {
    nodeId,
    nodeType: node.node_type as WikiPageReadModel["nodeType"],
    title: stringValue(payload.title, node.summary_text || node.id),
    summary: node.summary_text,
    status: node.status,
    topicKey: typeof payload.topicKey === "string" ? payload.topicKey : undefined,
    aliases: Array.isArray(payload.aliases) ? payload.aliases.filter((item): item is string => typeof item === "string") : [],
    forwardLinks,
    backlinks,
    evidenceLinks: allLinks.filter((link) => link.relation === "supports" || link.relation === "derived_from"),
    runtimeUsageLinks: allLinks.filter((link) => link.relation === "used_by"),
    downstreamImpactLinks: allLinks.filter((link) => ["improved", "regressed", "related_topic"].includes(link.relation)),
    conflictLinks: allLinks.filter((link) => link.relation === "contradicts"),
    supersessionLinks: allLinks.filter((link) => link.relation === "supersedes"),
  };
}

export async function proposeWikiLink(db: SouthstarDb, input: ProposeWikiLinkInput): Promise<{ edgeId: string }> {
  await validateWikiLink(db, input);
  const edge = await createLearningEdge(db, {
    fromNodeId: input.fromNodeId,
    edgeType: RELATION_TO_EDGE_TYPE[input.relation],
    toNodeId: input.toNodeId,
    weight: input.confidence,
    evidence: {
      wikiRelation: input.relation,
      status: "proposed",
      confidence: input.confidence,
      reason: input.reason,
      evidenceNodeRefs: input.evidenceNodeRefs,
      proposedBy: input.actor,
    },
  });
  return { edgeId: edge.id };
}

export async function approveWikiLink(db: SouthstarDb, input: ModerateWikiLinkInput): Promise<void> {
  await moderateWikiLink(db, input, "active");
}

export async function rejectWikiLink(db: SouthstarDb, input: ModerateWikiLinkInput): Promise<void> {
  await moderateWikiLink(db, input, "rejected");
}

export async function listBacklinks(db: SouthstarDb, nodeId: string): Promise<WikiLinkReadModel[]> {
  const rows = await db.query<WikiEdgeRow>(
    "select * from southstar.learning_edges where to_node_id = $1 order by created_at, id",
    [nodeId],
  );
  return rows.rows.map(mapWikiLink);
}

export async function listForwardLinks(db: SouthstarDb, nodeId: string): Promise<WikiLinkReadModel[]> {
  const rows = await db.query<WikiEdgeRow>(
    "select * from southstar.learning_edges where from_node_id = $1 order by created_at, id",
    [nodeId],
  );
  return rows.rows.map(mapWikiLink);
}

export async function findOrphanKnowledgeCards(db: SouthstarDb): Promise<Array<{ nodeId: string; topicKey: string }>> {
  const rows = await db.query<{ id: string; payload_jsonb: unknown }>(
    `select node.id, node.payload_jsonb
     from southstar.learning_nodes node
     where node.node_type = 'knowledge_card'
       and node.status = 'active'
       and not exists (
         select 1 from southstar.learning_edges edge
         where edge.from_node_id = node.id or edge.to_node_id = node.id
       )
     order by node.created_at, node.id`,
  );
  return rows.rows.map((row) => ({ nodeId: row.id, topicKey: stringValue(asRecord(row.payload_jsonb).topicKey, row.id) }));
}

export async function normalizeWikiAliases(db: SouthstarDb, input: { nodeId: string; actor: string; reason: string }): Promise<{ nodeId: string; aliases: string[] }> {
  const node = await getNode(db, input.nodeId);
  if (!node) throw new Error(`wiki node not found: ${input.nodeId}`);
  const payload = asRecord(node.payload_jsonb);
  const rawAliases = Array.isArray(payload.aliases) ? payload.aliases.filter((item): item is string => typeof item === "string") : [];
  const aliases = [...new Set(rawAliases.map(normalizeAlias).filter((alias) => alias.length > 0))].sort();
  const nextPayload = { ...payload, aliases, aliasNormalization: { actor: input.actor, reason: input.reason, normalizedAt: new Date().toISOString() } };
  await db.query("update southstar.learning_nodes set payload_jsonb = $2::jsonb, updated_at = now() where id = $1", [input.nodeId, JSON.stringify(nextPayload)]);
  return { nodeId: input.nodeId, aliases };
}

export async function rewireStaleWikiLinks(db: SouthstarDb, input: { actor: string; reason: string }): Promise<{ rewiredEdges: Array<{ oldEdgeId: string; newEdgeId: string; fromNodeId: string; toNodeId: string }> }> {
  const supersessions = await db.query<{ old_id: string; new_id: string }>(
    `select edge.from_node_id as old_id, edge.to_node_id as new_id
     from southstar.learning_edges edge
     join southstar.learning_nodes old_node on old_node.id = edge.from_node_id
     join southstar.learning_nodes new_node on new_node.id = edge.to_node_id
     where edge.edge_type = 'SUPERSEDES'
       and old_node.status = 'superseded'
       and new_node.status <> 'superseded'`,
  );
  const replacement = new Map(supersessions.rows.map((row) => [row.old_id, row.new_id]));
  if (replacement.size === 0) return { rewiredEdges: [] };

  const edges = await db.query<WikiEdgeRow>(
    `select * from southstar.learning_edges
     where edge_type <> 'SUPERSEDES'
       and ((from_node_id = any($1::text[])) or (to_node_id = any($1::text[])))
     order by created_at, id`,
    [[...replacement.keys()]],
  );
  const rewiredEdges: Array<{ oldEdgeId: string; newEdgeId: string; fromNodeId: string; toNodeId: string }> = [];
  for (const edge of edges.rows) {
    const fromNodeId = replacement.get(edge.from_node_id) ?? edge.from_node_id;
    const toNodeId = replacement.get(edge.to_node_id) ?? edge.to_node_id;
    const evidence = asRecord(edge.evidence_jsonb);
    if (fromNodeId === edge.from_node_id && toNodeId === edge.to_node_id) continue;
    const newEdge = await createLearningEdge(db, {
      fromNodeId,
      edgeType: edge.edge_type,
      toNodeId,
      weight: edge.weight,
      evidence: { ...evidence, status: "active", rewiredFromEdgeId: edge.id, rewiredBy: input.actor, rewireReason: input.reason },
    });
    await db.query(
      "update southstar.learning_edges set evidence_jsonb = $2::jsonb where id = $1",
      [edge.id, JSON.stringify({ ...evidence, status: "stale", rewiredToEdgeId: newEdge.id, rewiredBy: input.actor, rewireReason: input.reason })],
    );
    rewiredEdges.push({ oldEdgeId: edge.id, newEdgeId: newEdge.id, fromNodeId, toNodeId });
  }
  return { rewiredEdges };
}

export async function openWikiConflict(db: SouthstarDb, input: { fromNodeId: string; toNodeId: string; actor: string; reason: string; evidenceNodeRefs: string[] }): Promise<{ conflictId: string; edgeId: string }> {
  const edge = await proposeWikiLink(db, {
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    relation: "contradicts",
    actor: input.actor,
    reason: input.reason,
    confidence: 0.7,
    evidenceNodeRefs: input.evidenceNodeRefs,
  });
  const conflictId = `wiki-conflict-${randomUUID()}`;
  await upsertRuntimeResourcePg(db, {
    id: conflictId,
    resourceType: "wiki_conflict",
    resourceKey: conflictId,
    scope: "evolution",
    status: "open",
    title: "Wiki conflict",
    payload: { conflictId, edgeId: edge.edgeId, fromNodeId: input.fromNodeId, toNodeId: input.toNodeId, reason: input.reason, openedBy: input.actor, evidenceNodeRefs: input.evidenceNodeRefs },
    summary: { edgeId: edge.edgeId, fromNodeId: input.fromNodeId, toNodeId: input.toNodeId },
  });
  return { conflictId, edgeId: edge.edgeId };
}

export async function resolveWikiConflict(db: SouthstarDb, input: { conflictId: string; resolution: "rejected" | "superseded" | "accepted"; actor: string; reason: string }): Promise<void> {
  const row = await db.maybeOne<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'wiki_conflict' and resource_key = $1",
    [input.conflictId],
  );
  if (!row) throw new Error(`wiki conflict not found: ${input.conflictId}`);
  const edgeId = stringValue(row.payload_json.edgeId, "");
  if (edgeId) {
    const edge = await db.maybeOne<WikiEdgeRow>("select * from southstar.learning_edges where id = $1", [edgeId]);
    if (edge) {
      const evidence = asRecord(edge.evidence_jsonb);
      await db.query(
        "update southstar.learning_edges set evidence_jsonb = $2::jsonb where id = $1",
        [edgeId, JSON.stringify({ ...evidence, status: input.resolution === "accepted" ? "active" : input.resolution, resolvedBy: input.actor, resolutionReason: input.reason })],
      );
    }
  }
  await upsertRuntimeResourcePg(db, {
    id: input.conflictId,
    resourceType: "wiki_conflict",
    resourceKey: input.conflictId,
    scope: "evolution",
    status: "resolved",
    title: "Wiki conflict",
    payload: { ...row.payload_json, resolution: input.resolution, resolvedBy: input.actor, resolutionReason: input.reason },
    summary: { resolution: input.resolution, edgeId },
  });
}

export async function findStaleWikiLinks(db: SouthstarDb): Promise<Array<{ edgeId: string; reason: string }>> {
  const rows = await db.query<{ edge_id: string; from_status: string; to_status: string }>(
    `select edge.id as edge_id, source.status as from_status, target.status as to_status
     from southstar.learning_edges edge
     join southstar.learning_nodes source on source.id = edge.from_node_id
     join southstar.learning_nodes target on target.id = edge.to_node_id
     where source.status = 'superseded' or target.status = 'superseded'
     order by edge.created_at, edge.id`,
  );
  return rows.rows.map((row) => ({ edgeId: row.edge_id, reason: `link touches superseded node (${row.from_status} -> ${row.to_status})` }));
}

async function moderateWikiLink(db: SouthstarDb, input: ModerateWikiLinkInput, status: WikiLinkStatus): Promise<void> {
  const edge = await db.maybeOne<WikiEdgeRow>("select * from southstar.learning_edges where id = $1", [input.edgeId]);
  if (!edge) throw new Error(`wiki link not found: ${input.edgeId}`);
  rejectUnsafeText(input.reason);
  const evidence = {
    ...asRecord(edge.evidence_jsonb),
    status,
    moderatedBy: input.actor,
    moderationReason: input.reason,
  };
  await db.query("update southstar.learning_edges set evidence_jsonb = $2::jsonb where id = $1", [input.edgeId, JSON.stringify(evidence)]);
}

async function validateWikiLink(db: SouthstarDb, input: ProposeWikiLinkInput): Promise<void> {
  rejectUnsafeText(JSON.stringify(input));
  if (!RELATION_TO_EDGE_TYPE[input.relation]) throw new Error(`unsupported wiki relation: ${input.relation}`);
  if (!input.reason.trim()) throw new Error("wiki link reason is required");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error("wiki link confidence must be between 0 and 1");
  }
  if (input.relation !== "same_as" && input.evidenceNodeRefs.length === 0) {
    throw new Error("wiki link evidenceNodeRefs are required");
  }
  const source = await getNode(db, input.fromNodeId);
  if (!source) throw new Error(`source node not found: ${input.fromNodeId}`);
  const target = await getNode(db, input.toNodeId);
  if (!target) throw new Error(`target node not found: ${input.toNodeId}`);
  for (const evidenceNodeRef of input.evidenceNodeRefs) {
    if (!await getNode(db, evidenceNodeRef)) throw new Error(`evidence node not found: ${evidenceNodeRef}`);
  }
}

async function getNode(db: SouthstarDb, nodeId: string): Promise<WikiNodeRow | null> {
  return await db.maybeOne<WikiNodeRow>("select * from southstar.learning_nodes where id = $1", [nodeId]);
}

type WikiNodeRow = {
  id: string;
  node_type: string;
  status: string;
  payload_jsonb: unknown;
  summary_text: string;
};

type WikiEdgeRow = {
  id: string;
  from_node_id: string;
  edge_type: LearningEdgeType;
  to_node_id: string;
  weight: number;
  evidence_jsonb: unknown;
  created_at: Date | string;
};

function mapWikiLink(row: WikiEdgeRow): WikiLinkReadModel {
  const evidence = asRecord(row.evidence_jsonb);
  const relation = wikiRelation(evidence.wikiRelation, row.edge_type);
  return {
    edgeId: row.id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    relation,
    status: wikiStatus(evidence.status),
    confidence: numberValue(evidence.confidence, row.weight ?? 1),
    reason: stringValue(evidence.reason, ""),
    evidenceNodeRefs: Array.isArray(evidence.evidenceNodeRefs)
      ? evidence.evidenceNodeRefs.filter((item): item is string => typeof item === "string")
      : [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function wikiRelation(value: unknown, edgeType: LearningEdgeType): WikiLinkRelation {
  if (typeof value === "string" && isWikiRelation(value)) return value;
  return EDGE_TYPE_TO_RELATION[edgeType] ?? "related_topic";
}

function isWikiRelation(value: string): value is WikiLinkRelation {
  return [
    "supports",
    "contradicts",
    "supersedes",
    "derived_from",
    "used_by",
    "improved",
    "regressed",
    "related_topic",
    "same_as",
    "broader_than",
    "narrower_than",
  ].includes(value);
}

function wikiStatus(value: unknown): WikiLinkStatus {
  return typeof value === "string" && ["proposed", "active", "rejected", "stale", "superseded"].includes(value)
    ? value as WikiLinkStatus
    : "active";
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\-_]+/g, " ").replace(/\s+/g, " ");
}

function rejectUnsafeText(text: string): void {
  if (text.length > 16_000) throw new Error("wiki link payload is too large");
  if (/raw transcript/i.test(text) || /"rawTranscript"\s*:/.test(text)) throw new Error("raw transcript content is not allowed in wiki links");
  if (/\b(?:ghp|github_pat|sk|xoxb|xoxp)_[A-Za-z0-9_\-]{20,}\b/.test(text)) throw new Error("secret-like content is not allowed in wiki links");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
