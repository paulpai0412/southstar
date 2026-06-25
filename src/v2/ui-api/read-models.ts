// Deprecated compatibility shim. New code should import from src/v2/read-models/*.
import type { SouthstarDb } from "../db/postgres.ts";
import { buildPostgresCoreReadModel } from "../read-models/postgres-core.ts";

export async function buildWorkflowCanvasModel(db: SouthstarDb, runId: string) {
  return (await buildPostgresCoreReadModel(db, { kind: "workflow-canvas", runId })).data;
}

export async function buildRuntimeMonitorModel(db: SouthstarDb, runId: string) {
  return (await buildPostgresCoreReadModel(db, { kind: "runtime-monitor", runId })).data;
}

export async function buildTaskDetailModel(db: SouthstarDb, runId: string, taskId: string) {
  return (await buildPostgresCoreReadModel(db, { kind: "task-detail", runId, taskId })).data;
}

export async function buildSessionsMemoryModel(db: SouthstarDb, runId: string) {
  return (await buildPostgresCoreReadModel(db, { kind: "sessions-memory", runId })).data;
}

export async function sessionGraphResources(db: SouthstarDb, runId: string) {
  return (await buildSessionsMemoryModel(db, runId)).sessions;
}

export async function buildVaultMcpModel(db: SouthstarDb, runId: string) {
  return (await buildPostgresCoreReadModel(db, { kind: "vault-mcp", runId })).data;
}

export async function buildExecutorOpsModel(db: SouthstarDb, runId: string) {
  return (await buildPostgresCoreReadModel(db, { kind: "executor-ops", runId })).data;
}
