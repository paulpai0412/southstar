import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildVaultMcpData(db: SouthstarDb, runId: string) {
  return {
    runId,
    vaultLeases: listResources(db, { resourceType: "vault_lease" }).filter((resource) => resource.runId === runId),
    mcpGrants: listResources(db, { resourceType: "mcp_grant" }).filter((resource) => resource.runId === runId),
  };
}
