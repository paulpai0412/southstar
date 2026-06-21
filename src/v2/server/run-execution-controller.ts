import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg } from "../stores/postgres-runtime-store.ts";

export type StartRunSchedulingResult = {
  runId: string;
  status: "scheduling";
  schedulerWakeRequested: true;
};

const schedulableRunStatuses = new Set(["created", "scheduling"]);

export async function startRunSchedulingPg(db: SouthstarDb, input: { runId: string }): Promise<StartRunSchedulingResult> {
  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string }>(
      "select status from southstar.workflow_runs where id = $1 for update",
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);
    if (!schedulableRunStatuses.has(run.status)) {
      throw new Error(`run cannot start scheduling from status ${run.status}`);
    }

    await tx.query("update southstar.workflow_runs set status = 'scheduling', updated_at = now() where id = $1", [input.runId]);
    await appendSchedulingStartedEvent(tx, input.runId, run.status);

    return {
      runId: input.runId,
      status: "scheduling",
      schedulerWakeRequested: true,
    };
  });
}

async function appendSchedulingStartedEvent(db: SouthstarDb, runId: string, previousStatus: string): Promise<void> {
  const idempotencyKey = `run:${runId}:scheduling-started`;
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
