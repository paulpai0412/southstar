import type { SouthstarDb } from "../db/postgres.ts";
import { listLibraryObjects } from "../design-library/library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryObjectSummary } from "../design-library/types.ts";

export type LibraryWorkspaceObject = {
  id: string;
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryObjectSummary["status"];
  title: string;
  scope: string;
};

export type LibraryWorkspaceObjectGroup = {
  objectKind: LibraryDefinitionKind;
  objects: LibraryWorkspaceObject[];
};

export type LibraryWorkspaceDomain = {
  scope: string;
  objectCount: number;
  objectKindCounts: Partial<Record<LibraryDefinitionKind, number>>;
  objectGroups: LibraryWorkspaceObjectGroup[];
};

export type LibraryWorkspaceReadModel = {
  selectedScope: string;
  domains: LibraryWorkspaceDomain[];
};

export async function buildLibraryWorkspaceReadModel(
  db: SouthstarDb,
  input: { selectedScope?: string } = {},
): Promise<LibraryWorkspaceReadModel> {
  const objects = await listLibraryObjects(db, input.selectedScope && input.selectedScope !== "all" ? { scope: input.selectedScope } : {});
  const domains = new Map<string, LibraryWorkspaceObject[]>();

  for (const object of objects) {
    const scope = getObjectScope(object);
    const domainObjects = domains.get(scope) ?? [];
    domainObjects.push(toWorkspaceObject(object, scope));
    domains.set(scope, domainObjects);
  }

  return {
    selectedScope: input.selectedScope ?? "all",
    domains: Array.from(domains.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([scope, domainObjects]) => {
        const objectKindCounts: Partial<Record<LibraryDefinitionKind, number>> = {};
        const groups = new Map<LibraryDefinitionKind, LibraryWorkspaceObject[]>();
        for (const object of domainObjects) {
          objectKindCounts[object.objectKind] = (objectKindCounts[object.objectKind] ?? 0) + 1;
          const groupObjects = groups.get(object.objectKind) ?? [];
          groupObjects.push(object);
          groups.set(object.objectKind, groupObjects);
        }
        return {
          scope,
          objectCount: domainObjects.length,
          objectKindCounts,
          objectGroups: Array.from(groups.entries()).map(([objectKind, groupObjects]) => ({
            objectKind,
            objects: groupObjects,
          })),
        };
      }),
  };
}

function toWorkspaceObject(object: LibraryObjectSummary, scope: string): LibraryWorkspaceObject {
  return {
    id: object.id,
    objectKey: object.objectKey,
    objectKind: object.objectKind,
    status: object.status,
    title: getObjectTitle(object),
    scope,
  };
}

function getObjectScope(object: LibraryObjectSummary): string {
  return typeof object.state.scope === "string" && object.state.scope.length > 0 ? object.state.scope : "global";
}

function getObjectTitle(object: LibraryObjectSummary): string {
  if (typeof object.state.title === "string" && object.state.title.length > 0) return object.state.title;
  if (typeof object.state.displayName === "string" && object.state.displayName.length > 0) return object.state.displayName;
  return object.objectKey;
}
