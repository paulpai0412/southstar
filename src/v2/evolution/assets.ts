import { createHash, randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { createLearningEdge, createLearningNode } from "./learning-graph.ts";
import type { AssetVersion } from "./types.ts";

export type CreateAssetVersionInput = {
  assetKind: AssetVersion["assetKind"];
  assetRef: string;
  version: string;
  parentVersion?: string;
  payload: unknown;
  status?: AssetVersion["status"];
  promotedByDeltaId?: string;
};

export type PromoteAssetVersionInput = {
  assetId: string;
  promotedByDeltaId?: string;
  actor: string;
  reason: string;
  targetStatus?: "active" | "canary";
  canaryPercent?: number;
};

export type RollbackInput = {
  assetId: string;
  actor: string;
  reason: string;
};

export async function createAssetVersion(db: SouthstarDb, input: CreateAssetVersionInput): Promise<{ id: string }> {
  const id = `asset-${hash([input.assetKind, input.assetRef, input.version].join(":"))}`;
  const now = new Date().toISOString();
  const asset: AssetVersion = {
    id,
    assetKind: input.assetKind,
    assetRef: input.assetRef,
    version: input.version,
    parentVersion: input.parentVersion,
    contentHash: hash(JSON.stringify(input.payload)),
    payload: input.payload,
    status: input.status ?? "candidate",
    promotedByDeltaId: input.promotedByDeltaId,
    createdAt: now,
  };
  await upsertAssetResource(db, asset);
  await createLearningNode(db, {
    id,
    nodeType: nodeTypeFor(input.assetKind),
    scope: "evolution",
    status: asset.status,
    resourceRef: id,
    payload: asset,
    summaryText: `${input.assetKind} ${input.assetRef}@${input.version}`,
  });
  return { id };
}

export async function promoteAssetVersion(db: SouthstarDb, input: PromoteAssetVersionInput): Promise<void> {
  const asset = await loadAsset(db, input.assetId);
  const targetStatus = input.targetStatus ?? "active";
  if (targetStatus === "active") {
    const activeSiblings = await listAssets(db, asset.assetKind, asset.assetRef, "active");
    for (const sibling of activeSiblings) {
      if (sibling.id === asset.id) continue;
      await updateAssetStatus(db, sibling, "superseded", { supersededByAssetId: asset.id, supersededReason: input.reason });
      await createLearningEdge(db, {
        fromNodeId: asset.id,
        edgeType: "SUPERSEDES",
        toNodeId: sibling.id,
        evidence: { reason: input.reason, actor: input.actor },
      });
    }
  }

  const promoted: AssetVersion = {
    ...asset,
    status: targetStatus,
    promotedByDeltaId: input.promotedByDeltaId ?? asset.promotedByDeltaId,
  };
  await updateAssetStatus(db, promoted, targetStatus, {
    promotedBy: input.actor,
    promotionReason: input.reason,
    canaryPercent: input.canaryPercent,
  });

  if (input.promotedByDeltaId && await nodeExists(db, input.promotedByDeltaId)) {
    await createLearningEdge(db, {
      fromNodeId: input.promotedByDeltaId,
      edgeType: "PROMOTED_TO",
      toNodeId: asset.id,
      evidence: { reason: input.reason, actor: input.actor, targetStatus },
    });
  }
}

export function routeAgentProfileCanary(input: { runId: string; taskId: string; percentage: number }): "baseline" | "candidate" {
  const percentage = Math.max(0, Math.min(100, Math.floor(input.percentage)));
  const bucket = parseInt(createHash("sha256").update(`${input.runId}:${input.taskId}`).digest("hex").slice(0, 8), 16) % 100;
  return bucket < percentage ? "candidate" : "baseline";
}

export async function rollbackAssetVersion(db: SouthstarDb, input: RollbackInput): Promise<{ activeAssetId: string; rolledBackFromAssetId: string }> {
  const bad = await loadAsset(db, input.assetId);
  const target = await findRollbackTarget(db, bad);
  await updateAssetStatus(db, bad, "rolled_back", { rolledBackBy: input.actor, rollbackReason: input.reason });
  await updateAssetStatus(db, target, "active", { restoredBy: input.actor, restoreReason: input.reason, rolledBackFromAssetId: bad.id });

  const rollbackNodeId = `rollback-${randomUUID()}`;
  await createLearningNode(db, {
    id: rollbackNodeId,
    nodeType: "rollback",
    scope: "evolution",
    status: "completed",
    payload: { assetId: bad.id, activeAssetId: target.id, actor: input.actor, reason: input.reason },
    summaryText: `Rollback ${bad.assetRef}@${bad.version} to ${target.version}`,
  });
  await createLearningEdge(db, {
    fromNodeId: rollbackNodeId,
    edgeType: "ROLLED_BACK_TO",
    toNodeId: target.id,
    evidence: { reason: input.reason, actor: input.actor, rolledBackFromAssetId: bad.id },
  });
  await createLearningEdge(db, {
    fromNodeId: bad.id,
    edgeType: "HURT",
    toNodeId: rollbackNodeId,
    evidence: { reason: input.reason, actor: input.actor },
  });
  return { activeAssetId: target.id, rolledBackFromAssetId: bad.id };
}

async function upsertAssetResource(db: SouthstarDb, asset: AssetVersion): Promise<void> {
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values ($1, 'asset_version', $1, 'evolution', $2, $3, $4::jsonb, $5::jsonb, '{}'::jsonb, now(), now())
    on conflict(resource_type, resource_key) do update set
      status = excluded.status,
      title = excluded.title,
      payload_json = excluded.payload_json,
      summary_json = excluded.summary_json,
      updated_at = now()`,
    [
      asset.id,
      asset.status,
      `${asset.assetKind} ${asset.assetRef}@${asset.version}`,
      JSON.stringify(asset),
      JSON.stringify({ assetKind: asset.assetKind, assetRef: asset.assetRef, version: asset.version, parentVersion: asset.parentVersion }),
    ],
  );
}

async function updateAssetStatus(
  db: SouthstarDb,
  asset: AssetVersion,
  status: AssetVersion["status"],
  patch: Record<string, unknown>,
): Promise<void> {
  const next = { ...asset, ...patch, status };
  await db.query(
    `update southstar.runtime_resources
     set status = $2, payload_json = $3::jsonb, updated_at = now()
     where resource_type = 'asset_version' and resource_key = $1`,
    [asset.id, status, JSON.stringify(next)],
  );
  await db.query(
    `update southstar.learning_nodes
     set status = $2, payload_jsonb = $3::jsonb, updated_at = now()
     where id = $1`,
    [asset.id, status, JSON.stringify(next)],
  );
}

async function loadAsset(db: SouthstarDb, assetId: string): Promise<AssetVersion> {
  const row = await db.maybeOne<{ payload_json: AssetVersion }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'asset_version' and resource_key = $1",
    [assetId],
  );
  if (!row) throw new Error(`asset version not found: ${assetId}`);
  return row.payload_json;
}

async function listAssets(db: SouthstarDb, assetKind: string, assetRef: string, status?: string): Promise<AssetVersion[]> {
  const rows = await db.query<{ payload_json: AssetVersion }>(
    `select payload_json from southstar.runtime_resources
     where resource_type = 'asset_version'
       and payload_json->>'assetKind' = $1
       and payload_json->>'assetRef' = $2
       and ($3::text is null or status = $3)
     order by created_at, resource_key`,
    [assetKind, assetRef, status ?? null],
  );
  return rows.rows.map((row) => row.payload_json);
}

async function findRollbackTarget(db: SouthstarDb, bad: AssetVersion): Promise<AssetVersion> {
  const siblings = await listAssets(db, bad.assetKind, bad.assetRef);
  const byVersion = siblings.find((asset) => asset.version === bad.parentVersion);
  if (byVersion) return byVersion;
  const superseded = siblings.find((asset) => asset.status === "superseded" && asset.id !== bad.id);
  if (superseded) return superseded;
  throw new Error(`rollback target not found for asset ${bad.id}`);
}

async function nodeExists(db: SouthstarDb, nodeId: string): Promise<boolean> {
  return Boolean(await db.maybeOne("select 1 from southstar.learning_nodes where id = $1", [nodeId]));
}

function nodeTypeFor(assetKind: AssetVersion["assetKind"]): "prompt_version" | "skill_version" | "agent_profile_version" | "flow_policy_version" {
  if (assetKind === "prompt_template") return "prompt_version";
  if (assetKind === "skill") return "skill_version";
  if (assetKind === "agent_profile") return "agent_profile_version";
  return "flow_policy_version";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
