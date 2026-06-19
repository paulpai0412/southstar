import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { createLearningEdge, createLearningNode } from "./learning-graph.ts";
import type { KnowledgeCard } from "./types.ts";

export type CardValidationResult = { ok: true } | { ok: false; errors: string[] };

export async function synthesizeKnowledgeCards(
  db: SouthstarDb,
  input: { actor: string; reason: string; runId?: string },
): Promise<{ cardIds: string[] }> {
  const signals = await loadLearningSignals(db, input.runId);
  const clusters = clusterSignals(signals);
  const cardIds: string[] = [];
  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue;
    const card = buildCard(cluster);
    const evidenceIds = new Set(cluster.map((signal) => signal.id));
    const validation = validateKnowledgeCard(card, evidenceIds);
    const status = validation.ok
      ? card.status
      : "rejected";
    const nodeId = `card-${hash(card.topicKey)}`;
    const payload = validation.ok ? card : { ...card, status: "rejected", validationErrors: validation.errors };
    await createLearningNode(db, {
      id: nodeId,
      nodeType: "knowledge_card",
      scope: card.scope,
      status,
      payload,
      summaryText: card.title,
    });
    for (const evidenceNodeId of evidenceIds) {
      await createLearningEdge(db, {
        fromNodeId: nodeId,
        edgeType: "SUPPORTED_BY",
        toNodeId: evidenceNodeId,
        weight: card.confidence,
        evidence: { reason: "Knowledge Card claim cites this learning signal", synthesizedBy: input.actor, synthesisReason: input.reason },
      });
    }
    cardIds.push(nodeId);
  }
  return { cardIds };
}

export async function triggerRunCompletedKnowledgeCardSynthesis(
  db: SouthstarDb,
  input: { runId: string; actor: string; reason: string },
): Promise<{ triggered: boolean; cardIds: string[]; batchId: string }> {
  const batchId = `knowledge-card-synthesis-${input.runId}`;
  const existing = await db.maybeOne<{ payload_json: { cardIds?: unknown } }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'knowledge_card_synthesis_batch' and resource_key = $1",
    [batchId],
  );
  if (existing) {
    const cardIds = Array.isArray(existing.payload_json.cardIds)
      ? existing.payload_json.cardIds.filter((id): id is string => typeof id === "string")
      : [];
    return { triggered: false, cardIds, batchId };
  }

  const completed = await db.maybeOne<{ status: string }>(
    `select r.status
     from southstar.workflow_runs r
     where r.id = $1
       and r.status in ('passed', 'completed', 'failed', 'cancelled')
       and exists (select 1 from southstar.workflow_history h where h.run_id = r.id and h.event_type = 'run.completed')`,
    [input.runId],
  );
  if (!completed) throw new Error(`run is not completed: ${input.runId}`);

  const synthesized = await synthesizeKnowledgeCards(db, { actor: input.actor, reason: input.reason, runId: input.runId });
  await upsertRuntimeResourcePg(db, {
    id: batchId,
    resourceType: "knowledge_card_synthesis_batch",
    resourceKey: batchId,
    runId: input.runId,
    scope: "evolution",
    status: "completed",
    title: `Knowledge Card synthesis ${input.runId}`,
    payload: { runId: input.runId, cardIds: synthesized.cardIds, actor: input.actor, reason: input.reason },
    summary: { cardCount: synthesized.cardIds.length },
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    eventType: "evolution.knowledge_cards_synthesized",
    actorType: "southstar-evolution",
    idempotencyKey: batchId,
    payload: { batchId, cardIds: synthesized.cardIds, reason: input.reason },
  });
  return { triggered: true, cardIds: synthesized.cardIds, batchId };
}

export function validateKnowledgeCard(value: unknown, evidenceNodeIds: Set<string>): CardValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["card must be an object"] };
  const card = value as Partial<KnowledgeCard>;
  for (const field of ["cardType", "topicKey", "scope", "title", "summary", "status", "riskTier"] as const) {
    if (typeof card[field] !== "string" || String(card[field]).length === 0) errors.push(`${field} is required`);
  }
  if (typeof card.confidence !== "number" || card.confidence < 0 || card.confidence > 1) errors.push("confidence must be between 0 and 1");
  if (typeof card.successScore !== "number" || card.successScore < 0 || card.successScore > 1) errors.push("successScore must be between 0 and 1");
  if (!isRecord(card.appliesTo)) errors.push("appliesTo is required");
  if (!Array.isArray(card.claims) || card.claims.length === 0) {
    errors.push("claims are required");
  } else {
    for (const [index, claim] of card.claims.entries()) {
      if (!isRecord(claim) || typeof claim.text !== "string" || claim.text.length === 0) errors.push(`claims.${index}.text is required`);
      const refs = isRecord(claim) && Array.isArray(claim.evidenceNodeRefs) ? claim.evidenceNodeRefs : [];
      if (refs.length === 0) errors.push(`claims.${index}.evidenceNodeRefs are required`);
      for (const ref of refs) {
        if (typeof ref !== "string" || !evidenceNodeIds.has(ref)) errors.push(`claims.${index}.evidenceNodeRefs contains unknown evidence ${String(ref)}`);
      }
    }
  }
  const text = JSON.stringify(value);
  if (text.length > 16_000) errors.push("card payload is too large");
  if (/raw transcript/i.test(text) || /"rawTranscript"\s*:/.test(text)) errors.push("raw transcripts are not allowed");
  if (/\b(?:ghp|github_pat|sk|xoxb|xoxp)_[A-Za-z0-9_\-]{20,}\b/.test(text)) errors.push("secret-like values are not allowed");
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export async function approveKnowledgeCard(
  db: SouthstarDb,
  input: { cardId: string; actor: string; reason: string; commandId: string },
): Promise<void> {
  await updateKnowledgeCardStatus(db, input.cardId, "active", {
    approvedBy: input.actor,
    approvalReason: input.reason,
    approvalCommandId: input.commandId,
  });
}

export async function rejectKnowledgeCard(
  db: SouthstarDb,
  input: { cardId: string; actor: string; reason: string; commandId: string },
): Promise<void> {
  await updateKnowledgeCardStatus(db, input.cardId, "rejected", {
    rejectedBy: input.actor,
    rejectionReason: input.reason,
    rejectionCommandId: input.commandId,
  });
}

async function updateKnowledgeCardStatus(db: SouthstarDb, cardId: string, status: KnowledgeCard["status"], patch: Record<string, unknown>): Promise<void> {
  const row = await db.maybeOne<{ payload_jsonb: Record<string, unknown> }>(
    "select payload_jsonb from southstar.learning_nodes where id = $1 and node_type = 'knowledge_card'",
    [cardId],
  );
  if (!row) throw new Error(`knowledge card not found: ${cardId}`);
  const payload = { ...row.payload_jsonb, ...patch, status };
  await db.query(
    "update southstar.learning_nodes set status = $2, payload_jsonb = $3::jsonb, updated_at = now() where id = $1",
    [cardId, status, JSON.stringify(payload)],
  );
}

type SignalRow = {
  id: string;
  payload_jsonb: Record<string, unknown>;
  created_at: Date;
};

async function loadLearningSignals(db: SouthstarDb, runId?: string): Promise<SignalRow[]> {
  const rows = await db.query<SignalRow>(
    `select id, payload_jsonb, created_at
     from southstar.learning_nodes
     where node_type = 'learning_signal'
       and ($1::text is null or run_id = $1)
     order by created_at, id`,
    [runId ?? null],
  );
  return rows.rows;
}

function clusterSignals(signals: SignalRow[]): Map<string, SignalRow[]> {
  const clusters = new Map<string, SignalRow[]>();
  for (const signal of signals) {
    const key = clusterKey(signal.payload_jsonb);
    const current = clusters.get(key) ?? [];
    current.push(signal);
    clusters.set(key, current);
  }
  return clusters;
}

function clusterKey(payload: Record<string, unknown>): string {
  const required = [
    stringValue(payload.scope, "software"),
    stringValue(payload.intent, "unknown_intent"),
    stringValue(payload.roleRef, "unknown_role"),
    stringValue(payload.artifactType, "unknown_artifact"),
    stringValue(payload.failureKind, "unknown_failure"),
    stringArray(payload.missingFields).sort().join("-"),
    stringValue(payload.agentProfileRef, "unknown_profile"),
  ];
  const optional = [
    stringValue(payload.skillRef, ""),
    stringValue(payload.promptTemplateRef, ""),
    stringValue(payload.flowTemplateRef, ""),
  ].filter((item) => item.length > 0);
  return [...required, ...optional].join(":");
}

function buildCard(cluster: SignalRow[]): KnowledgeCard {
  const first = cluster[0]!.payload_jsonb;
  const evidenceNodeRefs = cluster.map((signal) => signal.id);
  const scope = stringValue(first.scope, "software");
  const artifactType = stringValue(first.artifactType, "artifact");
  const failureKind = stringValue(first.failureKind, "failure");
  const missingFields = stringArray(first.missingFields).sort();
  const riskTier = riskTierFor(first);
  const status = riskTier === "high" ? "pending_approval" : "active";
  return {
    cardType: "failure_lesson",
    topicKey: clusterKey(first),
    scope,
    title: `${artifactType} ${failureKind} repair lesson`,
    summary: `Repeated ${failureKind} repair signals for ${artifactType} indicate prompts or skills should include a bounded final self-check.`,
    appliesTo: {
      intents: [stringValue(first.intent, "unknown_intent")],
      roles: [stringValue(first.roleRef, "unknown_role")],
      artifactTypes: [artifactType],
      agentProfiles: [stringValue(first.agentProfileRef, "unknown_profile")],
      promptTemplates: stringValue(first.promptTemplateRef, "") ? [stringValue(first.promptTemplateRef, "")] : [],
      skills: stringValue(first.skillRef, "") ? [stringValue(first.skillRef, "")] : [],
      flowTemplates: stringValue(first.flowTemplateRef, "") ? [stringValue(first.flowTemplateRef, "")] : [],
    },
    claims: [{
      text: missingFields.length > 0
        ? `Adding a final artifact checklist should reduce missing fields: ${missingFields.join(", ")}.`
        : "Adding a final self-check should reduce repeated repair loops.",
      evidenceNodeRefs,
    }],
    confidence: Math.min(0.95, 0.55 + cluster.length * 0.15),
    successScore: 0.75,
    status,
    riskTier,
  };
}

function riskTierFor(payload: Record<string, unknown>): KnowledgeCard["riskTier"] {
  const text = JSON.stringify(payload).toLowerCase();
  if (/tool|mcp|security|secret|release|deploy|github\.pr-write|model switch|provider switch|flow change|retry strategy/.test(text)) return "high";
  if (/budget|cost|duration|token limit|wall time/.test(text)) return "medium";
  return "low";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
