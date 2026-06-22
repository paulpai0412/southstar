export type MemorySearchRequest = {
  query: string;
  scopes: string[];
  maxCandidates: number;
};

export type MemoryCandidate = {
  id: string;
  scope: string;
  kind: string;
  text: string;
  score: number;
  confidence: number;
  successScore: number;
  tokenEstimate: number;
  sourceRef?: string;
};

export type ContextMemorySearchInput = {
  runId: string;
  query: string;
  scopes: string[];
  allowedKinds: string[];
  maxCandidates: number;
};

export type ContextMemoryCandidate = MemoryCandidate & {
  status: "active" | "approved";
  runId?: string;
  taskId?: string;
  sessionId?: string;
  tags: string[];
  sourceRefs: string[];
};

export type MemoryWriteRequest = {
  scope: string;
  kind: string;
  text: string;
  tags: string[];
  confidence: number;
  successScore: number;
  sourceRunId?: string;
  sourceArtifactId?: string;
};

export type MemoryWriteResult = {
  id: string;
};

export interface MemoryProvider {
  add(input: MemoryWriteRequest): Promise<MemoryWriteResult>;
  search(input: MemorySearchRequest): Promise<MemoryCandidate[]>;
}
