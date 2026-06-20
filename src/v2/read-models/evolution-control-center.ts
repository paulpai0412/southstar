import type { SouthstarDb } from "../db/postgres.ts";
import { envelopeReadModel } from "./envelope.ts";

export type EvolutionControlCenterData = {
  health: { status: "ready"; schema: "southstar" };
  counts: Record<string, number>;
  signals: unknown[];
  cards: unknown[];
  deltas: unknown[];
  experiments: unknown[];
  assets: unknown[];
  regression: unknown[];
  graph: null;
  selectedWikiNodeId?: string;
};

export async function buildEvolutionControlCenterReadModel(db: SouthstarDb) {
  const [signals, cards, deltas, experiments, assets, regression] = await Promise.all([
    listNodes(db, "learning_signal"),
    listNodes(db, "knowledge_card"),
    listResources(db, "delta_proposal"),
    listResources(db, "sandbox_experiment"),
    listResources(db, "asset_version"),
    listResources(db, "asset_regression_observation"),
  ]);
  const data: EvolutionControlCenterData = {
    health: { status: "ready", schema: "southstar" },
    counts: {
      signals: signals.length,
      cards: cards.length,
      deltas: deltas.length,
      experiments: experiments.length,
      assets: assets.length,
      regression: regression.length,
    },
    signals,
    cards,
    deltas,
    experiments,
    assets,
    regression,
    graph: null,
    selectedWikiNodeId: cards[0]?.id as string | undefined,
  };
  return envelopeReadModel({
    schemaVersion: "southstar.read_model.evolution_control_center.v1",
    kind: "evolution-control-center",
    data,
  });
}

async function listNodes(db: SouthstarDb, nodeType: string): Promise<Array<{ id: string; status: string; payload: unknown; summary: string }>> {
  const rows = await db.query<{ id: string; status: string; payload_jsonb: unknown; summary_text: string }>(
    "select id, status, payload_jsonb, summary_text from southstar.learning_nodes where node_type = $1 order by created_at desc, id limit 100",
    [nodeType],
  );
  return rows.rows.map((row) => ({ id: row.id, status: row.status, payload: row.payload_jsonb, summary: row.summary_text }));
}

async function listResources(db: SouthstarDb, resourceType: string): Promise<Array<{ id: string; status: string; payload: unknown; title?: string }>> {
  const rows = await db.query<{ resource_key: string; status: string; payload_json: unknown; title: string | null }>(
    "select resource_key, status, payload_json, title from southstar.runtime_resources where resource_type = $1 order by created_at desc, resource_key limit 100",
    [resourceType],
  );
  return rows.rows.map((row) => ({ id: row.resource_key, status: row.status, payload: row.payload_json, title: row.title ?? undefined }));
}
