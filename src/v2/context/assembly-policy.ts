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
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/-]{16,}|\b(?:token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}|\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b)/i;

export function assembleContextBlocks(input: ContextAssemblyPolicyInput): ContextAssemblyPolicyResult {
  const pendingMemoryRefs = new Set(input.pendingMemoryRefs);
  const invalidatedSourceRefs = new Set(input.invalidatedSourceRefs);
  const excludedCandidates: ContextExclusion[] = [];
  const selected: ContextBlock[] = [];
  const selectedRefs = new Set<string>();
  let totalTokens = 0;
  let memoryTokens = 0;
  const validCandidates = filterCandidates(input, pendingMemoryRefs, invalidatedSourceRefs, excludedCandidates);
  const requiredSourceRefs = new Set(input.requiredSourceRefs);
  const errors: ContextAssemblyValidation["errors"] = [];

  for (const sourceRef of input.requiredSourceRefs) {
    const candidate = validCandidates.find((item) => sourceRefOf(item) === sourceRef);
    if (!candidate) {
      errors.push({ code: "required-source-missing", message: `required source ref missing: ${sourceRef}`, sourceRef });
      continue;
    }

    const accepted = selectCandidate(candidate, input, selected, selectedRefs, totalTokens, memoryTokens, excludedCandidates);
    if (!accepted.ok) {
      totalTokens = accepted.totalTokens;
      memoryTokens = accepted.memoryTokens;
      errors.push({ code: "required-source-missing", message: `required source ref missing: ${sourceRef}`, sourceRef });
      continue;
    }

    totalTokens = accepted.totalTokens;
    memoryTokens = accepted.memoryTokens;
  }

  for (const candidate of validCandidates) {
    if (requiredSourceRefs.has(sourceRefOf(candidate)) || selectedRefs.has(sourceRefOf(candidate))) continue;
    const accepted = selectCandidate(candidate, input, selected, selectedRefs, totalTokens, memoryTokens, excludedCandidates);
    totalTokens = accepted.totalTokens;
    memoryTokens = accepted.memoryTokens;
  }

  return {
    selected,
    excludedCandidates,
    tokenEstimate: estimateTokens(selected, totalTokens),
    validation: { ok: errors.length === 0, errors },
  };
}

function filterCandidates(
  input: ContextAssemblyPolicyInput,
  pendingMemoryRefs: Set<string>,
  invalidatedSourceRefs: Set<string>,
  excludedCandidates: ContextExclusion[],
): ContextBlockCandidate[] {
  const validCandidates: ContextBlockCandidate[] = [];
  const seenSourceRefs = new Set<string>();

  for (const candidate of [...input.candidates].sort(compareCandidate)) {
    const sourceRef = sourceRefOf(candidate);
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
    if (seenSourceRefs.has(sourceRef)) {
      excludedCandidates.push(exclusion(candidate, "duplicate"));
      continue;
    }

    seenSourceRefs.add(sourceRef);
    validCandidates.push(candidate);
  }

  return validCandidates;
}

function selectCandidate(
  candidate: ContextBlockCandidate,
  input: ContextAssemblyPolicyInput,
  selected: ContextBlock[],
  selectedRefs: Set<string>,
  totalTokens: number,
  memoryTokens: number,
  excludedCandidates: ContextExclusion[],
): { ok: boolean; totalTokens: number; memoryTokens: number } {
  const nextMemoryTokens = candidate.sourceType === "memory" ? memoryTokens + candidate.tokenEstimate : memoryTokens;
  const nextTotalTokens = totalTokens + candidate.tokenEstimate;

  if (candidate.sourceType === "memory" && nextMemoryTokens > input.maxMemoryTokens) {
    excludedCandidates.push(exclusion(candidate, "over-budget"));
    return { ok: false, totalTokens, memoryTokens };
  }
  if (nextTotalTokens > input.maxInputTokens) {
    excludedCandidates.push(exclusion(candidate, "over-budget"));
    return { ok: false, totalTokens, memoryTokens };
  }

  selected.push(toBlock(candidate));
  selectedRefs.add(sourceRefOf(candidate));
  return { ok: true, totalTokens: nextTotalTokens, memoryTokens: nextMemoryTokens };
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

function sourceRefOf(candidate: ContextBlockCandidate): string {
  return candidate.sourceRef ?? candidate.id;
}

function exclusion(candidate: ContextBlockCandidate, reason: ContextExclusion["reason"]): ContextExclusion {
  return { sourceRef: sourceRefOf(candidate), reason, tokenEstimate: candidate.tokenEstimate };
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
