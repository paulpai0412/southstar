import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type { GraphReadModel, LearningEdgeType, LearningNodeType } from "./types.ts";

export type CreateLearningNodeInput = {
  id?: string;
  nodeType: LearningNodeType;
  scope: string;
  status: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  resourceRef?: string;
  payload?: unknown;
  summaryText?: string;
};

export type CreateLearningEdgeInput = {
  id?: string;
  fromNodeId: string;
  edgeType: LearningEdgeType;
  toNodeId: string;
  weight?: number;
  evidence?: unknown;
};

export async function createLearningNode(db: SouthstarDb, input: CreateLearningNodeInput): Promise<{ id: string }> {
  const id = input.id ?? `${input.nodeType}-${randomUUID()}`;
  await db.query(
    `insert into southstar.learning_nodes (
      id, node_type, scope, status, run_id, task_id, session_id, resource_ref,
      payload_jsonb, summary_text, created_at, updated_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now(), now())
    on conflict(id) do update set
      node_type = excluded.node_type,
      scope = excluded.scope,
      status = excluded.status,
      run_id = excluded.run_id,
      task_id = excluded.task_id,
      session_id = excluded.session_id,
      resource_ref = excluded.resource_ref,
      payload_jsonb = excluded.payload_jsonb,
      summary_text = excluded.summary_text,
      updated_at = now()`,
    [
      id,
      input.nodeType,
      input.scope,
      input.status,
      input.runId ?? null,
      input.taskId ?? null,
      input.sessionId ?? null,
      input.resourceRef ?? null,
      JSON.stringify(input.payload ?? {}),
      input.summaryText ?? "",
    ],
  );
  return { id };
}

export async function createLearningEdge(db: SouthstarDb, input: CreateLearningEdgeInput): Promise<{ id: string }> {
  const id = input.id ?? randomUUID();
  await db.query(
    `insert into southstar.learning_edges (
      id, from_node_id, edge_type, to_node_id, weight, evidence_jsonb, created_at
    ) values ($1, $2, $3, $4, $5, $6::jsonb, now())
    on conflict(id) do update set
      from_node_id = excluded.from_node_id,
      edge_type = excluded.edge_type,
      to_node_id = excluded.to_node_id,
      weight = excluded.weight,
      evidence_jsonb = excluded.evidence_jsonb`,
    [id, input.fromNodeId, input.edgeType, input.toNodeId, input.weight ?? 1, JSON.stringify(input.evidence ?? {})],
  );
  return { id };
}

export async function getEvidenceSubgraph(db: SouthstarDb, nodeId: string, depth: number, filters?: { edgeTypes?: string[] }): Promise<GraphReadModel> {
  const boundedDepth = Math.max(0, Math.min(4, depth));
  const edgeTypes = filters?.edgeTypes ?? [];
  const rows = await db.query<GraphEdgeRow>(
    `with recursive walk(id, depth) as (
      select $1::text, 0
      union
      select case when edge.from_node_id = walk.id then edge.to_node_id else edge.from_node_id end, walk.depth + 1
      from walk
      join southstar.learning_edges edge on edge.from_node_id = walk.id or edge.to_node_id = walk.id
      where walk.depth < $2 and (cardinality($3::text[]) = 0 or edge.edge_type = any($3::text[]))
    ), nodes as (
      select distinct node.* from southstar.learning_nodes node join walk on walk.id = node.id limit 200
    )
    select
      node.id as node_id,
      node.node_type,
      node.status as node_status,
      node.summary_text,
      node.payload_jsonb,
      edge.id as edge_id,
      edge.from_node_id,
      edge.to_node_id,
      edge.edge_type,
      edge.weight
    from nodes node
    left join southstar.learning_edges edge
      on edge.from_node_id in (select id from nodes)
     and edge.to_node_id in (select id from nodes)
     and (cardinality($3::text[]) = 0 or edge.edge_type = any($3::text[]))`,
    [nodeId, boundedDepth, edgeTypes],
  );
  return graphFromRows(nodeId, rows.rows);
}

export async function getLineage(db: SouthstarDb, nodeId: string): Promise<GraphReadModel> {
  return await getEvidenceSubgraph(db, nodeId, 4, {
    edgeTypes: ["DERIVED_FROM", "SUPPORTED_BY", "BASED_ON", "PROMOTED_TO", "SUPERSEDES", "ROLLED_BACK_TO", "EVALUATED_BY"],
  });
}

export async function getImpactGraph(db: SouthstarDb, assetVersionId: string): Promise<GraphReadModel> {
  return await getEvidenceSubgraph(db, assetVersionId, 4, {
    edgeTypes: ["BASED_ON", "TESTED", "PROMOTED_TO", "SUPERSEDES", "ROLLED_BACK_TO", "HELPED", "HURT"],
  });
}

export async function getKnowledgeCardEvidence(db: SouthstarDb, cardId: string): Promise<GraphReadModel> {
  return await getEvidenceSubgraph(db, cardId, 2, { edgeTypes: ["SUPPORTED_BY", "DERIVED_FROM", "EVALUATED_BY", "FOUND_FAILURE", "FIXED_FAILURE"] });
}

async function getDirectionalSubgraph(
  db: SouthstarDb,
  nodeId: string,
  direction: "incoming" | "outgoing",
  edgeTypes: string[],
): Promise<GraphReadModel> {
  const joinCondition = direction === "incoming"
    ? "edge.to_node_id = walk.id"
    : "edge.from_node_id = walk.id";
  const nextId = direction === "incoming" ? "edge.from_node_id" : "edge.to_node_id";
  const rows = await db.query<GraphEdgeRow>(
    `with recursive walk(id, depth) as (
      select $1::text, 0
      union
      select ${nextId}, walk.depth + 1
      from walk
      join southstar.learning_edges edge on ${joinCondition}
      where walk.depth < 4 and edge.edge_type = any($2::text[])
    ), nodes as (
      select distinct node.* from southstar.learning_nodes node join walk on walk.id = node.id limit 200
    )
    select
      node.id as node_id,
      node.node_type,
      node.status as node_status,
      node.summary_text,
      node.payload_jsonb,
      edge.id as edge_id,
      edge.from_node_id,
      edge.to_node_id,
      edge.edge_type,
      edge.weight
    from nodes node
    left join southstar.learning_edges edge
      on edge.from_node_id in (select id from nodes)
     and edge.to_node_id in (select id from nodes)
     and edge.edge_type = any($2::text[])`,
    [nodeId, edgeTypes],
  );
  return graphFromRows(nodeId, rows.rows);
}

type GraphEdgeRow = {
  node_id: string;
  node_type: string;
  node_status: string;
  summary_text: string;
  payload_jsonb: unknown;
  edge_id: string | null;
  from_node_id: string | null;
  to_node_id: string | null;
  edge_type: string | null;
  weight: number | null;
};

function graphFromRows(centerNodeId: string, rows: GraphEdgeRow[]): GraphReadModel {
  const nodes = new Map<string, GraphReadModel["nodes"][number]>();
  const edges = new Map<string, GraphReadModel["edges"][number]>();
  for (const row of rows) {
    nodes.set(row.node_id, {
      id: row.node_id,
      type: row.node_type,
      label: row.summary_text || row.node_id,
      status: row.node_status,
      summary: row.summary_text,
      payload: row.payload_jsonb,
    });
    if (row.edge_id && row.from_node_id && row.to_node_id && row.edge_type) {
      edges.set(row.edge_id, {
        id: row.edge_id,
        from: row.from_node_id,
        to: row.to_node_id,
        type: row.edge_type,
        weight: row.weight ?? undefined,
      });
    }
  }
  return { centerNodeId, nodes: [...nodes.values()], edges: [...edges.values()] };
}
