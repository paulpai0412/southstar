import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildWorkflowCanvasData(db: SouthstarDb, runId: string) {
  const run = getRun(db, runId);
  return {
    runId,
    status: run?.status ?? "unknown",
    nodes: listTasks(db, runId).map((task) => ({
      id: task.id,
      label: task.task_key,
      status: task.status,
      dependsOn: JSON.parse(task.depends_on_json) as string[],
    })),
  };
}

function getRun(db: SouthstarDb, runId: string): { id: string; status: string } | undefined {
  return db.prepare("select id, status from workflow_runs where id = ?").get(runId) as { id: string; status: string } | undefined;
}

function listTasks(db: SouthstarDb, runId: string): WorkflowTaskRow[] {
  return db.prepare("select * from workflow_tasks where run_id = ? order by sort_order").all(runId) as WorkflowTaskRow[];
}

type WorkflowTaskRow = {
  id: string;
  task_key: string;
  status: string;
  depends_on_json: string;
};
