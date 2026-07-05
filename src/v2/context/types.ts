import type { BudgetPolicy } from "../design-library/runtime-types.ts";
import type { WorkflowNodePromptSpec } from "../design-library/types.ts";

export const CONTEXT_ASSEMBLY_TRACE_RESOURCE_TYPE = "context_assembly_trace";
export const CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION = "southstar.context_assembly_trace.v1";

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
  nodePromptSpec?: WorkflowNodePromptSpec;
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
  artifactRefs?: string[];
  failureArtifactRefs?: string[];
  memoryRefs?: string[];
  rollbackMarkerRefs?: string[];
  resetMarkerRefs?: string[];
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

export type AttemptLineageRefs = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  handExecutionId?: string;
  contextPacketId?: string;
  taskEnvelopeId?: string;
  artifactRefIds?: string[];
  checkpointId?: string;
  correlationId?: string;
  causationId?: string;
};

export type ContextBlockCandidate = ContextBlock & {
  score: number;
  confidence?: number;
  successScore?: number;
  recencyScore?: number;
  lineage?: AttemptLineageRefs;
};

export type ContextAssemblyValidation = {
  ok: boolean;
  errors: Array<{ code: string; message: string; sourceRef?: string }>;
};

export type ContextAssemblyTrace = {
  schemaVersion: typeof CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION;
  traceId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  contextPacketId: string;
  taskEnvelopeId: string;
  selectedSourceRefs: string[];
  excludedCandidates: ContextExclusion[];
  tokenEstimate: TokenEstimate;
  validation: ContextAssemblyValidation;
  rollbackMarkerRefs?: string[];
  resetMarkerRefs?: string[];
  createdAt: string;
};
