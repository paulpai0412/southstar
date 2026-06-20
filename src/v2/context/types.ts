import type { BudgetPolicy } from "../domain-packs/types.ts";

export type ContextPacket = {
  id: string;
  runId: string;
  taskId: string;
  rootSessionId?: string;
  executionAttempt: number;
  roleRef: string;
  agentProfileRef: string;
  taskGoal: string;
  roleInstruction: string;
  systemInstruction?: string;
  agentsMdBlocks: ContextBlock[];
  artifactContracts: ContextBlock[];
  selectedMemories: ContextBlock[];
  selectedKnowledgeCards: ContextBlock[];
  priorArtifacts: ContextBlock[];
  checkpointSummary?: ContextBlock;
  workspaceSummary?: ContextBlock;
  failureSummary?: ContextBlock;
  skillInstructions: ContextBlock[];
  mcpGrantSummary: ContextBlock[];
  forbiddenActions: string[];
  budget: BudgetPolicy;
  tokenEstimate: TokenEstimate;
  excludedCandidates: ContextExclusion[];
  managedSourceRefs?: ManagedContextSourceRefs;
};

export type ManagedContextSourceRefs = {
  rawEventRefs: Array<{ id: string; sessionId: string; runId: string; sequence: number }>;
  omittedEventRanges: Array<{ fromSequence: number; toSequence: number; reason: string }>;
  transformRefs: Array<{ id: string; kind: "summary" | "filter" | "redaction"; sourceEventIds: string[] }>;
  checkpointRefs: string[];
  cacheKey?: string;
};

export type ContextBlock = {
  id: string;
  sourceType:
    | "prompt"
    | "role"
    | "agents-md"
    | "memory"
    | "knowledge_card"
    | "artifact"
    | "checkpoint"
    | "skill"
    | "mcp"
    | "failure"
    | "workspace";
  title: string;
  text: string;
  sourceRef?: string;
  tokenEstimate: number;
};

export type TokenEstimate = {
  total: number;
  bySourceType: Record<string, number>;
};

export type ContextExclusion = {
  sourceRef: string;
  reason: "duplicate" | "over-budget" | "low-score" | "scope-mismatch" | "kind-mismatch";
  tokenEstimate: number;
};
