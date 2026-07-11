import type { SouthstarDb } from "../db/postgres.ts";
import {
  ACTIVE_RUN_STATUSES,
  NORMAL_EXECUTOR_RESOURCE_STATUSES,
  RECENT_RESOLVED_RUN_STATUSES,
  TERMINAL_RESOURCE_STATUSES,
  TERMINAL_RUN_STATUSES,
  activeRunFromRow,
  buildOperatorAttentionItems,
  commandResultView,
  type AttentionResourceRow,
  type AttentionTaskRow,
  type RuntimeCommandResultView,
  type RuntimeCommandRow,
  type OperatorRunRow,
} from "./operator-attention.ts";
import { buildGoalMissionReadModelPg } from "./workflow-ui.ts";

export async function buildOperatorOverviewReadModelPg(db: SouthstarDb, input: { projectRoot?: string } = {}) {
  const baseRuns = (await db.query<OperatorRunRow>(
    `select id, status, domain, goal_prompt, runtime_context_json, updated_at
       from southstar.workflow_runs
      where (
        status = any($1::text[])
         or (
          status = any($2::text[])
          and exists (
            select 1
              from southstar.runtime_resources attention
             where attention.run_id = southstar.workflow_runs.id
               and attention.resource_type in ('runtime_exception', 'approval', 'recovery_decision', 'executor_binding', 'hand_execution')
               and attention.status <> all($3::text[])
               and (
                 attention.resource_type not in ('executor_binding', 'hand_execution')
                 or attention.status <> all($5::text[])
               )
          )
        )
         or status = any($4::text[])
      )
        and ($6::text is null or coalesce(runtime_context_json->>'projectRoot', runtime_context_json->>'cwd') = $6)
      order by updated_at desc, id
      limit 50`,
    [[...ACTIVE_RUN_STATUSES], [...TERMINAL_RUN_STATUSES], [...TERMINAL_RESOURCE_STATUSES], [...RECENT_RESOLVED_RUN_STATUSES], [...NORMAL_EXECUTOR_RESOURCE_STATUSES], input.projectRoot ?? null],
  )).rows.map(activeRunFromRow);

  const activeRunIds = baseRuns.map((run) => run.runId);
  const [resourceRows, taskRows, commandRows] = await Promise.all([
    input.projectRoot && activeRunIds.length === 0 ? Promise.resolve([]) : readAttentionResourceRows(db, input.projectRoot ? activeRunIds : undefined),
    activeRunIds.length > 0 ? readAttentionTaskRows(db, activeRunIds) : Promise.resolve([]),
    input.projectRoot && activeRunIds.length === 0 ? Promise.resolve([]) : readRuntimeCommandRows(db, input.projectRoot ? activeRunIds : undefined),
  ]);
  const activeRuns = await Promise.all(baseRuns.map(async (run) => {
    const mission = await buildGoalMissionReadModelPg(db, { runId: run.runId });
    const legacyHealth = resourceRows.some((row) => row.run_id === run.runId && (
      row.resource_type === "runtime_exception"
      || ((row.resource_type === "executor_binding" || row.resource_type === "hand_execution")
        && !NORMAL_EXECUTOR_RESOURCE_STATUSES.some((status) => status === row.status))
    )) ? "degraded" as const : "healthy" as const;
    return {
      ...run,
      mission,
      executionStatus: mission?.status.execution ?? run.status,
      outcomeStatus: mission?.status.outcome ?? "in_progress",
      healthStatus: mission?.status.health ?? legacyHealth,
    };
  }));

  const attentionItems = buildOperatorAttentionItems({ resourceRows, taskRows, activeRuns });
  const commandResults = commandRows.map(commandResultView).filter((result): result is RuntimeCommandResultView => result !== null);

  return {
    scope: input.projectRoot
      ? { kind: "project" as const, projectRoot: input.projectRoot }
      : { kind: "all" as const },
    activeRuns,
    runs: activeRuns,
    attentionItems,
    commandResults,
    runtimeHealth: {
      activeRunCount: activeRuns.filter((run) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)).length,
      attentionCount: attentionItems.length,
      blockedCount: attentionItems.filter((item) => item.severity === "blocked").length,
    },
    defaultSelection: attentionItems[0]?.runId
      ? { runId: attentionItems[0].runId, attentionItemId: attentionItems[0].id, interventionMode: attentionItems[0].interventionMode }
      : activeRuns[0]
        ? { runId: activeRuns[0].runId, interventionMode: "run" as const }
        : null,
  };
}

async function readAttentionResourceRows(db: SouthstarDb, runIds?: string[]) {
  return (await db.query<AttentionResourceRow>(
    `select resources.resource_type,
            resources.resource_key,
            resources.run_id,
            resources.task_id,
            tasks.status as task_status,
            runs.status as run_status,
            resources.status,
            resources.title,
            resources.payload_json,
            resources.summary_json,
            resources.updated_at
       from southstar.runtime_resources resources
       left join southstar.workflow_tasks tasks
         on tasks.run_id = resources.run_id
        and tasks.id = resources.task_id
       left join southstar.workflow_runs runs
         on runs.id = resources.run_id
      where resources.resource_type in ('runtime_exception', 'approval', 'recovery_decision', 'executor_binding', 'hand_execution')
        and ($4::text[] is null or resources.run_id = any($4::text[]))
        and resources.status <> all($1::text[])
        and (
          runs.status is null
          or runs.status <> all($2::text[])
          or (runs.status = 'completed' and resources.resource_type = 'approval' and resources.status in ('pending', 'waiting_operator_approval'))
        )
        and (
          resources.resource_type not in ('executor_binding', 'hand_execution')
          or resources.status <> all($3::text[])
        )
      order by resources.updated_at desc, resources.resource_key
      limit 100`,
    [[...TERMINAL_RESOURCE_STATUSES], [...RECENT_RESOLVED_RUN_STATUSES], [...NORMAL_EXECUTOR_RESOURCE_STATUSES], runIds ?? null],
  )).rows;
}

async function readAttentionTaskRows(db: SouthstarDb, activeRunIds: string[]) {
  return (await db.query<AttentionTaskRow>(
    `select id, run_id, task_key, status, depends_on_json, root_session_id, executor_task_id, updated_at
       from southstar.workflow_tasks
      where run_id = any($1::text[])
        and status in ('blocked', 'failed')
      order by updated_at desc, sort_order, id`,
    [activeRunIds],
  )).rows;
}

async function readRuntimeCommandRows(db: SouthstarDb, runIds?: string[]) {
  return (await db.query<RuntimeCommandRow>(
    `select resource_key, run_id, task_id, status, title, payload_json, updated_at
       from southstar.runtime_resources
      where resource_type = 'runtime_command'
        and ($1::text[] is null or run_id = any($1::text[]))
      order by updated_at desc, resource_key
      limit 50`,
    [runIds ?? null],
  )).rows;
}
