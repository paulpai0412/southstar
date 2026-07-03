import {
  extractLibraryCandidatesFromDocuments,
  type LibraryImportCandidate,
  type LibraryImportCandidateKind,
  type LibraryImportEdgeType,
  type LibraryImportProposedEdge,
} from "./library-candidate-extractor.ts";
import type { LibraryImportSourceDocument } from "./library-source-fetcher.ts";

export type LibraryImportLlmProvider = (input: {
  prompt: string;
  scope: string;
  documents: LibraryImportSourceDocument[];
}) => Promise<unknown>;

export async function analyzeLibraryImportWithLlm(input: {
  documents: LibraryImportSourceDocument[];
  scope: string;
  llmProvider?: LibraryImportLlmProvider;
}): Promise<{ candidates: LibraryImportCandidate[]; proposedEdges: LibraryImportProposedEdge[] }> {
  if (!input.llmProvider) {
    return extractLibraryCandidatesFromDocuments({ documents: input.documents, scope: input.scope });
  }

  const raw = await input.llmProvider({
    scope: input.scope,
    documents: input.documents,
    prompt: buildLibraryImportAnalysisPrompt(input.documents, input.scope),
  });
  return normalizeLlmImportAnalysis(raw, input.scope);
}

export function buildLibraryImportAnalysisPrompt(documents: LibraryImportSourceDocument[], scope: string): string {
  const manifest = documents.map((document) => `- ${document.path}: ${document.label}`).join("\n");
  return [
    "Classify these repository/library documents into Southstar library candidates.",
    "Return JSON with candidates and ontology edges.",
    "Allowed candidate kinds: agent, skill, mcp, tool.",
    "Allowed ontology edges: uses, requires.",
    `Scope: ${scope}`,
    "Documents:",
    manifest,
  ].join("\n");
}

function normalizeLlmImportAnalysis(
  raw: unknown,
  scope: string,
): { candidates: LibraryImportCandidate[]; proposedEdges: LibraryImportProposedEdge[] } {
  const value = typeof raw === "string" ? safeJsonParse(raw) : raw;
  const record = isRecord(value) ? value : {};
  const candidates = normalizeCandidates(record.candidates, scope);
  const candidateKeys = new Set(candidates.map((candidate) => candidate.objectKey));
  const proposedEdges = normalizeEdges(record.proposedEdges, candidateKeys);
  return { candidates, proposedEdges };
}

function normalizeCandidates(value: unknown, scope: string): LibraryImportCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: LibraryImportCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const kind = normalizeKind(candidate.kind);
    if (!kind) continue;
    const objectKey = optionalString(candidate.objectKey) ?? objectKeyFromKindAndTitle(kind, optionalString(candidate.title));
    if (!objectKey || !objectKey.startsWith(`${kind}.`) || seen.has(objectKey)) continue;
    seen.add(objectKey);
    candidates.push({
      objectKey,
      kind,
      title: optionalString(candidate.title) ?? titleFromObjectKey(objectKey),
      scope,
      ...(optionalString(candidate.sourcePath) ? { sourcePath: optionalString(candidate.sourcePath) } : {}),
      selectedByDefault: typeof candidate.selectedByDefault === "boolean" ? candidate.selectedByDefault : true,
      confidence: clampConfidence(candidate.confidence),
    });
  }
  return candidates;
}

function normalizeEdges(value: unknown, candidateKeys: Set<string>): LibraryImportProposedEdge[] {
  if (!Array.isArray(value)) return [];
  const edges: LibraryImportProposedEdge[] = [];
  const seen = new Set<string>();
  for (const edge of value) {
    if (!isRecord(edge)) continue;
    const edgeType = normalizeEdgeType(edge.edgeType);
    const fromObjectKey = optionalString(edge.fromObjectKey);
    const toObjectKey = optionalString(edge.toObjectKey);
    if (!edgeType || !fromObjectKey || !toObjectKey) continue;
    if (!candidateKeys.has(fromObjectKey) || !candidateKeys.has(toObjectKey)) continue;
    const identity = `${fromObjectKey}:${edgeType}:${toObjectKey}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    edges.push({
      fromObjectKey,
      edgeType,
      toObjectKey,
      confidence: clampConfidence(edge.confidence),
      ...(optionalString(edge.rationale) ? { rationale: optionalString(edge.rationale) } : {}),
    });
  }
  return edges;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function normalizeKind(value: unknown): LibraryImportCandidateKind | null {
  return value === "agent" || value === "skill" || value === "mcp" || value === "tool" ? value : null;
}

function normalizeEdgeType(value: unknown): LibraryImportEdgeType | null {
  return value === "uses" || value === "requires" ? value : null;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function objectKeyFromKindAndTitle(kind: LibraryImportCandidateKind, title: string | undefined): string | null {
  if (!title) return null;
  const slug = title.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "").toLowerCase();
  return slug.length > 0 ? `${kind}.${slug}` : null;
}

function titleFromObjectKey(objectKey: string): string {
  const slug = objectKey.replace(/^[^.]+\./, "");
  return slug.split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
