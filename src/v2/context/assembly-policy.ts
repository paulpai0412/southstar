import type {
  ContextAssemblyValidation,
  ContextBlock,
  ContextBlockCandidate,
  ContextExclusion,
  TokenEstimate,
} from "./types.ts";

export type ContextAssemblyPolicyInput = {
  candidates: ContextBlockCandidate[];
  maxInputTokens: number;
  maxMemoryTokens: number;
  pendingMemoryRefs: string[];
  invalidatedSourceRefs: string[];
  requiredSourceRefs: string[];
};

export type ContextAssemblyPolicyResult = {
  selected: ContextBlock[];
  excludedCandidates: ContextExclusion[];
  tokenEstimate: TokenEstimate;
  validation: ContextAssemblyValidation;
};

const SECRET_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/i;

export function assembleContextBlocks(input: ContextAssemblyPolicyInput): ContextAssemblyPolicyResult {
  const pendingMemoryRefs = new Set(input.pendingMemoryRefs);
  const invalidatedSourceRefs = new Set(input.invalidatedSourceRefs);
  const excludedCandidates: ContextExclusion[] = [];
  const selected: ContextBlock[] = [];
  let totalTokens = 0;
  let memoryTokens = 0;

  for (const candidate of [...input.candidates].sort(compareCandidate)) {
    const sourceRef = candidate.sourceRef ?? candidate.id;
    if (pendingMemoryRefs.has(sourceRef)) {
      excludedCandidates.push(exclusion(candidate, "scope-mismatch"));
      continue;
    }
    if (invalidatedSourceRefs.has(sourceRef)) {
      excludedCandidates.push(exclusion(candidate, "scope-mismatch"));
      continue;
    }
    if (SECRET_PATTERN.test(candidate.text)) {
      excludedCandidates.push(exclusion(candidate, "kind-mismatch"));
      continue;
    }
    if (candidate.sourceType === "memory" && memoryTokens + candidate.tokenEstimate > input.maxMemoryTokens) {
      excludedCandidates.push(exclusion(candidate, "over-budget"));
      continue;
    }
    if (totalTokens + candidate.tokenEstimate > input.maxInputTokens) {
      excludedCandidates.push(exclusion(candidate, "over-budget"));
      continue;
    }

    selected.push(toBlock(candidate));
    totalTokens += candidate.tokenEstimate;
    if (candidate.sourceType === "memory") memoryTokens += candidate.tokenEstimate;
  }

  const selectedRefs = new Set(selected.map((block) => block.sourceRef ?? block.id));
  const errors = input.requiredSourceRefs
    .filter((sourceRef) => !selectedRefs.has(sourceRef))
    .map((sourceRef) => ({ code: "required-source-missing", message: `required source ref missing: ${sourceRef}`, sourceRef }));

  return {
    selected,
    excludedCandidates,
    tokenEstimate: estimateTokens(selected, totalTokens),
    validation: { ok: errors.length === 0, errors },
  };
}

function compareCandidate(left: ContextBlockCandidate, right: ContextBlockCandidate): number {
  const priority = sourcePriority(left.sourceType) - sourcePriority(right.sourceType);
  if (priority !== 0) return priority;
  const score = right.score - left.score;
  if (score !== 0) return score;
  return (left.sourceRef ?? left.id).localeCompare(right.sourceRef ?? right.id);
}

function sourcePriority(sourceType: ContextBlockCandidate["sourceType"]): number {
  if (sourceType === "artifact") return 0;
  if (sourceType === "failure") return 1;
  if (sourceType === "checkpoint") return 2;
  if (sourceType === "memory") return 3;
  if (sourceType === "knowledge_card") return 4;
  return 5;
}

function exclusion(candidate: ContextBlockCandidate, reason: ContextExclusion["reason"]): ContextExclusion {
  return { sourceRef: candidate.sourceRef ?? candidate.id, reason, tokenEstimate: candidate.tokenEstimate };
}

function estimateTokens(selected: ContextBlock[], total: number): TokenEstimate {
  const bySourceType: Record<string, number> = {};
  for (const block of selected) bySourceType[block.sourceType] = (bySourceType[block.sourceType] ?? 0) + block.tokenEstimate;
  return { total, bySourceType };
}

function toBlock(candidate: ContextBlockCandidate): ContextBlock {
  return {
    id: candidate.id,
    sourceType: candidate.sourceType,
    title: candidate.title,
    text: candidate.text,
    sourceRef: candidate.sourceRef,
    tokenEstimate: candidate.tokenEstimate,
  };
}
