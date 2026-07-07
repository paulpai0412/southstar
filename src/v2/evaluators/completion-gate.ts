import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import { listUnresolvedRuntimeExceptionsPg } from "../exceptions/postgres-runtime-exceptions.ts";
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
    const run = await tx.maybeOne<{ id: string; status: string }>(
      "select id, status from southstar.workflow_runs where id = $1 for update",
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);
    if (run.status === "cancelled") {
      return { runId: input.runId, status: "not_ready", findings: ["run is cancelled"] };
    }

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

    const acceptedArtifactRefRows = (await tx.query<{ task_id: string; resource_key: string }>(
      `select distinct task_id
            , resource_key
         from southstar.runtime_resources
        where run_id = $1
          and task_id is not null
          and resource_type = $2
          and status = 'accepted'
        order by task_id, resource_key`,
      [input.runId, ARTIFACT_REF_RESOURCE_TYPE],
    )).rows;
    const acceptedArtifactRefs = new Set(acceptedArtifactRefRows.map((row) => row.task_id));
    const supersededTaskIds = await supersededDynamicRepairTaskIdsPg(tx, input.runId, acceptedArtifactRefs);

    const findings: string[] = [];
    for (const task of tasks) {
      if (supersededTaskIds.has(task.id)) continue;
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

    const unresolvedRuntimeExceptions = await listUnresolvedRuntimeExceptionsPg(tx, { runId: input.runId });
    for (const exception of unresolvedRuntimeExceptions) {
      if (exception.taskId && supersededTaskIds.has(exception.taskId)) continue;
      findings.push(`unresolved runtime exception ${exception.resourceKey}: ${exception.payload.kind}`);
    }

    const unappliedRecoveryDecisions = (await tx.query<{
      resource_key: string;
      status: string;
      payload_json: unknown;
    }>(
      `select resource_key, status, payload_json
         from southstar.runtime_resources
        where run_id = $1
          and resource_type = 'recovery_decision'
          and payload_json->>'schemaVersion' = 'southstar.runtime.recovery_decision.v1'
          and status in ('recorded', 'waiting_operator_approval', 'approved', 'applying', 'failed', 'blocked')
        order by created_at, resource_key`,
      [input.runId],
    )).rows;
    for (const decision of unappliedRecoveryDecisions) {
      const payload = asRecord(decision.payload_json);
      const path = payload ? stringValue(payload.path) : undefined;
      findings.push(`unapplied recovery decision ${decision.resource_key}: ${path ?? decision.status}`);
    }

    const startedRecoveryExecutions = (await tx.query<{ resource_key: string }>(
      `select resource_key
         from southstar.runtime_resources
        where run_id = $1
          and resource_type = 'recovery_execution'
          and status = 'started'
        order by created_at, resource_key`,
      [input.runId],
    )).rows;
    for (const execution of startedRecoveryExecutions) {
      findings.push(`started recovery execution ${execution.resource_key}`);
    }

    const status = findings.length === 0 ? "passed" : "failed";
    const evaluationFingerprint = shortHash(stableStringify({
      tasks,
      acceptedArtifactRefs: acceptedArtifactRefRows,
      supersededTaskIds: Array.from(supersededTaskIds).sort(),
      blockingViolations,
      unresolvedRuntimeExceptions,
      unappliedRecoveryDecisions,
      startedRecoveryExecutions,
      status,
      findings,
    }));

    await updateWorkflowRunStatusPg(tx, input.runId, "evaluating");
    await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      eventType: "run.evaluating_started",
      actorType: "evaluator",
      idempotencyKey: `completion-gate:${input.runId}:evaluating_started:${evaluationFingerprint}`,
      payload: {},
    });

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
      idempotencyKey: `completion-gate:${input.runId}:completed:${evaluationFingerprint}`,
      payload: { status, findings },
    });

    return { runId: input.runId, status, findings };
  });
}

async function supersededDynamicRepairTaskIdsPg(
  db: SouthstarDb,
  runId: string,
  acceptedArtifactRefs: Set<string>,
): Promise<Set<string>> {
  const rows = (await db.query<{ payload_json: unknown }>(
    `select payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'workflow_dynamic_repair_revision'
        and status = 'applied'
      order by created_at, resource_key`,
    [runId],
  )).rows;
  const superseded = new Set<string>();
  for (const row of rows) {
    const payload = asRecord(row.payload_json);
    const rootFailedTaskId = stringValue(payload?.rootFailedTaskId) ?? stringValue(payload?.originalFailedTaskId);
    const reconnectTargetTaskId = lastStringValue(payload?.newTaskIds);
    if (rootFailedTaskId && reconnectTargetTaskId && acceptedArtifactRefs.has(reconnectTargetTaskId)) {
      superseded.add(rootFailedTaskId);
    }
  }
  return superseded;
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

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function lastStringValue(value: unknown): string | undefined {
  return Array.isArray(value) ? stringValue(value.at(-1)) : undefined;
}
