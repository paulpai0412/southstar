import type { SouthstarDb } from "./postgres.ts";
import { appendHistoryEventOncePg } from "../stores/postgres-runtime-store.ts";

const LEGACY_GOAL_CONTRACT_SCHEMA = "southstar.goal_contract.v1";
const ACTIVE_TASK_STATUSES = ["pending", "claimed", "queued", "running"] as const;
const TERMINAL_RUN_STATUSES = new Set(["completed", "passed", "failed", "cancelled", "blocked", "lost"]);

export type LegacyContractInspection = {
  inspectedAt: string;
  workspace: {
    runIds: string[];
    activeRunIds: string[];
    taskCount: number;
    activeTaskCount: number;
  };
  goalContractConfirmations: {
    resourceIds: string[];
    runIds: string[];
  };
};

export type LegacyContractMigrationResult = {
  migration: "legacy-contracts";
  migratedAt: string;
  before: LegacyContractInspection;
  archivedGoalContractConfirmations: number;
  archivedWorkspaceRuns: number;
  blockedWorkspaceRuns: number;
  blockedWorkspaceTasks: number;
  after: LegacyContractInspection;
};

type LegacyWorkspaceRunRow = {
  run_id: string;
  run_status: string;
  task_ids: string[] | null;
  active_task_ids: string[] | null;
};

type LegacyGoalContractRow = {
  id: string;
  run_id: string | null;
  status: string;
  payload_json: unknown;
};

/** List only legacy state that has not already been archived or blocked. */
export async function inspectLegacyContractsPg(db: SouthstarDb): Promise<LegacyContractInspection> {
  const workspace = await listLegacyWorkspaceRuns(db);
  const goalContracts = await listLegacyGoalContractConfirmations(db);
  return {
    inspectedAt: new Date().toISOString(),
    workspace: {
      runIds: workspace.map((row) => row.run_id),
      activeRunIds: workspace.filter((row) => row.active_task_ids?.length).map((row) => row.run_id),
      taskCount: workspace.reduce((total, row) => total + (row.task_ids?.length ?? 0), 0),
      activeTaskCount: workspace.reduce((total, row) => total + (row.active_task_ids?.length ?? 0), 0),
    },
    goalContractConfirmations: {
      resourceIds: goalContracts.map((row) => row.id),
      runIds: goalContracts.flatMap((row) => row.run_id ? [row.run_id] : []),
    },
  };
}

/**
 * Archive old contract resources and make every legacy workspace task
 * explicitly non-runnable. The operation is idempotent and never invents a
 * workspace mutation policy for historical data.
 */
export async function migrateLegacyContractsPg(db: SouthstarDb): Promise<LegacyContractMigrationResult> {
  return await db.tx(async (tx) => {
    const before = await inspectLegacyContractsPg(tx);
    const migratedAt = new Date().toISOString();
    const workspaceRuns = await listLegacyWorkspaceRuns(tx);
    const goalContracts = await listLegacyGoalContractConfirmations(tx);

    for (const resource of goalContracts) {
      const payload = record(resource.payload_json);
      await tx.query(
        `update southstar.runtime_resources
            set status = 'archived',
                payload_json = $1::jsonb,
                updated_at = now()
          where id = $2 and status <> 'archived'`,
        [JSON.stringify({
          ...payload,
          legacyContractMigration: {
            status: "archived",
            schemaVersion: LEGACY_GOAL_CONTRACT_SCHEMA,
            archivedAt: migratedAt,
            reason: "historical Goal Contract schema is not accepted by the current runtime",
          },
        }), resource.id],
      );
    }

    let archivedWorkspaceRuns = 0;
    let blockedWorkspaceRuns = 0;
    let blockedWorkspaceTasks = 0;
    for (const run of workspaceRuns) {
      const runStatus = TERMINAL_RUN_STATUSES.has(run.run_status) ? "archived" : "blocked";
      const runRow = await tx.one<{ runtime_context_json: unknown }>(
        "select runtime_context_json from southstar.workflow_runs where id = $1 for update",
        [run.run_id],
      );
      await tx.query(
        `update southstar.workflow_runs
            set runtime_context_json = $1::jsonb,
                status = case when $2 = 'blocked' then 'blocked' else status end,
                updated_at = now()
          where id = $3`,
        [JSON.stringify({
          ...record(runRow.runtime_context_json),
          legacyContractMigration: {
            status: runStatus,
            migratedAt,
            reason: "historical workflow tasks lack workspaceMutation metadata",
            taskIds: run.task_ids ?? [],
          },
        }), runStatus, run.run_id],
      );
      if (runStatus === "archived") archivedWorkspaceRuns += 1;
      else blockedWorkspaceRuns += 1;

      const changedTasks = await tx.query<{ id: string }>(
        `update southstar.workflow_tasks
            set status = 'blocked',
                completed_at = coalesce(completed_at, now()),
                updated_at = now()
          where run_id = $1
            and id = any($2::text[])
            and status = any($3::text[])
        returning id`,
        [run.run_id, run.task_ids ?? [], ACTIVE_TASK_STATUSES],
      );
      blockedWorkspaceTasks += changedTasks.rows.length;
      for (const task of changedTasks.rows) {
        await appendHistoryEventOncePg(tx, {
          runId: run.run_id,
          taskId: task.id,
          eventType: "task.contract_blocked",
          actorType: "migration",
          idempotencyKey: `legacy-contract-migration:${run.run_id}:${task.id}`,
          payload: {
            contract: "workspaceMutation",
            reason: "historical task lacks workspaceMutation metadata",
            migration: "legacy-contract-migration",
          },
        });
      }
      await appendHistoryEventOncePg(tx, {
        runId: run.run_id,
        eventType: runStatus === "blocked" ? "run.legacy_contract_blocked" : "run.legacy_contract_archived",
        actorType: "migration",
        idempotencyKey: `legacy-contract-migration:${run.run_id}`,
        payload: {
          contract: "workspaceMutation",
          status: runStatus,
          taskIds: run.task_ids ?? [],
          migration: "legacy-contract-migration",
        },
      });
    }

    return {
      migration: "legacy-contracts",
      migratedAt,
      before,
      archivedGoalContractConfirmations: goalContracts.length,
      archivedWorkspaceRuns,
      blockedWorkspaceRuns,
      blockedWorkspaceTasks,
      after: await inspectLegacyContractsPg(tx),
    };
  });
}

async function listLegacyWorkspaceRuns(db: SouthstarDb): Promise<LegacyWorkspaceRunRow[]> {
  const result = await db.query<LegacyWorkspaceRunRow>(
    `select wr.id as run_id,
            wr.status as run_status,
            array_agg(task->>'id' order by task->>'id')
              filter (where not (task ? 'workspaceMutation')) as task_ids,
            array_agg(task->>'id' order by task->>'id')
              filter (where not (task ? 'workspaceMutation') and wt.status = any($1::text[])) as active_task_ids
       from southstar.workflow_runs wr
       cross join lateral jsonb_array_elements(coalesce(wr.workflow_manifest_json->'tasks', '[]'::jsonb)) task
       left join southstar.workflow_tasks wt
         on wt.run_id = wr.id and wt.id = task->>'id'
      where coalesce(wr.runtime_context_json->'legacyContractMigration'->>'status', '') not in ('archived', 'blocked')
      group by wr.id, wr.status
     having count(*) filter (where not (task ? 'workspaceMutation')) > 0
      order by wr.id`,
    [ACTIVE_TASK_STATUSES],
  );
  return result.rows;
}

async function listLegacyGoalContractConfirmations(db: SouthstarDb): Promise<LegacyGoalContractRow[]> {
  const result = await db.query<LegacyGoalContractRow>(
    `select id, run_id, status, payload_json
       from southstar.runtime_resources
      where resource_type = 'goal_contract_confirmation'
        and status <> 'archived'
        and payload_json->'goalContract'->>'schemaVersion' = $1
      order by id`,
    [LEGACY_GOAL_CONTRACT_SCHEMA],
  );
  return result.rows;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
