import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type { ContextBlock } from "../context/types.ts";
import { createLearningEdge, createLearningNode } from "./learning-graph.ts";

export type TaskCardSelectionInput = {
  scope: string;
  intent: string;
  roleRef: string;
  artifactTypes: string[];
  agentProfileRef: string;
  promptTemplateRef: string;
  skillRefs: string[];
  flowTemplateRef: string;
  maxCards?: number;
};

export type CardExclusionReason =
  | "metadata-mismatch"
  | "status-candidate"
  | "status-pending_approval"
  | "status-stale"
  | "status-superseded"
  | "status-rejected"
  | "status-do_not_inject";

export type CardSelectionResult = {
  matchedTaskMetadata: TaskCardSelectionInput;
  selectedCards: ContextBlock[];
  selectedCardRefs: string[];
  excludedCards: Array<{ cardRef: string; reason: CardExclusionReason; score: number }>;
  tokenEstimate: number;
};

export type PersistCardTraceInput = {
  contextPacketId: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  scope: string;
  matchedTaskMetadata: TaskCardSelectionInput;
  selectedCards: ContextBlock[];
  selectedCardRefs: string[];
  excludedCards: Array<{ cardRef: string; reason: CardExclusionReason; score: number }>;
  tokenEstimate: number;
};

export async function selectKnowledgeCardsForTask(db: SouthstarDb, input: TaskCardSelectionInput): Promise<CardSelectionResult> {
  const rows = await db.query<CardRow>(
    `select id, status, payload_jsonb, summary_text, created_at
     from southstar.learning_nodes
     where node_type = 'knowledge_card' and scope = $1
     order by created_at, id`,
    [input.scope],
  );

  const candidates: Array<{ row: CardRow; score: number; block: ContextBlock }> = [];
  const excludedCards: CardSelectionResult["excludedCards"] = [];
  for (const row of rows.rows) {
    const payload = asRecord(row.payload_jsonb);
    const status = stringValue(payload.status, row.status);
    const score = cardScore(payload, row.created_at);
    if (status !== "active") {
      excludedCards.push({ cardRef: row.id, reason: statusReason(status), score });
      continue;
    }
    if (!matchesTaskMetadata(payload, input)) {
      excludedCards.push({ cardRef: row.id, reason: "metadata-mismatch", score });
      continue;
    }
    const summary = stringValue(payload.summary, row.summary_text);
    candidates.push({
      row,
      score,
      block: {
        id: `knowledge-card-${stringValue(payload.topicKey, row.id)}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
        sourceType: "knowledge_card",
        title: stringValue(payload.title, stringValue(payload.topicKey, row.id)),
        text: summary,
        sourceRef: row.id,
        tokenEstimate: estimateTokens(summary),
      },
    });
  }

  candidates.sort((a, b) => b.score - a.score || topicKey(a.row).localeCompare(topicKey(b.row)) || a.row.id.localeCompare(b.row.id));
  const selected = candidates.slice(0, input.maxCards ?? 5);
  return {
    matchedTaskMetadata: input,
    selectedCards: selected.map((item) => item.block),
    selectedCardRefs: selected.map((item) => item.row.id),
    excludedCards,
    tokenEstimate: selected.reduce((sum, item) => sum + item.block.tokenEstimate, 0),
  };
}

export async function persistKnowledgeCardInjectionTrace(db: SouthstarDb, input: PersistCardTraceInput): Promise<{ traceId: string }> {
  const traceId = `card-trace-${input.contextPacketId}`;
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, run_id, task_id, session_id, scope, status,
      title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values ($1, $2, $3, $4, $5, $6, $7, 'created', $8, $9::jsonb, $10::jsonb, '{}'::jsonb, now(), now())
    on conflict(resource_type, resource_key) do update set
      run_id = excluded.run_id,
      task_id = excluded.task_id,
      session_id = excluded.session_id,
      scope = excluded.scope,
      status = excluded.status,
      title = excluded.title,
      payload_json = excluded.payload_json,
      summary_json = excluded.summary_json,
      updated_at = now()`,
    [
      traceId,
      "knowledge_card_injection_trace",
      traceId,
      input.runId ?? null,
      input.taskId ?? null,
      input.sessionId ?? null,
      input.scope,
      `Knowledge Card injection for ${input.taskId ?? input.contextPacketId}`,
      JSON.stringify({
        contextPacketId: input.contextPacketId,
        matchedTaskMetadata: input.matchedTaskMetadata,
        selectedCardRefs: input.selectedCardRefs,
        selectedCards: input.selectedCards,
        excludedCards: input.excludedCards,
        tokenEstimate: input.tokenEstimate,
      }),
      JSON.stringify({ selectedCards: input.selectedCardRefs.length, tokenEstimate: input.tokenEstimate }),
    ],
  );

  await createLearningNode(db, {
    id: input.contextPacketId,
    nodeType: "context_packet",
    scope: input.scope,
    status: "created",
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    resourceRef: traceId,
    payload: { traceId, matchedTaskMetadata: input.matchedTaskMetadata },
    summaryText: `Context packet ${input.contextPacketId}`,
  });

  for (const cardRef of input.selectedCardRefs) {
    await createLearningEdge(db, {
      id: `inject-${randomUUID()}`,
      fromNodeId: input.contextPacketId,
      edgeType: "INJECTED_CARD",
      toNodeId: cardRef,
      weight: 1,
      evidence: {
        wikiRelation: "used_by",
        status: "active",
        confidence: 1,
        reason: "ContextBuilder injected this Knowledge Card for matching task metadata.",
        evidenceNodeRefs: [input.contextPacketId, cardRef],
        traceId,
      },
    });
  }

  return { traceId };
}

type CardRow = {
  id: string;
  status: string;
  payload_jsonb: unknown;
  summary_text: string;
  created_at: Date;
};

function matchesTaskMetadata(payload: Record<string, unknown>, input: TaskCardSelectionInput): boolean {
  const appliesTo = asRecord(payload.appliesTo);
  return matchesOptional(appliesTo.intents, [input.intent])
    && matchesOptional(appliesTo.roles, [input.roleRef])
    && matchesOptional(appliesTo.artifactTypes, input.artifactTypes)
    && matchesOptional(appliesTo.agentProfiles, [input.agentProfileRef])
    && matchesOptional(appliesTo.promptTemplates, [input.promptTemplateRef])
    && matchesOptional(appliesTo.skills, input.skillRefs)
    && matchesOptional(appliesTo.flowTemplates, [input.flowTemplateRef]);
}

function matchesOptional(value: unknown, actual: string[]): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  const expected = value.filter((item): item is string => typeof item === "string");
  if (expected.length === 0) return true;
  return expected.some((item) => actual.includes(item));
}

function cardScore(payload: Record<string, unknown>, createdAt: Date): number {
  const confidence = numberValue(payload.confidence, 0.5);
  const successScore = numberValue(payload.successScore, 0.5);
  const recency = Math.max(0, createdAt.getTime() / 8.64e15);
  return confidence * 2 + successScore * 2 + recency;
}

function statusReason(status: string): CardExclusionReason {
  if (["candidate", "pending_approval", "stale", "superseded", "rejected", "do_not_inject"].includes(status)) {
    return `status-${status}` as CardExclusionReason;
  }
  return "metadata-mismatch";
}

function topicKey(row: CardRow): string {
  return stringValue(asRecord(row.payload_jsonb).topicKey, row.id);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
