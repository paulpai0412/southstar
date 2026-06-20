import type { SouthstarDb } from "../db/postgres.ts";

type ResourceRow = {
  id: string;
  resource_type: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  scope: string;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
  updated_at: Date | string;
};

export type ManagedAgentRunReadModel = {
  runId: string;
  brainBindings: Array<{ id: string; taskId?: string; sessionId?: string; status: string; payload: unknown }>;
  handBindings: Array<{ id: string; taskId?: string; sessionId?: string; status: string; payload: unknown }>;
  checkpoints: Array<{ id: string; taskId?: string; sessionId?: string; status: string; payload: unknown }>;
  toolGrants: Array<{ id: string; sessionId?: string; status: string; payload: unknown }>;
};

export async function getManagedAgentRunReadModelPg(db: SouthstarDb, runId: string): Promise<ManagedAgentRunReadModel> {
  const rows = await db.query<ResourceRow>(
    `select * from southstar.runtime_resources
     where run_id = $1 and resource_type = any($2::text[])
     order by updated_at, resource_type, resource_key`,
    [runId, ["brain_binding", "hand_binding", "session_checkpoint", "vault_lease", "tool_grant"]],
  );
  return {
    runId,
    brainBindings: rows.rows.filter((row) => row.resource_type === "brain_binding").map(mapBinding),
    handBindings: rows.rows.filter((row) => row.resource_type === "hand_binding").map(mapBinding),
    checkpoints: rows.rows.filter((row) => row.resource_type === "session_checkpoint").map(mapBinding),
    toolGrants: rows.rows.filter((row) => row.resource_type === "vault_lease" || row.resource_type === "tool_grant").map(mapGrant),
  };
}

function mapBinding(row: ResourceRow) {
  return {
    id: row.resource_key,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    payload: row.payload_json,
  };
}

function mapGrant(row: ResourceRow) {
  return {
    id: row.resource_key,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    payload: row.payload_json,
  };
}
