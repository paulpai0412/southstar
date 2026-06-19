// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import type { SouthstarDb } from "../../stores/sqlite.ts";
import type { RuntimeResourceRecord } from "../../stores/resource-store.ts";
import { listResources } from "../../stores/resource-store.ts";
import type { SouthstarWorkflowManifest } from "../../manifests/types.ts";

export type RunRow = {
  id: string;
  status: string;
  domain: string;
  goal_prompt: string;
  workflow_manifest_json: string;
  execution_projection_json: string;
  metrics_json: string;
  updated_at: string;
  created_at: string;
};

export function getRunRow(db: SouthstarDb, runId: string): RunRow {
  const row = db.prepare("select * from workflow_runs where id = ?").get(runId) as RunRow | undefined;
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  return row;
}

export function latestRunRow(db: SouthstarDb): RunRow | undefined {
  return db.prepare("select * from workflow_runs order by updated_at desc limit 1").get() as RunRow | undefined;
}

export function parseWorkflow(row: RunRow): SouthstarWorkflowManifest {
  return JSON.parse(row.workflow_manifest_json) as SouthstarWorkflowManifest;
}

export function resourcesForRun(db: SouthstarDb, runId: string, resourceType: string): RuntimeResourceRecord[] {
  return listResources(db, { resourceType }).filter((resource) => resource.runId === runId);
}

export function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function summarizePayload(value: unknown, max = 180): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
