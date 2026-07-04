import type { LibraryImportSourceDocument } from "./library-source-fetcher.ts";

export type LibraryImportCandidateKind = "agent" | "skill" | "mcp" | "tool";
export type LibraryImportEdgeType =
  | "belongs_to_domain"
  | "has_capability"
  | "provides"
  | "uses"
  | "requires"
  | "conflicts_with"
  | "precedes"
  | "workflow_precedes"
  | "unblocks"
  | "validates"
  | "reviews"
  | "produces"
  | "consumes"
  | "similar_to"
  | "substitutes"
  | "complements"
  | "incompatible_with"
  | "requires_approval"
  | "requires_secret_group"
  | "requires_secret";

export type LibraryImportCandidate = {
  objectKey: string;
  kind: LibraryImportCandidateKind;
  title: string;
  scope: string;
  domain?: string;
  displayDomain?: string;
  classificationReason?: string;
  sourcePath?: string;
  selectedByDefault: boolean;
  confidence?: number;
};

export type LibraryImportProposedEdge = {
  fromObjectKey: string;
  edgeType: LibraryImportEdgeType;
  toObjectKey: string;
  confidence: number;
  rationale?: string;
};

export function extractLibraryCandidatesFromDocuments(input: {
  documents: LibraryImportSourceDocument[];
  scope: string;
}): { candidates: LibraryImportCandidate[]; proposedEdges: LibraryImportProposedEdge[] } {
  const candidates = input.documents.flatMap((document) => {
    const kind = kindFromDocumentPath(document.path);
    if (!kind) return [];
    const slug = slugFromDocumentPath(document.path, kind);
    return [{
      objectKey: `${kind}.${slug}`,
      kind,
      title: document.label || titleFromSlug(slug),
      scope: input.scope,
      sourcePath: document.path,
      selectedByDefault: true,
      confidence: 0.6,
    }];
  });

  return {
    candidates,
    proposedEdges: proposeSimpleEdges(candidates),
  };
}

function proposeSimpleEdges(candidates: LibraryImportCandidate[]): LibraryImportProposedEdge[] {
  const agents = candidates.filter((candidate) => candidate.kind === "agent");
  const skills = candidates.filter((candidate) => candidate.kind === "skill");
  const mcps = candidates.filter((candidate) => candidate.kind === "mcp");
  const tools = candidates.filter((candidate) => candidate.kind === "tool");
  const edges: LibraryImportProposedEdge[] = [];

  if (agents.length === 1 && skills.length === 1) {
    edges.push({
      fromObjectKey: agents[0].objectKey,
      edgeType: "uses",
      toObjectKey: skills[0].objectKey,
      confidence: 0.6,
      rationale: "Detected one agent and one skill in imported documents.",
    });
  }

  if (skills.length === 1) {
    for (const mcp of mcps) {
      edges.push({
        fromObjectKey: skills[0].objectKey,
        edgeType: "requires",
        toObjectKey: mcp.objectKey,
        confidence: 0.6,
        rationale: "Detected skill and imported MCP grant documents.",
      });
    }
    for (const tool of tools) {
      edges.push({
        fromObjectKey: skills[0].objectKey,
        edgeType: "requires",
        toObjectKey: tool.objectKey,
        confidence: 0.6,
        rationale: "Detected skill and imported tool documents.",
      });
    }
  }

  return edges;
}

function kindFromDocumentPath(documentPath: string): LibraryImportCandidateKind | null {
  const normalized = documentPath.toLowerCase();
  if (normalized.includes("/agents/") || normalized.includes(".agent.")) return "agent";
  if (normalized.includes("/skills/") || normalized.includes(".skill.")) return "skill";
  if (normalized.includes("/mcp/") || normalized.includes(".mcp.")) return "mcp";
  if (normalized.includes("/tools/") || normalized.includes(".tool.")) return "tool";
  return null;
}

function slugFromDocumentPath(documentPath: string, kind: LibraryImportCandidateKind): string {
  const basename = documentPath.split("/").at(-1) ?? documentPath;
  return basename
    .replace(/\.(mdx?|ya?ml|json)$/i, "")
    .replace(new RegExp(`\\.${kind}$`, "i"), "")
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .toLowerCase();
}

function titleFromSlug(slug: string): string {
  return slug.split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
