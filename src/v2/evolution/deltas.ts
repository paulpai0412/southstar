import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { createLearningEdge, createLearningNode } from "./learning-graph.ts";
import type { DeltaProposal, KnowledgeCard } from "./types.ts";

export type DeltaValidationResult = { ok: true } | { ok: false; errors: string[] };

export async function synthesizeDeltaProposals(
  db: SouthstarDb,
  input: { actor: string; reason: string; sourceCardRefs: string[]; targetRef?: string; targetVersion?: string },
): Promise<{ deltaIds: string[] }> {
  const deltaIds: string[] = [];
  for (const cardRef of input.sourceCardRefs) {
    const card = await loadActiveCard(db, cardRef);
    if (!card) throw new Error(`source card not found or inactive: ${cardRef}`);
    const proposal = buildDeltaProposal(cardRef, card, input);
    const validation = await validateDeltaProposal(db, proposal);
    if (!validation.ok) throw new Error(`delta proposal validation failed: ${validation.errors.join("; ")}`);
    await persistDeltaProposal(db, proposal, { actor: input.actor, reason: input.reason });
    deltaIds.push(proposal.id);
  }
  return { deltaIds };
}

export async function validateDeltaProposal(db: SouthstarDb, proposal: DeltaProposal): Promise<DeltaValidationResult> {
  const errors: string[] = [];
  if (!proposal.id) errors.push("id is required");
  if (!proposal.deltaKind) errors.push("deltaKind is required");
  if (!proposal.hypothesis) errors.push("hypothesis is required");
  const sourceCards: Array<{ id: string; payload: KnowledgeCard }> = [];
  for (const sourceCardRef of proposal.sourceCardRefs) {
    const card = await db.maybeOne<{ payload_jsonb: KnowledgeCard }>("select payload_jsonb from southstar.learning_nodes where id = $1 and node_type = 'knowledge_card'", [sourceCardRef]);
    if (!card) errors.push(`source card not found: ${sourceCardRef}`);
    else sourceCards.push({ id: sourceCardRef, payload: card.payload_jsonb });
  }
  for (const sourceNodeRef of proposal.sourceNodeRefs) {
    const node = await db.maybeOne("select 1 from southstar.learning_nodes where id = $1", [sourceNodeRef]);
    if (!node) errors.push(`source node not found: ${sourceNodeRef}`);
  }
  if (!proposal.targetRef) errors.push("targetRef is required");
  if (!proposal.targetVersion) errors.push("targetVersion is required");
  if (proposal.targetRef && proposal.targetVersion) {
    const targetExists = await db.maybeOne(
      `select 1 from southstar.runtime_resources
       where resource_type = 'asset_version'
         and payload_json->>'assetKind' = $1
         and payload_json->>'assetRef' = $2
         and payload_json->>'version' = $3`,
      [assetKindForDelta(proposal.deltaKind), proposal.targetRef, proposal.targetVersion],
    );
    if (!targetExists) errors.push(`target asset version not found: ${proposal.targetRef}@${proposal.targetVersion}`);
  }
  const patchErrors = validatePatchAllowlist(proposal);
  errors.push(...patchErrors);
  const invariantErrors = validateRuntimeInvariantProtection(proposal);
  errors.push(...invariantErrors);
  if (sourceCards.length === 1) {
    const expectedHash = hash(JSON.stringify({ cardRef: sourceCards[0]!.id, claims: sourceCards[0]!.payload.claims }));
    if (proposal.evidenceSubgraphHash !== expectedHash) {
      errors.push(`evidenceSubgraphHash does not match source evidence subgraph: expected ${expectedHash}`);
    }
  }
  const text = JSON.stringify(proposal);
  if (text.length > 32_000) errors.push("delta proposal payload is too large");
  if (/raw transcript/i.test(text) || /"rawTranscript"\s*:/.test(text)) errors.push("raw transcripts are not allowed in delta proposals");
  if (/\b(?:ghp|github_pat|sk|xoxb|xoxp)_[A-Za-z0-9_\-]{20,}\b/.test(text)) errors.push("secret-like values are not allowed in delta proposals");
  if (proposal.deltaKind === "flow_delta" && proposal.status === "promoted") errors.push("flow delta cannot be auto-promoted");
  if (proposal.deltaKind === "agent_profile_delta" && proposal.riskTier === "high" && proposal.status === "promoted") {
    errors.push("high-risk agent profile delta cannot be auto-promoted");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

async function persistDeltaProposal(
  db: SouthstarDb,
  proposal: DeltaProposal,
  audit: { actor: string; reason: string },
): Promise<void> {
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values ($1, 'delta_proposal', $1, 'evolution', $2, $3, $4::jsonb, $5::jsonb, '{}'::jsonb, now(), now())
    on conflict(resource_type, resource_key) do update set
      status = excluded.status,
      title = excluded.title,
      payload_json = excluded.payload_json,
      summary_json = excluded.summary_json,
      updated_at = now()`,
    [
      proposal.id,
      proposal.status,
      proposal.hypothesis,
      JSON.stringify(proposal),
      JSON.stringify({ deltaKind: proposal.deltaKind, riskTier: proposal.riskTier, actor: audit.actor, reason: audit.reason }),
    ],
  );
  await createLearningNode(db, {
    id: proposal.id,
    nodeType: "delta_proposal",
    scope: "evolution",
    status: proposal.status,
    resourceRef: proposal.id,
    payload: proposal,
    summaryText: proposal.hypothesis,
  });
  for (const cardRef of proposal.sourceCardRefs) {
    await createLearningEdge(db, {
      fromNodeId: proposal.id,
      edgeType: "BASED_ON",
      toNodeId: cardRef,
      weight: proposal.riskTier === "low" ? 0.8 : 0.6,
      evidence: { reason: "Delta proposal is based on this Knowledge Card", actor: audit.actor, auditReason: audit.reason },
    });
  }
}

async function loadActiveCard(db: SouthstarDb, cardRef: string): Promise<KnowledgeCard | null> {
  const row = await db.maybeOne<{ payload_jsonb: KnowledgeCard }>(
    "select payload_jsonb from southstar.learning_nodes where id = $1 and node_type = 'knowledge_card' and status = 'active'",
    [cardRef],
  );
  return row?.payload_jsonb ?? null;
}

function buildDeltaProposal(
  cardRef: string,
  card: KnowledgeCard,
  input: { targetRef?: string; targetVersion?: string },
): DeltaProposal {
  const deltaKind = deltaKindFor(card);
  const targetRef = input.targetRef ?? defaultTargetRef(deltaKind, card);
  const targetVersion = input.targetVersion ?? "active";
  const id = `delta-${hash([cardRef, deltaKind, targetRef, targetVersion].join(":"))}`;
  return {
    id,
    deltaKind,
    targetRef,
    targetVersion,
    sourceCardRefs: [cardRef],
    sourceNodeRefs: [cardRef, ...card.claims.flatMap((claim) => claim.evidenceNodeRefs)],
    evidenceSubgraphHash: hash(JSON.stringify({ cardRef, claims: card.claims })),
    hypothesis: hypothesisFor(deltaKind, card),
    patch: patchFor(deltaKind, card),
    riskTier: card.riskTier,
    validationPlan: {
      regressionSuiteRefs: ["software-core-regression"],
      replayRunRefs: [],
      maxCostRegressionPercent: 10,
      maxDurationRegressionPercent: 15,
      minReplayFixRate: deltaKind === "flow_delta" ? undefined : 0.8,
    },
    rollbackPlan: { previousVersionRef: targetVersion, strategy: deltaKind === "flow_delta" ? "manual" : "revert-version" },
    status: "proposed",
  };
}

function deltaKindFor(card: KnowledgeCard): DeltaProposal["deltaKind"] {
  if (card.cardType === "success_pattern") return "skill_delta";
  if (card.cardType === "profile_lesson") return "agent_profile_delta";
  if (card.cardType === "flow_lesson") return "flow_delta";
  if (card.cardType === "domain_pattern") return card.appliesTo.flowTemplates?.length ? "flow_delta" : "skill_delta";
  return "prompt_delta";
}

function defaultTargetRef(deltaKind: DeltaProposal["deltaKind"], card: KnowledgeCard): string {
  if (deltaKind === "skill_delta") return card.appliesTo.skills?.[0] ?? "software.default-skill";
  if (deltaKind === "agent_profile_delta") return card.appliesTo.agentProfiles?.[0] ?? "software.default-profile";
  if (deltaKind === "flow_delta") return card.appliesTo.flowTemplates?.[0] ?? "software.default-flow";
  return card.appliesTo.promptTemplates?.[0] ?? "prompt-software-maker";
}

function hypothesisFor(deltaKind: DeltaProposal["deltaKind"], card: KnowledgeCard): string {
  if (deltaKind === "prompt_delta") return `Add bounded prompt guidance from Knowledge Card ${card.topicKey}.`;
  if (deltaKind === "skill_delta") return `Update skill checklist from Knowledge Card ${card.topicKey}.`;
  if (deltaKind === "agent_profile_delta") return `Adjust agent profile from Knowledge Card ${card.topicKey}.`;
  if (deltaKind === "flow_delta") return `Propose flow policy change from Knowledge Card ${card.topicKey}.`;
  return `Apply Knowledge Card delta for ${card.topicKey}.`;
}

function patchFor(deltaKind: DeltaProposal["deltaKind"], card: KnowledgeCard): unknown {
  const instruction = card.claims[0]?.text ?? card.summary;
  if (deltaKind === "prompt_delta") return { appendSection: "Final artifact self-check", instruction };
  if (deltaKind === "skill_delta") return { checklistItem: instruction };
  if (deltaKind === "agent_profile_delta") return { preferenceHint: instruction };
  if (deltaKind === "flow_delta") return { proposalOnly: true, policyHint: instruction };
  return { cardStatus: card.status };
}

function assetKindForDelta(deltaKind: DeltaProposal["deltaKind"]): "prompt_template" | "skill" | "agent_profile" | "flow_policy" {
  if (deltaKind === "skill_delta") return "skill";
  if (deltaKind === "agent_profile_delta") return "agent_profile";
  if (deltaKind === "flow_delta") return "flow_policy";
  return "prompt_template";
}

function validatePatchAllowlist(proposal: DeltaProposal): string[] {
  const patch = asRecord(proposal.patch);
  const allowed = allowedPatchKeys(proposal.deltaKind);
  const errors: string[] = [];
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) errors.push(`patch key is not allowed for ${proposal.deltaKind}: ${key}`);
  }
  return errors;
}

function allowedPatchKeys(deltaKind: DeltaProposal["deltaKind"]): Set<string> {
  if (deltaKind === "prompt_delta") return new Set(["appendSection", "instruction"]);
  if (deltaKind === "skill_delta") return new Set(["checklistItem"]);
  if (deltaKind === "agent_profile_delta") return new Set(["preferenceHint"]);
  if (deltaKind === "flow_delta") return new Set(["proposalOnly", "policyHint"]);
  return new Set(["cardStatus"]);
}

function validateRuntimeInvariantProtection(proposal: DeltaProposal): string[] {
  const text = JSON.stringify(proposal.patch);
  if (/lifecycle\s*state|lifecycle_state|lifecycleStates|owner_lease|runtime_context_json|workflow_runs|issue_history|learning_nodes\s+table/i.test(text)) {
    return ["delta patch attempts to modify a runtime invariant"];
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
