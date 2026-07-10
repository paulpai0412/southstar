import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import { listUnresolvedRuntimeExceptionsPg } from "../exceptions/postgres-runtime-exceptions.ts";
import {
  acceptedProducerArtifactRefsPg,
  loadFrozenCoverageContextPg,
  normalizeRequirementEvidenceRef,
  type FrozenCoverageContext,
} from "./requirement-evaluator-results.ts";
import {
  appendHistoryEventOncePg,
  updateWorkflowRunStatusPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "lost", "blocked"]);
const CRITICAL_EXCEPTION_SEVERITIES = new Set(["blocking", "terminal"]);

export type CompletionGateResult = {
  runId: string;
  executionStatus: "completed" | "not_ready";
  outcomeStatus: "in_progress" | "satisfied" | "unsatisfied" | "blocked";
  findings: string[];
};

type ArtifactRow = { task_id: string };
type EvaluatorRow = { task_id: string | null; resource_key: string; status: string; payload_json: unknown };

export async function evaluateRunCompletionGatePg(
  db: SouthstarDb,
  input: { runId: string },
): Promise<CompletionGateResult> {
  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ id: string; status: string; runtime_context_json: unknown }>(
      "select id, status, runtime_context_json from southstar.workflow_runs where id = $1 for update",
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);
    if (run.status === "cancelled") return notReady(input.runId, "run is cancelled");

    const tasks = (await tx.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order, id for update",
      [input.runId],
    )).rows;
    if (tasks.length === 0) return notReady(input.runId, "run has no tasks");
    if (tasks.some((task) => !TERMINAL_TASK_STATUSES.has(task.status))) {
      return notReady(input.runId, "tasks are not terminal");
    }

    const artifacts = (await tx.query<ArtifactRow>(
      `select distinct task_id
         from southstar.runtime_resources
        where run_id = $1 and task_id is not null
          and resource_type = $2 and status = 'accepted'
        order by task_id`,
      [input.runId, ARTIFACT_REF_RESOURCE_TYPE],
    )).rows;
    const acceptedArtifactTaskIds = new Set(artifacts.map((row) => row.task_id));
    const supersededTaskIds = await supersededDynamicRepairTaskIdsPg(tx, input.runId, acceptedArtifactTaskIds);
    const coverageContext = await loadFrozenCoverageContextPg(tx, input.runId);
    const evaluation = coverageContext
      ? await evaluateCoveragePg(tx, input.runId, coverageContext)
      : evaluateLegacyTasks(tasks, acceptedArtifactTaskIds, supersededTaskIds);

    const criticalFindings: string[] = [];
    const blockingViolations = (await tx.query<{ id: string }>(
      `select id from southstar.runtime_resources
        where run_id = $1 and resource_type = 'tool_proxy_violation' and status = 'blocking'
        order by created_at, id`,
      [input.runId],
    )).rows;
    for (const violation of blockingViolations) criticalFindings.push(`blocking tool proxy violation ${violation.id}`);

    const unresolvedExceptions = await listUnresolvedRuntimeExceptionsPg(tx, { runId: input.runId });
    for (const exception of unresolvedExceptions) {
      if (exception.taskId && supersededTaskIds.has(exception.taskId)) continue;
      if (!CRITICAL_EXCEPTION_SEVERITIES.has(exception.payload.severity)) continue;
      criticalFindings.push(`unresolved critical runtime exception ${exception.resourceKey}: ${exception.payload.kind}`);
    }

    const findings = [...evaluation.findings, ...criticalFindings];
    const outcomeStatus = criticalFindings.length > 0
      ? "blocked" as const
      : evaluation.failedRequirementIds.length > 0 || evaluation.findings.length > 0
        ? "unsatisfied" as const
        : "satisfied" as const;
    const outcomePayload = {
      schemaVersion: "southstar.goal_outcome.v1",
      outcomeStatus,
      coveredRequirementIds: evaluation.coveredRequirementIds,
      failedRequirementIds: evaluation.failedRequirementIds,
      findings,
    };
    const fingerprint = shortHash(stableStringify({ tasks, outcomePayload }));

    await updateWorkflowRunStatusPg(tx, input.runId, "evaluating");
    await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      eventType: "run.evaluating_started",
      actorType: "evaluator",
      idempotencyKey: `completion-gate:${input.runId}:evaluating_started:${fingerprint}`,
      payload: {},
    });
    await upsertRuntimeResourcePg(tx, {
      id: `goal-outcome:${input.runId}`,
      resourceType: "goal_outcome",
      resourceKey: `goal-outcome:${input.runId}`,
      runId: input.runId,
      scope: "outcome",
      status: outcomeStatus,
      title: `Goal outcome ${input.runId}`,
      payload: outcomePayload,
      summary: { covered: evaluation.coveredRequirementIds.length, total: evaluation.totalBlockingRequirements },
    });
    await upsertRuntimeResourcePg(tx, {
      id: `completion-gate:${input.runId}`,
      resourceType: "evaluator_result",
      resourceKey: `completion-gate:${input.runId}`,
      runId: input.runId,
      scope: "evaluator",
      status: outcomeStatus,
      title: `Completion gate ${input.runId}`,
      payload: { executionStatus: "completed", outcomeStatus, findings },
      summary: { findingCount: findings.length },
    });
    await updateWorkflowRunStatusPg(tx, input.runId, "completed");
    await appendHistoryEventOncePg(tx, {
      runId: input.runId,
      eventType: "run.completed",
      actorType: "evaluator",
      idempotencyKey: `completion-gate:${input.runId}:completed:${fingerprint}`,
      payload: outcomePayload,
    });
    return { runId: input.runId, executionStatus: "completed", outcomeStatus, findings };
  });
}

async function evaluateCoveragePg(
  db: SouthstarDb,
  runId: string,
  context: FrozenCoverageContext,
): Promise<{ coveredRequirementIds: string[]; failedRequirementIds: string[]; findings: string[]; totalBlockingRequirements: number }> {
  const results = (await db.query<EvaluatorRow>(
    `select task_id, resource_key, status, payload_json
       from southstar.runtime_resources
      where run_id = $1 and resource_type = 'requirement_evaluator_result'
      order by created_at, resource_key`,
    [runId],
  )).rows;
  const coveredRequirementIds: string[] = [];
  const failedRequirementIds: string[] = [];
  const findings: string[] = [];
  const entries = new Map(context.coverage.entries.map((entry) => [entry.requirementId, entry]));
  const blockingRequirements = context.goalContract.requirements.filter((requirement) => requirement.blocking);

  for (const requirement of blockingRequirements) {
    const entry = entries.get(requirement.id);
    if (!entry) {
      failedRequirementIds.push(requirement.id);
      findings.push(`blocking requirement ${requirement.id} is missing frozen coverage`);
      continue;
    }
    const producerTaskIds = new Set(entry.producerTaskIds);
    const acceptedRefs = await acceptedProducerArtifactRefsPg(db, runId, entry, context.manifest);
    const acceptedRefSet = new Set(acceptedRefs);
    const evaluatorTaskIds = new Set(entry.evaluatorTaskIds);
    const evaluatorProfiles = new Set(entry.evaluatorProfileRefs.map((ref) => normalizeRequirementEvidenceRef(ref, "evaluator")));
    const passed = entry.evaluatorTaskIds.every((taskId) => !producerTaskIds.has(taskId))
      && acceptedRefs.length > 0
      && results.some((row) => {
        const payload = asRecord(row.payload_json);
        return row.status === "passed"
          && row.task_id !== null
          && evaluatorTaskIds.has(row.task_id)
          && payload.schemaVersion === "southstar.requirement_evaluator_result.v1"
          && payload.verdict === "passed"
          && payload.evaluatorTaskId === row.task_id
          && stringArray(payload.requirementIds).includes(requirement.id)
          && evaluatorProfiles.has(normalizeRequirementEvidenceRef(stringValue(payload.evaluatorProfileRef) ?? "", "evaluator"))
          && stringArray(payload.artifactRefs).some((ref) => acceptedRefSet.has(ref));
      });
    if (passed) coveredRequirementIds.push(requirement.id);
    else {
      failedRequirementIds.push(requirement.id);
      findings.push(`blocking requirement ${requirement.id} lacks accepted producer artifact and independent passed evaluator evidence`);
    }
  }
  return {
    coveredRequirementIds: coveredRequirementIds.sort(),
    failedRequirementIds: failedRequirementIds.sort(),
    findings,
    totalBlockingRequirements: blockingRequirements.length,
  };
}

function evaluateLegacyTasks(
  tasks: Array<{ id: string; status: string }>,
  acceptedArtifactTaskIds: Set<string>,
  supersededTaskIds: Set<string>,
): { coveredRequirementIds: string[]; failedRequirementIds: string[]; findings: string[]; totalBlockingRequirements: number } {
  const findings: string[] = [];
  for (const task of tasks) {
    if (supersededTaskIds.has(task.id)) continue;
    if (task.status === "completed") {
      if (!acceptedArtifactTaskIds.has(task.id)) findings.push(`missing accepted artifact_ref for task ${task.id}`);
    } else findings.push(`task ${task.id} terminal status is ${task.status}`);
  }
  return { coveredRequirementIds: [], failedRequirementIds: [], findings, totalBlockingRequirements: 0 };
}

function notReady(runId: string, finding: string): CompletionGateResult {
  return { runId, executionStatus: "not_ready", outcomeStatus: "in_progress", findings: [finding] };
}

async function supersededDynamicRepairTaskIdsPg(db: SouthstarDb, runId: string, acceptedArtifactRefs: Set<string>): Promise<Set<string>> {
  const rows = (await db.query<{ payload_json: unknown }>(
    `select payload_json from southstar.runtime_resources
      where run_id = $1 and resource_type = 'workflow_dynamic_repair_revision' and status = 'applied'
      order by created_at, resource_key`,
    [runId],
  )).rows;
  const superseded = new Set<string>();
  for (const row of rows) {
    const payload = asRecord(row.payload_json);
    const rootFailedTaskId = stringValue(payload.rootFailedTaskId) ?? stringValue(payload.originalFailedTaskId);
    const reconnectTargetTaskId = lastStringValue(payload.newTaskIds);
    if (rootFailedTaskId && reconnectTargetTaskId && acceptedArtifactRefs.has(reconnectTargetTaskId)) superseded.add(rootFailedTaskId);
  }
  return superseded;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function lastStringValue(value: unknown): string | undefined {
  return Array.isArray(value) ? stringValue(value.at(-1)) : undefined;
}
