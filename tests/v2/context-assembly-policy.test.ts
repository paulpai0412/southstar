import test from "node:test";
import assert from "node:assert/strict";
import { assembleContextBlocks } from "../../src/v2/context/assembly-policy.ts";
import type { ContextBlockCandidate } from "../../src/v2/context/types.ts";

test("assembly policy selects required artifact, allowed memory, and knowledge within token budgets", () => {
  const candidates: ContextBlockCandidate[] = [
    candidate("artifact", "artifact-a", "Accepted upstream artifact summary", 8, 0.9),
    candidate("memory", "memory-run", "Repair hint from this run", 8, 0.8),
    candidate("memory", "memory-pending", "Pending long-term memory", 8, 0.95),
    candidate("memory", "memory-secret", "Token sk-1234567890abcdefghijklmnopqrstuvwxyz leaked", 8, 0.99),
    candidate("memory", "memory-invalidated", "Rollback invalidated memory", 8, 0.7),
    candidate("memory", "memory-over-budget", "Relevant but exceeds memory budget", 8, 0.6),
    candidate("knowledge_card", "card-a", "Approved failure lesson", 8, 0.6),
    candidate("knowledge_card", "card-over-budget", "Relevant but exceeds input budget", 8, 0.5),
  ];

  const result = assembleContextBlocks({
    candidates,
    maxInputTokens: 30,
    maxMemoryTokens: 12,
    pendingMemoryRefs: ["memory-pending"],
    invalidatedSourceRefs: ["memory-invalidated"],
    requiredSourceRefs: ["artifact-a"],
  });

  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.selected.map((block) => block.sourceRef), ["artifact-a", "memory-run", "card-a"]);
  assert.deepEqual(result.tokenEstimate, { total: 24, bySourceType: { artifact: 8, memory: 8, knowledge_card: 8 } });
  assertExclusion(result.excludedCandidates, "memory-pending", "scope-mismatch");
  assertExclusion(result.excludedCandidates, "memory-invalidated", "scope-mismatch");
  assertExclusion(result.excludedCandidates, "memory-secret", "kind-mismatch");
  assertExclusion(result.excludedCandidates, "memory-over-budget", "over-budget");
  assertExclusion(result.excludedCandidates, "card-over-budget", "over-budget");
});

test("assembly policy fails validation when required source refs are missing", () => {
  const result = assembleContextBlocks({
    candidates: [candidate("memory", "memory-run", "Repair hint", 8, 0.8)],
    maxInputTokens: 30,
    maxMemoryTokens: 12,
    pendingMemoryRefs: [],
    invalidatedSourceRefs: [],
    requiredSourceRefs: ["artifact-a"],
  });

  assert.equal(result.validation.ok, false);
  assert.match(result.validation.errors[0]?.message ?? "", /required source ref missing: artifact-a/);
});

function candidate(
  sourceType: ContextBlockCandidate["sourceType"],
  sourceRef: string,
  text: string,
  tokenEstimate: number,
  score: number,
): ContextBlockCandidate {
  return {
    id: `${sourceType}-${sourceRef}`,
    sourceType,
    title: sourceRef,
    text,
    sourceRef,
    tokenEstimate,
    score,
  };
}

function assertExclusion(
  excludedCandidates: Array<{ sourceRef: string; reason: string }>,
  sourceRef: string,
  reason: string,
): void {
  assert.equal(
    excludedCandidates.some((item) => item.sourceRef === sourceRef && item.reason === reason),
    true,
    `expected ${sourceRef} to be excluded as ${reason}`,
  );
}
