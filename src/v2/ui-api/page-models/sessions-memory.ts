import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";
import type { UiIntegrationHealth } from "./types.ts";

export function buildSessionsMemoryPageModel(db: SouthstarDb, input: { runId?: string; sessionId?: string } = {}) {
  const sessionTypes = new Set(["session", "session_node", "session_checkpoint", "session_fork", "session_reset", "session_rollback", "recovery_decision", "session_operation"]);
  const all = db.prepare("select * from runtime_resources order by created_at").all() as Array<{
    id: string; resource_type: string; resource_key: string; run_id: string | null; task_id: string | null; session_id: string | null; status: string; title: string | null; payload_json: string; created_at: string;
  }>;
  const scoped = all.filter((row) => (!input.runId || row.run_id === input.runId) && sessionTypes.has(row.resource_type));
  const memoryRows = listResources(db, { resourceType: "memory_item" }).filter((resource) => !input.runId || resource.runId === input.runId || !resource.runId);
  const memoryDecisions = listResources(db, { resourceType: "memory_decision" }).filter((resource) => !input.runId || resource.runId === input.runId || !resource.runId);
  const traces = listResources(db, { resourceType: "memory_injection_trace" }).filter((resource) => !input.runId || resource.runId === input.runId);
  const recoveryResources = scoped.filter((row) => row.resource_type === "recovery_decision");
  const estimatedSavingsTotal = recoveryResources.reduce((sum, row) => {
    const payload = JSON.parse(row.payload_json) as { tokenTelemetry?: { estimatedSavings?: number } };
    return sum + (typeof payload.tokenTelemetry?.estimatedSavings === "number" ? payload.tokenTelemetry.estimatedSavings : 0);
  }, 0);
  const totalMemoryTokens = memoryRows.reduce((sum, resource) => {
    const payload = resource.payload as { tokenEstimate?: number };
    return sum + (typeof payload.tokenEstimate === "number" ? payload.tokenEstimate : 0);
  }, 0);
  return {
    surface: "southstar.ui.sessions-memory.v1" as const,
    runId: input.runId ?? null,
    selectedSessionId: input.sessionId ?? null,
    lineage: scoped.map((row) => ({ id: row.id, type: row.resource_type, sessionId: row.session_id ?? row.resource_key, status: row.status, title: row.title, createdAt: row.created_at, payload: JSON.parse(row.payload_json) })),
    checkpoints: scoped.filter((row) => row.resource_type === "session_checkpoint").map((row) => ({ id: row.id, sessionId: row.session_id, taskId: row.task_id, status: row.status })),
    memoryRows: memoryRows.map((resource) => ({ id: resource.resourceKey, title: resource.title, status: resource.status, scope: resource.scope, payload: resource.payload })),
    memoryDecisions: memoryDecisions.map((resource) => ({ id: resource.id, memoryId: resource.resourceKey, status: resource.status, payload: resource.payload })),
    memoryTraces: traces.map((resource) => ({ id: resource.id, taskId: resource.taskId, payload: resource.payload })),
    tokenEfficiency: { totalMemories: memoryRows.length, totalMemoryTokens, traceCount: traces.length },
    recoveryTelemetry: { estimatedSavingsTotal, recoveryDecisionCount: recoveryResources.length },
    providerBinding: { provider: "sqlite", status: "healthy" },
    integrationHealth: [{ service: "SQLite Memory Provider", status: "healthy", binding: "api-bound", notes: `${memoryRows.length} memory row(s)` }] satisfies UiIntegrationHealth[],
  };
}
