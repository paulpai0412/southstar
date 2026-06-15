import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";

export function buildGovernancePageModel(db: SouthstarDb, _input: Record<string, never> = {}) {
  const approvals = listResources(db, { resourceType: "approval" });
  return {
    surface: "southstar.ui.governance.v1" as const,
    mcpConnections: listResources(db, { resourceType: "mcp_connection" }).map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload })),
    toolGrantMatrix: listResources(db, { resourceType: "mcp_grant" }).map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload })),
    secretGroups: listResources(db, { resourceType: "vault_secret_group" }).map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload })),
    approvalQueue: approvals.map((resource) => ({ id: resource.resourceKey, status: resource.status, runId: resource.runId, payload: resource.payload })),
    auditLog: listResources(db, { resourceType: "audit_log" }).map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload, createdAt: resource.createdAt })),
    policySimulations: listResources(db, { resourceType: "approval_policy_simulation" }).map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload })),
    riskPolicy: { mode: "policy", manualRiskTags: ["secret-access", "external-write", "deployment", "delete", "cost-high", "production-change"] },
    policyHistory: listResources(db, { resourceType: "approval_policy_version" }),
  };
}
