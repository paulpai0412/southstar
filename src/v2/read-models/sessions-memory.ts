import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildSessionsMemoryData(db: SouthstarDb, runId: string) {
  return {
    runId,
    sessions: sessionGraphResources(db).filter((resource) => resource.runId === runId),
    memoryItems: listResources(db, { resourceType: "memory_item" }).filter((resource) => resource.runId === runId),
  };
}

export function sessionGraphResources(db: SouthstarDb) {
  return [
    ...listResources(db, { resourceType: "session" }),
    ...listResources(db, { resourceType: "session_node" }),
    ...listResources(db, { resourceType: "session_checkpoint" }),
    ...listResources(db, { resourceType: "recovery_decision" }),
  ];
}
