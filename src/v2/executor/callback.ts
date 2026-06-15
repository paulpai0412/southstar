import type { SouthstarDb } from "../stores/sqlite.ts";
import { ingestTaskRunResult, type TaskRunCallbackResult } from "./tork-callback.ts";

export type ExecutorCallbackResult = TaskRunCallbackResult & {
  attemptId?: string;
  executorBindingId?: string;
  executorType?: "tork" | "cubesandbox";
};

export function ingestExecutorCallback(db: SouthstarDb, result: ExecutorCallbackResult): void {
  const task = db.prepare("select 1 from workflow_tasks where run_id = ? and id = ?")
    .get(result.runId, result.taskId);
  if (!task) {
    throw new Error(`callback task not found: ${result.runId}/${result.taskId}`);
  }

  if (result.executorBindingId) {
    const binding = db.prepare("select 1 from runtime_resources where resource_type = 'executor_binding' and resource_key = ?")
      .get(result.executorBindingId);
    if (!binding) {
      throw new Error(`executor binding not found: ${result.executorBindingId}`);
    }
  }

  ingestTaskRunResult(db, result);
}
