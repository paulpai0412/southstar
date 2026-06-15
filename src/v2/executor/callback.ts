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
    const binding = db.prepare(
      "select run_id, task_id, payload_json from runtime_resources where resource_type = 'executor_binding' and resource_key = ?",
    ).get(result.executorBindingId) as {
      run_id: string | null;
      task_id: string | null;
      payload_json: string;
    } | undefined;
    if (!binding) {
      throw new Error(`executor binding not found: ${result.executorBindingId}`);
    }
    if (binding.run_id !== result.runId || binding.task_id !== result.taskId) {
      throw new Error(`executor binding does not match callback task: ${result.executorBindingId}`);
    }
    if (result.executorType) {
      const payload = JSON.parse(binding.payload_json) as { executorType?: unknown };
      if (payload.executorType !== result.executorType) {
        throw new Error(`executor type mismatch for binding: ${result.executorBindingId}`);
      }
    }
  }

  ingestTaskRunResult(db, result);
}
