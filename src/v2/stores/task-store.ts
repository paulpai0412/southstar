import type { SouthstarDb } from "./sqlite.ts";

export type WorkflowTaskInput = {
  id: string;
  runId: string;
  taskKey: string;
  status: string;
  sortOrder: number;
  dependsOn: string[];
  rootSessionId?: string;
  subagentSessionIds?: string[];
  executorTaskId?: string;
  snapshot?: unknown;
  metrics?: unknown;
};

export function createWorkflowTask(db: SouthstarDb, input: WorkflowTaskInput): void {
  const now = new Date().toISOString();
  db.prepare(`
    insert into workflow_tasks (
      id, run_id, task_key, status, sort_order, depends_on_json, root_session_id,
      subagent_session_ids_json, executor_task_id, snapshot_json, metrics_json,
      created_at, updated_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.runId,
    input.taskKey,
    input.status,
    input.sortOrder,
    JSON.stringify(input.dependsOn),
    input.rootSessionId ?? null,
    JSON.stringify(input.subagentSessionIds ?? []),
    input.executorTaskId ?? null,
    JSON.stringify(input.snapshot ?? {}),
    JSON.stringify(input.metrics ?? {}),
    now,
    now,
    null,
  );
}
