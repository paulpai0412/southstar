import {
  type LibraryImportCandidate,
  type LibraryImportCandidateKind,
  type LibraryImportEdgeType,
  type LibraryImportProposedEdge,
} from "./library-candidate-extractor.ts";
import type { LibraryImportSourceDocument } from "./library-source-fetcher.ts";
import {
  CATALOG_CANONICAL_DOMAINS,
  catalogDomainFromSourcePath,
  catalogDomainTitle,
  isCatalogCanonicalDomain,
} from "../canonical-domains.ts";
import type { LibraryDefinitionKind, LibraryDefinitionStatus, LibraryEdgeType } from "../types.ts";

const ALLOWED_ONTOLOGY_EDGE_TYPES: LibraryImportEdgeType[] = [
  "belongs_to_domain",
  "has_capability",
  "provides",
  "uses",
  "requires",
  "conflicts_with",
  "precedes",
  "workflow_precedes",
  "unblocks",
  "validates",
  "reviews",
  "produces",
  "consumes",
  "similar_to",
  "substitutes",
  "complements",
  "incompatible_with",
  "requires_approval",
  "requires_secret_group",
  "requires_secret",
];
const MAX_PROMPT_DOCUMENT_CHARS = 120_000;
const MAX_DOCUMENT_EXCERPT_CHARS = 1_200;

export type LibraryImportLlmProvider = (input: {
  prompt: string;
  scope: string;
  documents: LibraryImportSourceDocument[];
  requestPrompt?: string;
  sourceRepoPath?: string;
}) => Promise<unknown>;

export type LibraryImportOntologyExistingGraphNode = {
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  title?: string;
  scope?: string;
  summary?: string;
  headVersionId?: string | null;
};

export type LibraryImportOntologyExistingGraphEdge = {
  fromObjectKey: string;
  edgeType: LibraryEdgeType;
  toObjectKey: string;
  scope?: string;
  weight?: number;
};

export type LibraryImportOntologyExistingGraph = {
  nodes: LibraryImportOntologyExistingGraphNode[];
  edges: LibraryImportOntologyExistingGraphEdge[];
};

export async function analyzeLibraryImportWithLlm(input: {
  documents: LibraryImportSourceDocument[];
  scope: string;
  llmProvider?: LibraryImportLlmProvider;
  requestPrompt?: string;
  sourceRepoPath?: string;
}): Promise<{ candidates: LibraryImportCandidate[]; proposedEdges: LibraryImportProposedEdge[] }> {
  const candidates = await analyzeLibraryImportCandidatesWithLlm(input);
  return { candidates, proposedEdges: [] };
}

export async function analyzeLibraryImportCandidatesWithLlm(input: {
  documents: LibraryImportSourceDocument[];
  scope: string;
  llmProvider?: LibraryImportLlmProvider;
  requestPrompt?: string;
  sourceRepoPath?: string;
}): Promise<LibraryImportCandidate[]> {
  if (!input.llmProvider) {
    throw new Error("library import analysis requires an LLM provider");
  }

  const raw = await input.llmProvider({
    scope: input.scope,
    documents: input.documents,
    requestPrompt: input.requestPrompt,
    sourceRepoPath: input.sourceRepoPath,
    prompt: buildLibraryImportCandidatePrompt(input.documents, input.scope, {
      requestPrompt: input.requestPrompt,
      sourceRepoPath: input.sourceRepoPath,
    }),
  });
  return normalizeLlmImportAnalysis(raw, {
    scope: input.scope,
    sourcePaths: new Set(input.documents.map((document) => document.path)),
  }).candidates;
}

export async function analyzeLibraryImportOntologyWithLlm(input: {
  candidates: LibraryImportCandidate[];
  scope: string;
  llmProvider?: LibraryImportLlmProvider;
  requestPrompt?: string;
  sourceRepoPath?: string;
  documents?: LibraryImportSourceDocument[];
  existingGraph?: LibraryImportOntologyExistingGraph;
}): Promise<LibraryImportProposedEdge[]> {
  if (!input.llmProvider) {
    throw new Error("library import ontology analysis requires an LLM provider");
  }
  const documents = input.documents ?? [];
  const raw = await input.llmProvider({
    scope: input.scope,
    documents,
    requestPrompt: input.requestPrompt,
    sourceRepoPath: input.sourceRepoPath,
    prompt: buildLibraryImportOntologyPrompt(input.candidates, input.scope, {
      requestPrompt: input.requestPrompt,
      sourceRepoPath: input.sourceRepoPath,
      existingGraph: input.existingGraph,
    }),
  });
  const candidateKeys = new Set(input.candidates.map((candidate) => candidate.objectKey));
  return normalizeEdges(
    edgeArrayFromRecord(isRecord(typeof raw === "string" ? safeJsonParse(raw) : raw)
      ? (typeof raw === "string" ? safeJsonParse(raw) : raw) as Record<string, unknown>
      : {}),
    candidateKeys,
    { existingObjectKeys: new Set((input.existingGraph?.nodes ?? []).map((node) => node.objectKey)) },
  );
}

export function buildLibraryImportAnalysisPrompt(
  documents: LibraryImportSourceDocument[],
  scope: string,
  options: { requestPrompt?: string; sourceRepoPath?: string } = {},
): string {
  return buildLibraryImportCandidatePrompt(documents, scope, options);
}

export function buildLibraryImportCandidatePrompt(
  documents: LibraryImportSourceDocument[],
  scope: string,
  options: { requestPrompt?: string; sourceRepoPath?: string } = {},
): string {
  const manifest = documents.map((document) => `- ${document.path}: ${document.label}`).join("\n");
  const excerpts = renderDocumentExcerpts(documents);
  const requestSection = options.requestPrompt
    ? ["UserImportRequest:", options.requestPrompt].join("\n")
    : "";
  const repoPathSection = options.sourceRepoPath
    ? [
      "LocalRepositoryPath:",
      options.sourceRepoPath,
      "Use this local repository path as the primary source of truth. Inspect the repository contents yourself before selecting candidates. Do not rely on path names alone.",
    ].join("\n")
    : "";
  return [
    "Classify the requested repository/library source into Southstar library candidates.",
    "Return exactly one JSON object. No markdown, comments, or prose outside JSON.",
    "Use this shape: {\"candidates\":[{\"objectKey\":\"agent.example\",\"kind\":\"agent\",\"title\":\"Example\",\"domain\":\"engineering\",\"sourcePath\":\"relative/path.md\",\"selectedByDefault\":true,\"confidence\":0.9,\"classificationReason\":\"...\"}]}",
    "Allowed candidate kinds: agent, skill, mcp, tool.",
    "domain must be one canonical domain key from CanonicalDomainTaxonomy. Do not invent domains and do not use software unless it appears in the taxonomy.",
    "If source paths clearly map to a canonical domain prefix, use that domain even when the item is broadly useful.",
    "If the user asks to import agents from a repo catalog, inspect the repo and return one agent candidate per real agent definition. Do not collapse many agents into a summary candidate.",
    "If the source is a skill repository, return one skill candidate per real skills/<slug>/SKILL.md definition using objectKey skill.<slug> and that SKILL.md as sourcePath. Do not collapse many skills into a summary candidate.",
    "For large repositories, first inspect repository catalog/index/list documents when present, then inspect representative linked definitions as needed before returning JSON.",
    "Treat LocalRepositoryPath as read-only for this analysis. Do not create, edit, delete, or install files while analyzing candidates.",
    `Scope: ${scope}`,
    requestSection,
    repoPathSection,
    "CanonicalDomainTaxonomy:",
    JSON.stringify(CATALOG_CANONICAL_DOMAINS.map((domain) => ({
      key: domain.key,
      title: domain.title,
      sourcePathPrefixes: domain.sourcePathPrefixes,
    }))),
    "OptionalDocumentManifest:",
    manifest || "(none; inspect LocalRepositoryPath)",
    "",
    "OptionalDocumentContentExcerpts:",
    excerpts || "(none; inspect LocalRepositoryPath)",
  ].filter((line) => line.length > 0).join("\n");
}

export function buildLibraryImportOntologyPrompt(
  candidates: LibraryImportCandidate[],
  scope: string,
  options: {
    requestPrompt?: string;
    sourceRepoPath?: string;
    existingGraph?: LibraryImportOntologyExistingGraph;
  } = {},
): string {
  const requestSection = options.requestPrompt
    ? ["UserImportRequest:", options.requestPrompt].join("\n")
    : "";
  const repoPathSection = options.sourceRepoPath
    ? [
      "LocalRepositoryPath:",
      options.sourceRepoPath,
      "Use this local repository path as supporting evidence when deciding relationships. Treat it as read-only.",
    ].join("\n")
    : "";
  return [
    "Generate ontology edges for the selected Southstar library candidates and the existing approved Southstar library graph.",
    "Return exactly one JSON object. No markdown, comments, or prose outside JSON.",
    "Use this shape: {\"proposedEdges\":[{\"fromObjectKey\":\"agent.example\",\"edgeType\":\"uses\",\"toObjectKey\":\"skill.example\",\"confidence\":0.8,\"rationale\":\"...\"}]}",
    `Allowed ontology edges: ${ALLOWED_ONTOLOGY_EDGE_TYPES.join(", ")}.`,
    "Generate incremental ontology edges for the selected candidates. Relate new nodes to selected or existing approved nodes when evidence supports profile composition, workflow order, artifact flow, similarity, substitution, complementarity, risk, or conflict.",
    "At least one endpoint must be one of the selected candidates. Do not create edges where both endpoints are existing graph nodes.",
    "Only use endpoints from SelectedCandidates or ExistingApprovedGraphNodes. Omit uncertain edges.",
    `Scope: ${scope}`,
    requestSection,
    repoPathSection,
    "SelectedCandidates:",
    JSON.stringify(candidates.map((candidate) => ({
      objectKey: candidate.objectKey,
      kind: candidate.kind,
      title: candidate.title,
      sourcePath: candidate.sourcePath,
    }))),
    "ExistingApprovedGraphNodes:",
    JSON.stringify((options.existingGraph?.nodes ?? []).map((node) => ({
      objectKey: node.objectKey,
      objectKind: node.objectKind,
      title: node.title,
      scope: node.scope,
      summary: node.summary,
      headVersionId: node.headVersionId,
    }))),
    "ExistingApprovedGraphEdges:",
    JSON.stringify((options.existingGraph?.edges ?? []).map((edge) => ({
      fromObjectKey: edge.fromObjectKey,
      edgeType: edge.edgeType,
      toObjectKey: edge.toObjectKey,
      scope: edge.scope,
      weight: edge.weight,
    }))),
  ].filter((line) => line.length > 0).join("\n");
}

function renderDocumentExcerpts(documents: LibraryImportSourceDocument[]): string {
  const chunks: string[] = [];
  let remaining = MAX_PROMPT_DOCUMENT_CHARS;
  for (const document of documents) {
    if (remaining <= 0) break;
    const excerpt = normalizeExcerpt(document.content).slice(0, Math.min(MAX_DOCUMENT_EXCERPT_CHARS, remaining));
    const chunk = [
      `--- ${document.path}`,
      excerpt,
    ].join("\n");
    chunks.push(chunk);
    remaining -= chunk.length;
  }
  return chunks.join("\n\n");
}

function normalizeExcerpt(content: string): string {
  return content.replaceAll(/\r\n?/g, "\n").trim();
}

function normalizeLlmImportAnalysis(
  raw: unknown,
  options: { scope: string; sourcePaths: Set<string> },
): { candidates: LibraryImportCandidate[]; proposedEdges: LibraryImportProposedEdge[] } {
  const value = typeof raw === "string" ? safeJsonParse(raw) : raw;
  const record = isRecord(value) ? value : {};
  const candidates = normalizeCandidates(record.candidates, options);
  const candidateKeys = new Set(candidates.map((candidate) => candidate.objectKey));
  const proposedEdges = normalizeEdges(edgeArrayFromRecord(record), candidateKeys);
  return { candidates, proposedEdges };
}

function normalizeCandidates(value: unknown, options: { scope: string; sourcePaths: Set<string> }): LibraryImportCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: LibraryImportCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const kind = normalizeKind(candidate.kind);
    if (!kind) continue;
    const objectKey = canonicalizeObjectKeyFromSourcePath(
      kind,
      optionalString(candidate.objectKey) ?? objectKeyFromKindAndTitle(kind, optionalString(candidate.title)),
      optionalString(candidate.sourcePath),
    );
    if (!objectKey || !objectKey.startsWith(`${kind}.`) || seen.has(objectKey)) continue;
    const sourcePath = optionalString(candidate.sourcePath);
    if (sourcePath && options.sourcePaths.size > 0 && !options.sourcePaths.has(sourcePath)) continue;
    const pathDomain = catalogDomainFromSourcePath(sourcePath);
    const llmDomain = optionalString(candidate.domain) ?? optionalString(candidate.scope);
    const invalidExplicitDomain = Boolean(llmDomain && !isCatalogCanonicalDomain(llmDomain));
    if (!pathDomain && invalidExplicitDomain) continue;
    const domain = pathDomain?.key ?? (isCatalogCanonicalDomain(llmDomain) ? llmDomain : undefined);
    const scope = domain ?? options.scope;
    const title = optionalString(candidate.title);
    seen.add(objectKey);
    candidates.push({
      objectKey,
      kind,
      title: title && !isGenericDefinitionTitle(title, kind) ? title : titleFromObjectKey(objectKey),
      scope,
      ...(domain ? { domain, displayDomain: catalogDomainTitle(domain) } : {}),
      ...(optionalString(candidate.classificationReason) ? { classificationReason: optionalString(candidate.classificationReason) } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      selectedByDefault: typeof candidate.selectedByDefault === "boolean" ? candidate.selectedByDefault : true,
      confidence: clampConfidence(candidate.confidence),
    });
  }
  return candidates;
}

function normalizeEdges(
  value: unknown,
  candidateKeys: Set<string>,
  options: { existingObjectKeys?: Set<string> } = {},
): LibraryImportProposedEdge[] {
  if (!Array.isArray(value)) return [];
  const edges: LibraryImportProposedEdge[] = [];
  const seen = new Set<string>();
  const existingObjectKeys = options.existingObjectKeys ?? new Set<string>();
  const allowedObjectKeys = new Set([...candidateKeys, ...existingObjectKeys]);
  for (const edge of value) {
    if (!isRecord(edge)) continue;
    const edgeType = normalizeEdgeType(edge.edgeType);
    const fromObjectKey = optionalString(edge.fromObjectKey);
    const toObjectKey = optionalString(edge.toObjectKey);
    if (!edgeType || !fromObjectKey || !toObjectKey) continue;
    if (!allowedObjectKeys.has(fromObjectKey) || !allowedObjectKeys.has(toObjectKey)) continue;
    if (!candidateKeys.has(fromObjectKey) && !candidateKeys.has(toObjectKey)) continue;
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

function edgeArrayFromRecord(record: Record<string, unknown>): unknown {
  return Array.isArray(record.proposedEdges) ? record.proposedEdges : record.edges;
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
  return ALLOWED_ONTOLOGY_EDGE_TYPES.includes(value as LibraryImportEdgeType)
    ? value as LibraryImportEdgeType
    : null;
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

function canonicalizeObjectKeyFromSourcePath(
  kind: LibraryImportCandidateKind,
  objectKey: string | null,
  sourcePath: string | undefined,
): string | null {
  if (!objectKey || !sourcePath) return objectKey;
  const normalizedPath = sourcePath.replaceAll("\\", "/");
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length === 0) return objectKey;
  const fileName = segments.at(-1);
  if (!fileName) return objectKey;
  const stem = fileName.replace(/\.[^.]+$/, "");
  const canonicalSlug = slugFromCanonicalDefinitionPath(kind, segments, stem);
  if (!objectKey.startsWith(`${kind}.`)) return `${kind}.${canonicalSlug}`;
  const slugSegments = objectKey.slice(`${kind}.`.length).split(".").filter(Boolean);
  if (isGenericDefinitionTitle(slugSegments.join("."), kind)) return `${kind}.${canonicalSlug}`;
  if (slugSegments.length > 1 && slugSegments.at(-1) === stem) return `${kind}.${canonicalSlug}`;
  return objectKey;
}

function slugFromCanonicalDefinitionPath(kind: LibraryImportCandidateKind, segments: string[], stem: string): string {
  if (!isGenericDefinitionTitle(stem, kind)) return stem;
  const folderName = kind === "mcp" ? "mcp" : `${kind}s`;
  const folderIndex = segments.findLastIndex((segment) => segment.toLowerCase() === folderName);
  return folderIndex >= 0 && segments[folderIndex + 1] ? segments[folderIndex + 1] : stem;
}

function isGenericDefinitionTitle(value: string, kind: LibraryImportCandidateKind): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === kind || normalized === `${kind}s`;
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
