import { rmSync } from "node:fs";
import { join } from "node:path";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import { recomputeManagementMetrics, type ManagementMetrics } from "../stores/metrics-store.ts";
import type { TaskRunnerEvent } from "../agent-runner/task-runner.ts";
import { createSqliteSessionGraphProvider } from "../session-graph/sqlite-provider.ts";

export type TaskRunCallbackResult = {
  runId: string;
  taskId: string;
  rootSessionId: string;
  ok: boolean;
  attempts: number;
  artifact: Record<string, unknown>;
  metrics: Partial<ManagementMetrics>;
  events: TaskRunnerEvent[];
  materializationRoot?: string;
};

export function ingestTaskRunResult(db: SouthstarDb, result: TaskRunCallbackResult): void {
  db.exec("begin immediate");
  try {
    for (const event of result.events) {
      appendHistoryEvent(db, {
        runId: result.runId,
        taskId: result.taskId,
        sessionId: event.sessionId ?? result.rootSessionId,
        eventType: event.eventType,
        actorType: event.actorType,
        payload: event.payload,
      });
    }

    const artifactResourceId = `artifact-${result.runId}-${result.taskId}-callback`;
    upsertRuntimeResource(db, {
      id: artifactResourceId,
      resourceType: "artifact",
      resourceKey: artifactResourceId,
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      scope: "task",
      status: result.ok ? "accepted" : "rejected",
      title: result.ok ? "Accepted callback artifact" : "Rejected callback artifact",
      payload: result.artifact,
      metrics: result.metrics,
    });
    appendHistoryEvent(db, {
      runId: result.runId,
      taskId: result.taskId,
      sessionId: result.rootSessionId,
      eventType: "artifact.created",
      actorType: "orchestrator",
      payload: { artifactResourceId, attempts: result.attempts, accepted: result.ok },
    });

    if (result.ok) {
      createSqliteSessionGraphProvider(db).checkpoint({
        sessionId: result.rootSessionId,
        runId: result.runId,
        taskId: result.taskId,
        contextPacketId: `callback-${result.runId}-${result.taskId}`,
        artifactRefs: [artifactResourceId],
        transcriptSummary: "Accepted callback artifact.",
        metrics: numericMetrics(result.metrics),
      });
    }

    updateTaskStatus(db, result.runId, result.taskId, result.ok ? "completed" : "failed");
    recomputeManagementMetrics(db, result.runId);
    if (allTasksTerminal(db, result.runId)) {
      updateRunStatus(db, result.runId, allTasksPassed(db, result.runId) ? "passed" : "failed");
      appendHistoryEvent(db, {
        runId: result.runId,
        eventType: "run.completed",
        actorType: "orchestrator",
        payload: { status: allTasksPassed(db, result.runId) ? "passed" : "failed" },
      });
    }
    db.exec("commit");
    cleanupTaskMaterialization(result);
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function numericMetrics(metrics: Partial<ManagementMetrics>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(metrics).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
}

function cleanupTaskMaterialization(result: TaskRunCallbackResult): void {
  const runRoot = result.materializationRoot ?? "/tmp/southstar-runs";
  rmSync(join(runRoot, result.runId, result.taskId), { recursive: true, force: true });
}

function updateTaskStatus(db: SouthstarDb, runId: string, taskId: string, status: string): void {
  const completedAt = status === "completed" || status === "failed" ? new Date().toISOString() : null;
  db.prepare("update workflow_tasks set status = ?, updated_at = ?, completed_at = ? where run_id = ? and id = ?")
    .run(status, new Date().toISOString(), completedAt, runId, taskId);
}

function updateRunStatus(db: SouthstarDb, runId: string, status: string): void {
  db.prepare("update workflow_runs set status = ?, updated_at = ?, completed_at = ? where id = ?")
    .run(status, new Date().toISOString(), new Date().toISOString(), runId);
}

function allTasksTerminal(db: SouthstarDb, runId: string): boolean {
  const row = db.prepare(`
    select count(*) as count from workflow_tasks
    where run_id = ? and status not in ('completed', 'failed', 'cancelled')
  `).get(runId) as { count: number };
  return row.count === 0;
}

function allTasksPassed(db: SouthstarDb, runId: string): boolean {
  const row = db.prepare(`
    select count(*) as count from workflow_tasks
    where run_id = ? and status != 'completed'
  `).get(runId) as { count: number };
  return row.count === 0;
}
