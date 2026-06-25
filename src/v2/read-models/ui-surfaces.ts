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

export async function buildUiSurfaceReadModel(db: SouthstarDb, input: ReadModelInput) {
  switch (input.kind) {
    case "run-control":
      return await buildRunControlReadModel(db, input.runId);
    case "workflow-dag":
      return await buildWorkflowDagReadModel(db, input.runId);
    default:
      throw new Error(`unsupported UI surface read model: ${input.kind}`);
  }
}

export function isUiSurfaceReadModelKind(kind: string): boolean {
  return kind === "run-control" || kind === "workflow-dag";
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
