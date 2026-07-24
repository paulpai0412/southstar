import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg } from "../stores/postgres-runtime-store.ts";

export type StartRunSchedulingResult = {
  runId: string;
  status: "scheduling";
  schedulerWakeRequested: true;
};

const schedulableRunStatuses = new Set(["created", "scheduling"]);
const terminalRunStatuses = new Set(["completed", "failed"]);

export async function startRunSchedulingPg(db: SouthstarDb, input: { runId: string }): Promise<StartRunSchedulingResult> {
  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_runs where id = $1 for update",
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);
    const terminalRecoveryTask = terminalRunStatuses.has(run.status)
      ? await tx.maybeOne<{ id: string }>(
        "select id from southstar.workflow_tasks where run_id = $1 and status = 'pending' limit 1",
        [input.runId],
      )
      : undefined;
    const reopeningTerminalRun = Boolean(terminalRecoveryTask);
    if (!schedulableRunStatuses.has(run.status) && !reopeningTerminalRun) {
      throw new Error(`run cannot start scheduling from status ${run.status}`);
    }

    await tx.query(
      `update southstar.workflow_runs
          set status = 'scheduling',
              updated_at = now(),
              completed_at = case when $2 then null else completed_at end
        where id = $1`,
      [input.runId, reopeningTerminalRun],
    );
    await appendSchedulingStartedEvent(tx, input.runId, run.status, reopeningTerminalRun);

    return {
      runId: input.runId,
      status: "scheduling",
      schedulerWakeRequested: true,
    };
  });
}

async function appendSchedulingStartedEvent(
  db: SouthstarDb,
  runId: string,
  previousStatus: string,
  reopeningTerminalRun = false,
): Promise<void> {
  const idempotencyKey = reopeningTerminalRun
    ? `run:${runId}:recovery-scheduling-started:${previousStatus}`
    : `run:${runId}:scheduling-started`;
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [runId, idempotencyKey],
  );
  if (existing) return;

  await appendHistoryEventPg(db, {
    runId,
    eventType: "run.scheduling_started",
    actorType: "orchestrator",
    idempotencyKey,
    payload: { previousStatus },
  });
}
