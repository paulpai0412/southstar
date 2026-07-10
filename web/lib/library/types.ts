export type LibrarySseEvent =
  | "library.chat.delta"
  | "library.intent.started"
  | "library.intent.completed"
  | "library.import.fetching"
  | "library.import.parsing"
  | "library.import.candidates"
  | "library.llm_extract.delta"
  | "library.proposal.created"
  | "library.graph.diff"
  | "library.validation.completed"
  | "library.file.saved"
  | "library.db.synced"
  | "library.graph.snapshot"
  | "library.ontology.graph"
  | "library.command.completed"
  | "library.error";

export type LibrarySseFrame = {
  event: LibrarySseEvent | string;
  data: Record<string, unknown>;
};

export type LibraryObjectStatus = "draft" | "approved" | "deprecated" | "blocked";

export type LibraryWorkspaceObject = {
  id: string;
  objectKey: string;
  objectKind: string;
  status: LibraryObjectStatus | string;
  title: string;
  scope: string;
  sourcePath?: string;
};

export type LibraryWorkspaceObjectGroup = {
  objectKind: string;
  objects: LibraryWorkspaceObject[];
};

export type LibrarySessionSummary = {
  id: string;
  title: string;
  status: string;
  modified?: string;
  detail?: string;
  itemCount?: number;
};

export type LibraryWorkspaceModel = {
  selectedScope: string;
  domains: Array<{
    scope: string;
    objectCount?: number;
    counts: Record<string, number>;
    objects?: LibraryWorkspaceObject[];
    objectKindCounts?: Record<string, number>;
    objectGroups?: LibraryWorkspaceObjectGroup[];
  }>;
};

export type LibraryFileValidationIssue = {
  severity: "info" | "warning" | "error";
  path: string;
  message: string;
  code: string;
};

export type LibraryFileRecord = {
  path?: string;
  kind?: string;
  objectKey?: string;
  objectKind?: string;
  id?: string;
  title?: string;
  scope?: string;
  status?: string;
  schemaVersion?: string;
  frontmatter?: Record<string, unknown>;
  definition?: Record<string, unknown>;
  body?: string;
  sourceHash?: string;
};

export type LibraryFileParseResult =
  | { ok: true; file: LibraryFileRecord; issues: LibraryFileValidationIssue[] }
  | { ok: false; issues: LibraryFileValidationIssue[] };

export type LibraryFileEnvelope = {
  relativePath: string;
  content: string;
  parsed: LibraryFileParseResult;
};

export type LibraryFileSyncResult = {
  object?: unknown;
  edges?: unknown[];
};

export type LibraryImportSourceDocument = {
  path: string;
  label: string;
  content: string;
};

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

export type LibraryImportCandidateInstallResult = {
  draftId: string;
  status: "installed";
  installedObjects: Array<{
    objectKey: string;
    kind: LibraryImportCandidateKind;
    relativePath: string;
    object: unknown;
  }>;
  installedEdges: LibraryGraphEdgeRecord[];
  graph: {
    objectKeys: string[];
    edgeIds: string[];
  };
};

export type LibraryGraphEdgeRecord = {
  id?: string;
  fromObjectKey: string;
  edgeType: string;
  toObjectKey: string;
  scope?: string;
  status?: string;
  weight?: number;
  metadata?: Record<string, unknown>;
  ontology?: {
    category?: string;
    confidence?: number;
    rationale?: string;
    source?: string;
    draftId?: string;
    evidenceRefs?: string[];
  };
};

export type LibraryGraphNodeRecord = {
  id?: string;
  objectKey: string;
  objectKind?: string;
  status?: string;
  title?: string;
  scope?: string;
};

export type LibraryGraphReadModel = {
  activeScope?: string;
  availableScopes?: string[];
  query?: Record<string, unknown>;
  nodes: LibraryGraphNodeRecord[];
  edges: LibraryGraphEdgeRecord[];
};

export type LibraryObjectDetail = {
  object: {
    id?: string;
    objectKey: string;
    objectKind: string;
    status: string;
    headVersionId?: string | null;
    state?: Record<string, unknown>;
  };
  inboundEdges: LibraryGraphEdgeRecord[];
  outboundEdges: LibraryGraphEdgeRecord[];
  usage?: {
    inboundCount: number;
    outboundCount: number;
    usedByObjectKeys: string[];
    dependsOnObjectKeys: string[];
  };
  validation?: {
    ok: boolean;
    issues: Array<{ code: string; path: string; message: string }>;
  };
};

export type LibraryObjectDeleteResult = {
  object: LibraryObjectDetail["object"];
  deletedObjectKey: string;
  deletedObjectCount: number;
  deletedEdgeCount: number;
  inboundEdgeCount: number;
  outboundEdgeCount: number;
};
