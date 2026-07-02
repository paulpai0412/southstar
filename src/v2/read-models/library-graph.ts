import type { SouthstarDb } from "../db/postgres.ts";
import { listLibraryEdges, listLibraryObjects } from "../design-library/library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryEdgeRecord, LibraryEdgeType, LibraryObjectSummary } from "../design-library/types.ts";

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
  weight: number;
};

export type LibraryGraphReadModel = {
  activeScope: string;
  availableScopes: string[];
  nodes: LibraryGraphNode[];
  edges: LibraryGraphEdge[];
};

export async function buildLibraryGraphReadModel(
  db: SouthstarDb,
  input: { scope?: string; objectKey?: string; depth?: number } = {},
): Promise<LibraryGraphReadModel> {
  const activeScope = input.scope && input.scope !== "all" ? input.scope : "all";
  const allObjects = await listLibraryObjects(db);
  const scopedObjects = activeScope === "all" ? allObjects : await listLibraryObjects(db, { scope: activeScope });
  const scopedEdges = activeScope === "all" ? await listLibraryEdges(db) : await listLibraryEdges(db, { scope: activeScope });
  const objectByKey = new Map(scopedObjects.map((object) => [object.objectKey, object]));
  const candidateEdges = scopedEdges.filter((edge) => objectByKey.has(edge.fromObjectKey) && objectByKey.has(edge.toObjectKey));
  const visibleKeys = input.objectKey
    ? buildNeighborhoodKeys(input.objectKey, objectByKey, candidateEdges, input.depth ?? 1)
    : buildScopeVisibleKeys(activeScope, scopedObjects, candidateEdges);

  const visibleEdges = candidateEdges.filter((edge) => visibleKeys.has(edge.fromObjectKey) && visibleKeys.has(edge.toObjectKey));
  const nodes = scopedObjects.filter((object) => visibleKeys.has(object.objectKey)).map(toGraphNode);

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

function toGraphEdge(edge: LibraryEdgeRecord): LibraryGraphEdge {
  return {
    id: edge.id,
    fromObjectKey: edge.fromObjectKey,
    edgeType: edge.edgeType,
    toObjectKey: edge.toObjectKey,
    scope: edge.scope,
    weight: edge.weight,
  };
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
