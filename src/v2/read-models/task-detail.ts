import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildTaskDetailData(db: SouthstarDb, runId: string, taskId: string) {
  const task = db.prepare("select * from workflow_tasks where run_id = ? and id = ?").get(runId, taskId) as WorkflowTaskRow | undefined;
  if (!task) return null;
  const latestBinding = listResources(db, { resourceType: "executor_binding" })
    .filter((resource) => resource.runId === runId && resource.taskId === taskId)
    .at(-1);
  return {
    id: task.id,
    runId: task.run_id,
    taskKey: task.task_key,
    status: task.status,
    dependsOn: JSON.parse(task.depends_on_json) as string[],
    rootSessionId: task.root_session_id,
    subagentSessionIds: JSON.parse(task.subagent_session_ids_json) as string[],
    executorTaskId: task.executor_task_id,
    snapshot: JSON.parse(task.snapshot_json) as unknown,
    metrics: JSON.parse(task.metrics_json) as unknown,
    executorObservation: latestBinding ? {
      bindingId: latestBinding.id,
      status: latestBinding.status,
      payload: latestBinding.payload,
    } : null,
  };
}

type WorkflowTaskRow = {
  id: string;
  run_id: string;
  task_key: string;
  status: string;
  depends_on_json: string;
  root_session_id: string | null;
  subagent_session_ids_json: string;
  executor_task_id: string | null;
  snapshot_json: string;
  metrics_json: string;
};
