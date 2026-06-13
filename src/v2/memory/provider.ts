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
  add(input: MemoryWriteRequest): MemoryWriteResult;
  search(input: MemorySearchRequest): MemoryCandidate[];
}
