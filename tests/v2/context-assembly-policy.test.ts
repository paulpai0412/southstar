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

test("assembly policy treats duplicate required source refs as one required candidate", () => {
  const result = assembleContextBlocks({
    candidates: [candidate("artifact", "artifact-a", "Artifact summary.", 10, 0.8)],
    maxInputTokens: 10,
    maxMemoryTokens: 0,
    pendingMemoryRefs: [],
    invalidatedSourceRefs: [],
    requiredSourceRefs: ["artifact-a", "artifact-a"],
  });

  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.selected.map((block) => block.sourceRef), ["artifact-a"]);
});

test("assembly policy reserves budget for required refs before optional candidates", () => {
  const result = assembleContextBlocks({
    candidates: [
      candidate("artifact", "optional-artifact", "Optional artifact consumes the full budget.", 20, 0.99),
      candidate("memory", "required-memory", "Required memory should win budget.", 10, 0.2),
      candidate("knowledge_card", "optional-card", "Optional card can fit after required memory.", 10, 0.9),
    ],
    maxInputTokens: 20,
    maxMemoryTokens: 20,
    pendingMemoryRefs: [],
    invalidatedSourceRefs: [],
    requiredSourceRefs: ["required-memory"],
  });

  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.selected.map((block) => block.sourceRef), ["required-memory", "optional-card"]);
  assertExclusion(result.excludedCandidates, "optional-artifact", "over-budget");
});

test("assembly policy selects only the highest-scored duplicate source ref", () => {
  const result = assembleContextBlocks({
    candidates: [
      candidate("memory", "memory-same", "Lower score duplicate.", 4, 0.2),
      candidate("memory", "memory-same", "Higher score duplicate.", 4, 0.9, "memory-same-best"),
      candidate("artifact", "artifact-a", "Artifact summary.", 4, 0.5),
    ],
    maxInputTokens: 20,
    maxMemoryTokens: 10,
    pendingMemoryRefs: [],
    invalidatedSourceRefs: [],
    requiredSourceRefs: ["artifact-a"],
  });

  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.selected.map((block) => [block.sourceRef, block.text]), [
    ["artifact-a", "Artifact summary."],
    ["memory-same", "Higher score duplicate."],
  ]);
  assertExclusion(result.excludedCandidates, "memory-same", "duplicate");
});

test("assembly policy blocks common secret-shaped content before final context assembly", () => {
  const secretCases = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "password = hunter2-secret-value",
    "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  ];

  for (const [index, text] of secretCases.entries()) {
    const sourceRef = `secret-${index}`;
    const result = assembleContextBlocks({
      candidates: [candidate("memory", sourceRef, text, 4, 0.9)],
      maxInputTokens: 20,
      maxMemoryTokens: 20,
      pendingMemoryRefs: [],
      invalidatedSourceRefs: [],
      requiredSourceRefs: [],
    });

    assert.deepEqual(result.selected, []);
    assertExclusion(result.excludedCandidates, sourceRef, "kind-mismatch");
  }
});

function candidate(
  sourceType: ContextBlockCandidate["sourceType"],
  sourceRef: string,
  text: string,
  tokenEstimate: number,
  score: number,
  id?: string,
): ContextBlockCandidate {
  return {
    id: id ?? `${sourceType}-${sourceRef}`,
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
