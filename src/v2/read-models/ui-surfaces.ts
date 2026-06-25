import { acceptedArtifactTaskIdsForRunPg } from "../artifacts/artifact-ref-store.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { ReadModelInput } from "./types.ts";
import { createUiReadModelEnvelope, uiCommand, type UiAttentionItem } from "./ui-envelope.ts";

type WorkflowDagTaskRow = {
  id: string;
  task_key: string;
  status: string;
  sort_order: number;
  depends_on_json: unknown;
};

type ResourceRow = {
  resource_key: string;
  task_id: string | null;
  session_id: string | null;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
};

export async function buildUiSurfaceReadModel(db: SouthstarDb, input: ReadModelInput) {
  switch (input.kind) {
    case "run-control":
      return await buildRunControlReadModel(db, input.runId);
    case "workflow-dag":
      return await buildWorkflowDagReadModel(db, input.runId);
    case "recovery-center":
      return await buildRecoveryCenterReadModel(db, input.runId);
    case "execution-center":
      return await buildExecutionCenterReadModel(db, input.runId);
    default:
      throw new Error(`unsupported UI surface read model: ${input.kind}`);
  }
}

export function isUiSurfaceReadModelKind(kind: string): boolean {
  return kind === "run-control" || kind === "workflow-dag" || kind === "recovery-center" || kind === "execution-center";
}

async function buildRunControlReadModel(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ id: string; status: string; domain: string | null; goal_prompt: string }>(
    "select id, status, domain, goal_prompt from southstar.workflow_runs where id = $1",
    [runId],
  );
  if (!run) throw new Error(`run not found: ${runId}`);

  const counts = await db.query<{ status: string; count: string | number }>(
    `select status, count(*) as count
       from southstar.workflow_tasks
      where run_id = $1
      group by status
      order by status`,
    [runId],
  );
  const unresolvedExceptions = (await db.query<{ resource_key: string; payload_json: unknown }>(
    `select resource_key, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'runtime_exception'
        and status <> 'resolved'
      order by created_at, resource_key`,
    [runId],
  )).rows;
  const taskCounts = Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)]));

  const attentionItems: UiAttentionItem[] = unresolvedExceptions.map((exception) => ({
    id: `exception:${exception.resource_key}`,
    severity: "blocked",
    title: "Unresolved runtime exception",
    reason: `${stringValue(asRecord(exception.payload_json).kind) ?? "runtime_exception"} is unresolved`,
    sourceRefs: [`runtime-resource:${exception.resource_key}`],
    suggestedCommandIds: ["open-recovery-center"],
  }));

  const runCanExecute = run.status === "created" || run.status === "validated" || run.status === "ready";
  const runCanPause = run.status === "running" || run.status === "scheduling";
  const runCanResume = run.status === "paused";
  const runIsTerminal = run.status === "passed" || run.status === "failed" || run.status === "cancelled";

  return createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.run_control.v1",
    kind: "run-control",
    scope: { runId, ...(run.domain ? { domain: run.domain } : {}) },
    data: {
      runId,
      status: run.status,
      rawStatus: run.status,
      ...(run.domain ? { domain: run.domain } : {}),
      goalPrompt: run.goal_prompt,
      taskCounts,
      unresolvedExceptionCount: unresolvedExceptions.length,
    },
    commands: [
      uiCommand({
        id: "execute-run",
        label: "Execute",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/execute`,
        method: "POST",
        enabled: runCanExecute,
        ...(runCanExecute ? {} : { disabledReason: `run status is ${run.status}` }),
      }),
      uiCommand({
        id: "pause-run",
        label: "Pause",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/pause`,
        method: "POST",
        enabled: runCanPause,
        ...(runCanPause ? {} : { disabledReason: `run status is ${run.status}` }),
      }),
      uiCommand({
        id: "resume-run",
        label: "Resume",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/resume`,
        method: "POST",
        enabled: runCanResume,
        ...(runCanResume ? {} : { disabledReason: `run status is ${run.status}` }),
      }),
      uiCommand({
        id: "cancel-run",
        label: "Cancel",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/cancel`,
        method: "POST",
        enabled: !runIsTerminal,
        ...(!runIsTerminal ? {} : { disabledReason: `run status is terminal: ${run.status}` }),
        dangerLevel: "medium",
        requiresConfirmation: true,
      }),
    ],
    attentionItems,
    sourceRefs: [{ id: "run", kind: "table-row", ref: `southstar.workflow_runs:${runId}` }],
    warnings: [],
  });
}

async function buildWorkflowDagReadModel(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ id: string; status: string }>("select id, status from southstar.workflow_runs where id = $1", [runId]);
  if (!run) throw new Error(`run not found: ${runId}`);

  const tasks = (await db.query<WorkflowDagTaskRow>(
    `select id, task_key, status, sort_order, depends_on_json
       from southstar.workflow_tasks
      where run_id = $1
      order by sort_order, id`,
    [runId],
  )).rows;
  const acceptedArtifactTaskIds = await acceptedArtifactTaskIdsForRunPg(db, runId);

  return createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.workflow_dag.v1",
    kind: "workflow-dag",
    scope: { runId },
    data: {
      runId,
      status: run.status,
      nodes: tasks.map((task) => {
        const dependsOn = stringArray(task.depends_on_json);
        return {
          id: task.id,
          label: task.task_key,
          status: task.status,
          sortOrder: task.sort_order,
          dependsOn,
          dependencyReady: dependsOn.every((dependency) => acceptedArtifactTaskIds.has(dependency)),
          acceptedArtifact: acceptedArtifactTaskIds.has(task.id),
        };
      }),
      edges: tasks.flatMap((task) => stringArray(task.depends_on_json).map((source) => ({ source, target: task.id }))),
    },
    commands: [],
    attentionItems: [],
    sourceRefs: [
      { id: "run", kind: "table-row", ref: `southstar.workflow_runs:${runId}` },
      { id: "tasks", kind: "table-row", ref: `southstar.workflow_tasks:run_id=${runId}` },
    ],
    warnings: [],
  });
}

async function buildRecoveryCenterReadModel(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ id: string }>("select id from southstar.workflow_runs where id = $1", [runId]);
  if (!run) throw new Error(`run not found: ${runId}`);

  const exceptions = await resourceRows(db, runId, "runtime_exception");
  const decisions = await resourceRows(db, runId, "recovery_decision");
  const actionableDecisions = decisions.filter((decision) => decision.status === "recorded" || decision.status === "approved");

  return createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.recovery_center.v1",
    kind: "recovery-center",
    scope: { runId },
    data: {
      runId,
      exceptions: exceptions.map(mapResource),
      decisions: decisions.map(mapResource),
    },
    commands: actionableDecisions.map((decision) => {
      const payload = asRecord(decision.payload_json);
      const decisionId = stringValue(payload.decisionId) ?? decision.resource_key;
      return uiCommand({
        id: `apply-recovery-decision:${decisionId}`,
        label: "Apply recovery",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/recovery-decisions/${encodeURIComponent(decisionId)}/apply`,
        method: "POST",
        enabled: true,
        dangerLevel: "medium",
        requiresConfirmation: true,
      });
    }),
    attentionItems: exceptions
      .filter((exception) => exception.status !== "resolved")
      .map((exception) => ({
        id: `exception:${exception.resource_key}`,
        severity: "blocked",
        title: exception.title ?? "Runtime exception",
        reason: stringValue(asRecord(exception.payload_json).kind) ?? exception.status,
        sourceRefs: [`runtime-resource:${exception.resource_key}`],
        suggestedCommandIds: actionableDecisions.map((decision) => {
          const decisionId = stringValue(asRecord(decision.payload_json).decisionId) ?? decision.resource_key;
          return `apply-recovery-decision:${decisionId}`;
        }),
      })),
    sourceRefs: [
      { id: "exceptions", kind: "runtime-resource", ref: `southstar.runtime_resources:runtime_exception:run_id=${runId}` },
      { id: "decisions", kind: "runtime-resource", ref: `southstar.runtime_resources:recovery_decision:run_id=${runId}` },
    ],
    warnings: [],
  });
}

async function buildExecutionCenterReadModel(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ id: string }>("select id from southstar.workflow_runs where id = $1", [runId]);
  if (!run) throw new Error(`run not found: ${runId}`);

  const handExecutions = await resourceRows(db, runId, "hand_execution");
  return createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.execution_center.v1",
    kind: "execution-center",
    scope: { runId },
    data: {
      runId,
      handExecutions: handExecutions.map(mapResource),
    },
    commands: handExecutions.flatMap((execution) => {
      const payload = asRecord(execution.payload_json);
      const externalJobId = stringValue(payload.externalJobId);
      if (!externalJobId) return [];
      const canCancel = execution.status === "queued" || execution.status === "running" || execution.status === "submitted";
      return [
        uiCommand({
          id: `reconcile-executor-job:${externalJobId}`,
          label: "Reconcile",
          endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(externalJobId)}/reconcile`,
          method: "POST",
          enabled: true,
        }),
        uiCommand({
          id: `cancel-executor-job:${externalJobId}`,
          label: "Cancel",
          endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(externalJobId)}/cancel`,
          method: "POST",
          enabled: canCancel,
          ...(canCancel ? {} : { disabledReason: `hand execution status is ${execution.status}` }),
          dangerLevel: "medium",
          requiresConfirmation: true,
        }),
      ];
    }),
    attentionItems: [],
    sourceRefs: [{ id: "hand-executions", kind: "runtime-resource", ref: `southstar.runtime_resources:hand_execution:run_id=${runId}` }],
    warnings: [],
  });
}

async function resourceRows(db: SouthstarDb, runId: string, resourceType: string): Promise<ResourceRow[]> {
  return (await db.query<ResourceRow>(
    `select resource_key, task_id, session_id, status, title, payload_json, summary_json
       from southstar.runtime_resources
      where run_id = $1 and resource_type = $2
      order by created_at, resource_key`,
    [runId, resourceType],
  )).rows;
}

function mapResource(row: ResourceRow) {
  return {
    id: row.resource_key,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    title: row.title ?? undefined,
    payload: row.payload_json,
    summary: row.summary_json,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
