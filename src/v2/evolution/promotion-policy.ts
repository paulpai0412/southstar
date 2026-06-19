import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { promoteAssetVersion } from "./assets.ts";
import type { AssetVersion, DeltaProposal } from "./types.ts";

export type DeltaPromotionPolicyDecision = {
  status: "promoted" | "pending_approval" | "rejected";
  decisionMode: "auto" | "manual";
  targetStatus: "active" | "canary";
  approvalId?: string;
  reason: string;
};

export async function evaluateDeltaPromotionPolicyPg(db: SouthstarDb, input: {
  deltaId: string;
  candidateAssetId: string;
  actor: string;
  reason: string;
}): Promise<DeltaPromotionPolicyDecision> {
  const delta = await loadDelta(db, input.deltaId);
  const asset = await loadAsset(db, input.candidateAssetId);
  if (asset.promotedByDeltaId && asset.promotedByDeltaId !== delta.id) {
    throw new Error(`candidate asset ${asset.id} belongs to delta ${asset.promotedByDeltaId}, not ${delta.id}`);
  }
  const policy = matrixDecision(delta);
  if (policy.decisionMode === "auto") {
    await promoteAssetVersion(db, {
      assetId: asset.id,
      promotedByDeltaId: delta.id,
      actor: input.actor,
      reason: input.reason,
      targetStatus: policy.targetStatus,
      canaryPercent: policy.targetStatus === "canary" ? canaryPercentFor(delta) : undefined,
    });
    await updateDeltaStatus(db, delta, "promoted", { promotedAssetId: asset.id, promotedBy: input.actor, promotionReason: input.reason });
    return { status: "promoted", decisionMode: "auto", targetStatus: policy.targetStatus, reason: policy.reason };
  }

  const approvalId = `approval-${randomUUID()}`;
  await upsertRuntimeResourcePg(db, {
    id: approvalId,
    resourceType: "approval",
    resourceKey: approvalId,
    scope: "approval",
    status: "pending",
    title: `Review delta promotion ${delta.id}`,
    payload: {
      actionType: "deltaPromotion",
      deltaId: delta.id,
      candidateAssetId: asset.id,
      deltaKind: delta.deltaKind,
      riskTier: delta.riskTier,
      targetStatus: policy.targetStatus,
      riskTags: riskTagsFor(delta),
      requestedBy: input.actor,
      requestReason: input.reason,
    },
    summary: { deltaId: delta.id, targetStatus: policy.targetStatus, reason: policy.reason },
  });
  await updateDeltaStatus(db, delta, "validating", { pendingApprovalId: approvalId, approvalReason: policy.reason });
  return { status: "pending_approval", decisionMode: "manual", targetStatus: policy.targetStatus, approvalId, reason: policy.reason };
}

function matrixDecision(delta: DeltaProposal): { decisionMode: "auto" | "manual"; targetStatus: "active" | "canary"; reason: string } {
  if (delta.deltaKind === "flow_delta") return { decisionMode: "manual", targetStatus: "active", reason: "flow policy changes require operator approval" };
  if (delta.deltaKind === "agent_profile_delta") {
    if (delta.riskTier === "low") return { decisionMode: "auto", targetStatus: "canary", reason: "low-risk profile deltas start as canary" };
    return { decisionMode: "manual", targetStatus: "canary", reason: `${delta.riskTier}-risk profile deltas require canary approval` };
  }
  if (delta.deltaKind === "skill_delta") {
    if (delta.riskTier === "high") return { decisionMode: "manual", targetStatus: "active", reason: "high-risk skill deltas require approval" };
    return { decisionMode: "auto", targetStatus: "active", reason: "prompt/skill low-to-medium risk delta may auto-promote after validation" };
  }
  if (delta.riskTier === "high") return { decisionMode: "manual", targetStatus: "active", reason: "high-risk prompt deltas require approval" };
  return { decisionMode: "auto", targetStatus: "active", reason: "prompt/skill low-to-medium risk delta may auto-promote after validation" };
}

async function loadDelta(db: SouthstarDb, deltaId: string): Promise<DeltaProposal> {
  const row = await db.maybeOne<{ payload_json: DeltaProposal }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'delta_proposal' and resource_key = $1",
    [deltaId],
  );
  if (!row) throw new Error(`delta proposal not found: ${deltaId}`);
  return row.payload_json;
}

async function loadAsset(db: SouthstarDb, assetId: string): Promise<AssetVersion> {
  const row = await db.maybeOne<{ payload_json: AssetVersion }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'asset_version' and resource_key = $1",
    [assetId],
  );
  if (!row) throw new Error(`asset version not found: ${assetId}`);
  return row.payload_json;
}

async function updateDeltaStatus(db: SouthstarDb, delta: DeltaProposal, status: DeltaProposal["status"], patch: Record<string, unknown>): Promise<void> {
  const next = { ...delta, ...patch, status };
  await db.query(
    "update southstar.runtime_resources set status = $2, payload_json = $3::jsonb, updated_at = now() where resource_type = 'delta_proposal' and resource_key = $1",
    [delta.id, status, JSON.stringify(next)],
  );
  await db.query(
    "update southstar.learning_nodes set status = $2, payload_jsonb = $3::jsonb, updated_at = now() where id = $1",
    [delta.id, status, JSON.stringify(next)],
  );
}

function canaryPercentFor(delta: DeltaProposal): number {
  if (delta.riskTier === "low") return 10;
  if (delta.riskTier === "medium") return 25;
  return 5;
}

function riskTagsFor(delta: DeltaProposal): string[] {
  const tags = [`delta-kind:${delta.deltaKind}`, `risk:${delta.riskTier}`];
  if (delta.deltaKind === "flow_delta" || delta.deltaKind === "agent_profile_delta") tags.push("production-change");
  if (delta.riskTier === "high") tags.push("cost-high");
  return tags;
}
