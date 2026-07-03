import type { SouthstarDb } from "../db/postgres.ts";
import { listLibraryEdges, listLibraryObjects } from "../design-library/library-graph-store.ts";
import type {
  LibraryDefinitionKind,
  LibraryDefinitionStatus,
  LibraryEdgeRecord,
  LibraryEdgeType,
  LibraryObjectSummary,
} from "../design-library/types.ts";

export type LibraryGraphNode = {
  id: string;
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryObjectSummary["status"];
  title: string;
  scope: string;
};

export type LibraryGraphEdge = {
  id: string;
  fromObjectKey: string;
  edgeType: LibraryEdgeType;
  toObjectKey: string;
  scope: string;
  status: LibraryEdgeRecord["status"];
  weight: number;
  ontology?: LibraryGraphEdgeOntology;
};

export type LibraryGraphEdgeOntology = {
  category?: string;
  confidence?: number;
  rationale?: string;
  source?: string;
  draftId?: string;
  evidenceRefs?: string[];
};

export type LibraryGraphReadModel = {
  activeScope: string;
  availableScopes: string[];
  nodes: LibraryGraphNode[];
  edges: LibraryGraphEdge[];
};

export async function buildLibraryGraphReadModel(
  db: SouthstarDb,
  input: {
    scope?: string;
    objectKey?: string;
    depth?: number;
    kind?: LibraryDefinitionKind;
    status?: LibraryDefinitionStatus;
  } = {},
): Promise<LibraryGraphReadModel> {
  const activeScope = input.scope && input.scope !== "all" ? input.scope : "all";
  const allObjects = await listLibraryObjects(db);
  const scopedObjects = await listLibraryObjects(db, {
    scope: activeScope,
    objectKind: input.kind,
    status: input.status,
  });
  const scopedEdges = activeScope === "all" ? await listLibraryEdges(db) : await listLibraryEdges(db, { scope: activeScope });
  const objectByKey = new Map(scopedObjects.map((object) => [object.objectKey, object]));
  const candidateEdges = scopedEdges.filter((edge) => objectByKey.has(edge.fromObjectKey) && objectByKey.has(edge.toObjectKey));
  const scopeVisibleKeys = buildScopeVisibleKeys(activeScope, scopedObjects, candidateEdges);
  const neighborhoodKeys = input.objectKey
    ? buildNeighborhoodKeys(input.objectKey, objectByKey, candidateEdges, input.depth ?? 1)
    : null;
  const visibleKeys = neighborhoodKeys ? intersectSets(scopeVisibleKeys, neighborhoodKeys) : scopeVisibleKeys;

  const visibleEdges = candidateEdges.filter((edge) => visibleKeys.has(edge.fromObjectKey) && visibleKeys.has(edge.toObjectKey));
  const nodes = scopedObjects
    .filter((object) => visibleKeys.has(object.objectKey))
    .sort((left, right) => compareVisibleObjects(activeScope, left, right))
    .map(toGraphNode);

  return {
    activeScope,
    availableScopes: buildAvailableScopes(allObjects),
    nodes,
    edges: visibleEdges.map(toGraphEdge),
  };
}

function buildNeighborhoodKeys(
  objectKey: string,
  objectByKey: Map<string, LibraryObjectSummary>,
  edges: LibraryEdgeRecord[],
  depth: number,
): Set<string> {
  if (!objectByKey.has(objectKey)) return new Set();

  const boundedDepth = Math.max(0, depth);
  const visible = new Set([objectKey]);
  let frontier = new Set([objectKey]);

  for (let distance = 0; distance < boundedDepth; distance += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.fromObjectKey) && !visible.has(edge.toObjectKey)) next.add(edge.toObjectKey);
      if (frontier.has(edge.toObjectKey) && !visible.has(edge.fromObjectKey)) next.add(edge.fromObjectKey);
    }
    for (const key of next) visible.add(key);
    frontier = next;
    if (frontier.size === 0) break;
  }

  return visible;
}

function buildScopeVisibleKeys(activeScope: string, objects: LibraryObjectSummary[], edges: LibraryEdgeRecord[]): Set<string> {
  if (activeScope === "all" || activeScope === "global") {
    return new Set(objects.map((object) => object.objectKey));
  }

  const visible = new Set<string>();
  for (const object of objects) {
    if (objectBelongsToScope(object, activeScope)) visible.add(object.objectKey);
  }

  for (const edge of edges) {
    if (visible.has(edge.fromObjectKey)) visible.add(edge.toObjectKey);
    if (visible.has(edge.toObjectKey)) visible.add(edge.fromObjectKey);
  }

  return visible;
}

function buildAvailableScopes(objects: LibraryObjectSummary[]): string[] {
  const scopes = new Set<string>();
  for (const object of objects) {
    scopes.add(getObjectScope(object));
    const domainRefs = object.state.domainRefs;
    if (Array.isArray(domainRefs)) {
      for (const ref of domainRefs) {
        if (typeof ref === "string" && ref.length > 0) scopes.add(ref);
      }
    }
  }
  scopes.delete("all");
  return ["all", ...Array.from(scopes).sort((left, right) => left.localeCompare(right))];
}

function intersectSets(left: Set<string>, right: Set<string>): Set<string> {
  const intersection = new Set<string>();
  for (const value of left) {
    if (right.has(value)) intersection.add(value);
  }
  return intersection;
}

function toGraphNode(object: LibraryObjectSummary): LibraryGraphNode {
  return {
    id: object.id,
    objectKey: object.objectKey,
    objectKind: object.objectKind,
    status: object.status,
    title: getObjectTitle(object),
    scope: getObjectScope(object),
  };
}

function compareVisibleObjects(activeScope: string, left: LibraryObjectSummary, right: LibraryObjectSummary): number {
  if (activeScope !== "all" && activeScope !== "global") {
    const leftRank = objectBelongsToScope(left, activeScope) ? 0 : 1;
    const rightRank = objectBelongsToScope(right, activeScope) ? 0 : 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }
  return 0;
}

function toGraphEdge(edge: LibraryEdgeRecord): LibraryGraphEdge {
  const ontology = toGraphEdgeOntology(edge);
  return {
    id: edge.id,
    fromObjectKey: edge.fromObjectKey,
    edgeType: edge.edgeType,
    toObjectKey: edge.toObjectKey,
    scope: edge.scope,
    status: edge.status,
    weight: edge.weight,
    ...(ontology ? { ontology } : {}),
  };
}

function toGraphEdgeOntology(edge: LibraryEdgeRecord): LibraryGraphEdgeOntology | undefined {
  const metadata = edge.metadata;
  const ontology: LibraryGraphEdgeOntology = {};
  const derivedCategory = ontologyCategoryForEdgeType(edge.edgeType);

  if (typeof metadata.ontologyCategory === "string" && metadata.ontologyCategory.length > 0) {
    ontology.category = metadata.ontologyCategory;
  } else if (derivedCategory) {
    ontology.category = derivedCategory;
  }
  if (typeof metadata.confidence === "number") ontology.confidence = metadata.confidence;
  if (typeof metadata.rationale === "string") ontology.rationale = metadata.rationale;
  if (typeof metadata.source === "string") ontology.source = metadata.source;
  else if (typeof metadata.sourceKind === "string") ontology.source = metadata.sourceKind;
  if (typeof metadata.draftId === "string") ontology.draftId = metadata.draftId;
  if (Array.isArray(metadata.evidenceRefs) && metadata.evidenceRefs.every((ref) => typeof ref === "string")) {
    ontology.evidenceRefs = metadata.evidenceRefs;
  }

  return Object.keys(ontology).length > 0 || derivedCategory ? ontology : undefined;
}

function ontologyCategoryForEdgeType(edgeType: LibraryEdgeType): string | undefined {
  switch (edgeType) {
    case "uses":
      return "usage";
    case "requires":
      return "requirement";
    case "conflicts_with":
      return "conflict";
    case "workflow_precedes":
      return "workflow_order";
    case "similar_to":
      return "similarity";
    default:
      return undefined;
  }
}

function objectBelongsToScope(object: LibraryObjectSummary, scope: string): boolean {
  if (getObjectScope(object) === scope) return true;
  const domainRefs = object.state.domainRefs;
  return Array.isArray(domainRefs) && domainRefs.includes(scope);
}

function getObjectScope(object: LibraryObjectSummary): string {
  return typeof object.state.scope === "string" && object.state.scope.length > 0 ? object.state.scope : "global";
}

function getObjectTitle(object: LibraryObjectSummary): string {
  if (typeof object.state.title === "string" && object.state.title.length > 0) return object.state.title;
  if (typeof object.state.displayName === "string" && object.state.displayName.length > 0) return object.state.displayName;
  return object.objectKey;
}
