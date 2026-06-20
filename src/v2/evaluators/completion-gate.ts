import type { SouthstarDb } from "../db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import {
  appendHistoryEventPg,
  updateWorkflowRunStatusPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "lost", "blocked"]);

export type CompletionGateResult = {
  runId: string;
  status: "passed" | "failed" | "not_ready";
  findings: string[];
};

export async function evaluateRunCompletionGatePg(
  db: SouthstarDb,
  input: { runId: string },
): Promise<CompletionGateResult> {
  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ id: string }>(
      "select id from southstar.workflow_runs where id = $1 for update",
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);

    const tasks = (await tx.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order, id for update",
      [input.runId],
    )).rows;

    if (tasks.length === 0) {
      return { runId: input.runId, status: "not_ready", findings: ["run has no tasks"] };
    }

    if (tasks.some((task) => !TERMINAL_TASK_STATUSES.has(task.status))) {
      return { runId: input.runId, status: "not_ready", findings: ["tasks are not terminal"] };
    }

    await updateWorkflowRunStatusPg(tx, input.runId, "evaluating");
    await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      eventType: "run.evaluating_started",
      actorType: "evaluator",
      idempotencyKey: `completion-gate:${input.runId}:evaluating_started`,
      payload: {},
    });

    const acceptedArtifactRefs = new Set((await tx.query<{ task_id: string }>(
      `select distinct task_id
         from southstar.runtime_resources
        where run_id = $1
          and task_id is not null
          and resource_type = $2
          and status = 'accepted'
        order by task_id`,
      [input.runId, ARTIFACT_REF_RESOURCE_TYPE],
    )).rows.map((row) => row.task_id));

    const findings: string[] = [];
    for (const task of tasks) {
      if (task.status === "completed") {
        if (!acceptedArtifactRefs.has(task.id)) findings.push(`missing accepted artifact_ref for task ${task.id}`);
      } else {
        findings.push(`task ${task.id} terminal status is ${task.status}`);
      }
    }

    const blockingViolations = (await tx.query<{ id: string }>(
      `select id
         from southstar.runtime_resources
        where run_id = $1
          and resource_type = 'tool_proxy_violation'
          and status = 'blocking'
        order by created_at, id`,
      [input.runId],
    )).rows;
    for (const violation of blockingViolations) {
      findings.push(`blocking tool proxy violation ${violation.id}`);
    }

    const status = findings.length === 0 ? "passed" : "failed";
    await upsertRuntimeResourcePg(tx, {
      id: `completion-gate:${input.runId}`,
      resourceType: "evaluator_result",
      resourceKey: `completion-gate:${input.runId}`,
      runId: input.runId,
      scope: "evaluator",
      status,
      title: `Completion gate ${input.runId}`,
      payload: { status, findings },
      summary: { findingCount: findings.length },
    });

    await updateWorkflowRunStatusPg(tx, input.runId, status);
    await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      eventType: "run.completed",
      actorType: "evaluator",
      idempotencyKey: `completion-gate:${input.runId}:completed`,
      payload: { status, findings },
    });

    return { runId: input.runId, status, findings };
  });
}

async function appendHistoryEventOncePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId?: string;
    sessionId?: string;
    eventType: string;
    actorType: string;
    idempotencyKey: string;
    payload: unknown;
  },
): Promise<void> {
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, input.idempotencyKey],
  );
  if (existing) return;

  await appendHistoryEventPg(db, input);
}
