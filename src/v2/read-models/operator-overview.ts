import type { SouthstarDb } from "../db/postgres.ts";
import { isTaskRecoverableStatus } from "../task-recovery.ts";

const ACTIVE_RUN_STATUSES = ["created", "validated", "ready", "scheduling", "running", "paused", "blocked"] as const;
const TERMINAL_RUN_STATUSES = ["completed", "passed", "failed", "cancelled"] as const;
const ACTIVE_EXECUTOR_STATUSES = ["submitted", "queued", "starting", "running", "heartbeat-lost", "queue-timeout", "hard-timeout", "callback-missing", "orphaned"] as const;
const TERMINAL_RESOURCE_STATUSES = ["resolved", "rejected", "completed", "passed", "cancelled", "superseded"] as const;

type InterventionMode = "run" | "task" | "exception" | "executor" | "approval" | "recovery";

type OperatorCommand = {
  id: string;
  label: string;
  endpoint?: string;
  method: "GET" | "POST";
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
  body?: Record<string, unknown>;
};

type AttentionSource = {
  resourceType: string;
  resourceKey: string;
  ref: string;
};

type OperatorAttentionItem = {
  id: string;
  kind: string;
  severity: "blocked" | "error" | "warning" | "info";
  interventionMode: InterventionMode;
  source: AttentionSource;
  runId?: string;
  taskId?: string;
  title: string;
  status: string;
  reason: string;
  detail: Record<string, unknown>;
  updatedAt: string;
  suggestedActions: string[];
  commands: OperatorCommand[];
  suggestedCommandId?: string;
};

type RuntimeCommandResultView = {
  commandId: string;
  accepted: boolean;
  status: string;
  affectedRunId?: string;
  affectedTaskId?: string;
  message?: string;
  resourceRefs: unknown[];
  eventRefs: unknown[];
  nextSuggestedActions: string[];
  updatedAt: string;
  source: AttentionSource;
};

type ActiveRun = {
  runId: string;
  status: string;
  domain?: string;
  title: string;
  cwd?: string;
  projectRoot?: string;
  updatedAt: string;
};

export async function buildOperatorOverviewReadModelPg(db: SouthstarDb) {
  const activeRuns = (await db.query<{
    id: string;
    status: string;
    domain: string | null;
    goal_prompt: string;
    runtime_context_json: unknown;
    updated_at: Date;
  }>(
    `select id, status, domain, goal_prompt, runtime_context_json, updated_at
       from southstar.workflow_runs
      where status = any($1::text[])
         or (
          status = any($2::text[])
          and exists (
            select 1
              from southstar.runtime_resources attention
             where attention.run_id = southstar.workflow_runs.id
               and attention.resource_type in ('runtime_exception', 'approval', 'recovery_decision', 'executor_binding', 'hand_execution')
               and attention.status <> all($3::text[])
          )
        )
      order by updated_at desc, id
      limit 50`,
    [[...ACTIVE_RUN_STATUSES], [...TERMINAL_RUN_STATUSES], [...TERMINAL_RESOURCE_STATUSES]],
  )).rows.map((run): ActiveRun => {
    const runtimeContext = asRecord(run.runtime_context_json);
    const cwd = stringValue(runtimeContext.cwd);
    const projectRoot = stringValue(runtimeContext.projectRoot) ?? cwd;
    return {
      runId: run.id,
      status: run.status,
      domain: run.domain ?? undefined,
      title: run.goal_prompt,
      ...(cwd ? { cwd } : {}),
      ...(projectRoot ? { projectRoot } : {}),
      updatedAt: run.updated_at.toISOString(),
    };
  });

  const activeRunIds = activeRuns.map((run) => run.runId);
  const [resourceRows, taskRows, commandRows] = await Promise.all([
    readAttentionResourceRows(db),
    activeRunIds.length > 0 ? readAttentionTaskRows(db, activeRunIds) : Promise.resolve([]),
    readRuntimeCommandRows(db),
  ]);

  const resourceAttention = resourceRows.map(resourceAttentionItem).filter((item): item is OperatorAttentionItem => item !== null);
  const taskAttention = taskRows.map(taskAttentionItem);
  const runAttention = activeRuns.map(runAttentionItem);
  const attentionItems = [
    ...resourceAttention,
    ...taskAttention,
    ...runAttention,
  ].sort(compareAttention);
  const commandResults = commandRows.map(commandResultView).filter((result): result is RuntimeCommandResultView => result !== null);

  return {
    activeRuns,
    runs: activeRuns,
    attentionItems,
    commandResults,
    runtimeHealth: {
      activeRunCount: activeRuns.length,
      attentionCount: attentionItems.length,
      blockedCount: attentionItems.filter((item) => item.severity === "blocked").length,
    },
    defaultSelection: attentionItems[0]?.runId
      ? { runId: attentionItems[0].runId, attentionItemId: attentionItems[0].id, interventionMode: attentionItems[0].interventionMode }
      : activeRuns[0]
        ? { runId: activeRuns[0].runId, interventionMode: "run" as const }
        : null,
  };
}

async function readAttentionResourceRows(db: SouthstarDb) {
  return (await db.query<{
    resource_type: string;
    resource_key: string;
    run_id: string | null;
    task_id: string | null;
    status: string;
    title: string | null;
    payload_json: unknown;
    summary_json: unknown;
    updated_at: Date;
  }>(
    `select resource_type, resource_key, run_id, task_id, status, title, payload_json, summary_json, updated_at
       from southstar.runtime_resources
      where resource_type in ('runtime_exception', 'approval', 'recovery_decision', 'executor_binding', 'hand_execution')
        and status <> all($1::text[])
      order by updated_at desc, resource_key
      limit 100`,
    [[...TERMINAL_RESOURCE_STATUSES]],
  )).rows;
}

async function readAttentionTaskRows(db: SouthstarDb, activeRunIds: string[]) {
  return (await db.query<{
    id: string;
    run_id: string;
    task_key: string;
    status: string;
    depends_on_json: unknown;
    root_session_id: string | null;
    executor_task_id: string | null;
    updated_at: Date;
  }>(
    `select id, run_id, task_key, status, depends_on_json, root_session_id, executor_task_id, updated_at
       from southstar.workflow_tasks
      where run_id = any($1::text[])
        and status in ('blocked', 'failed')
      order by updated_at desc, sort_order, id`,
    [activeRunIds],
  )).rows;
}

async function readRuntimeCommandRows(db: SouthstarDb) {
  return (await db.query<{
    resource_key: string;
    run_id: string | null;
    task_id: string | null;
    status: string;
    title: string | null;
    payload_json: unknown;
    updated_at: Date;
  }>(
    `select resource_key, run_id, task_id, status, title, payload_json, updated_at
       from southstar.runtime_resources
      where resource_type = 'runtime_command'
      order by updated_at desc, resource_key
      limit 50`,
  )).rows;
}

function resourceAttentionItem(row: Awaited<ReturnType<typeof readAttentionResourceRows>>[number]): OperatorAttentionItem | null {
  const payload = asRecord(row.payload_json);
  const summary = asRecord(row.summary_json);
  const mode = interventionModeForResource(row.resource_type);
  if (!mode) return null;
  const runId = row.run_id ?? stringValue(payload.runId);
  const taskId = row.task_id ?? stringValue(payload.taskId);
  const detail = {
    ...summary,
    ...payload,
    ...(executorJobId(payload, row.resource_key) ? { torkJobId: executorJobId(payload, row.resource_key) } : {}),
  };
  const commands = commandsForResource(row.resource_type, {
    runId,
    taskId,
    status: row.status,
    resourceKey: row.resource_key,
    payload,
  });
  return {
    id: `${row.resource_type}:${row.resource_key}`,
    kind: row.resource_type,
    severity: severityFor(row.resource_type, row.status),
    interventionMode: mode,
    source: {
      resourceType: row.resource_type,
      resourceKey: row.resource_key,
      ref: `southstar.runtime_resources:${row.resource_type}:${row.resource_key}`,
    },
    ...(runId ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    title: row.title ?? titleFor(row.resource_type, row.status),
    status: row.status,
    reason: reasonFor(row.payload_json, row.status),
    detail,
    updatedAt: row.updated_at.toISOString(),
    suggestedActions: suggestedActionsFor(row.resource_type, row.status),
    commands,
    ...(firstEnabledCommandId(commands) ? { suggestedCommandId: firstEnabledCommandId(commands) } : {}),
  };
}

function taskAttentionItem(row: Awaited<ReturnType<typeof readAttentionTaskRows>>[number]): OperatorAttentionItem {
  const dependsOn = stringArray(row.depends_on_json);
  const commands = taskCommands(row.run_id, row.id, row.status);
  const reason = row.status === "blocked"
    ? dependsOn.length > 0 ? `blocked dependency: ${dependsOn.join(", ")}` : "blocked dependency"
    : "failed task";
  return {
    id: `task:${row.id}`,
    kind: "task",
    severity: row.status === "failed" ? "error" : "blocked",
    interventionMode: "task",
    source: {
      resourceType: "workflow_task",
      resourceKey: `${row.run_id}:${row.id}`,
      ref: `southstar.workflow_tasks:${row.run_id}:${row.id}`,
    },
    runId: row.run_id,
    taskId: row.id,
    title: row.status === "failed" ? `Failed task: ${row.task_key}` : `Blocked task: ${row.task_key}`,
    status: row.status,
    reason,
    detail: {
      taskId: row.id,
      taskKey: row.task_key,
      status: row.status,
      dependsOn,
      ...(row.root_session_id ? { rootSessionId: row.root_session_id } : {}),
      ...(row.executor_task_id ? { executorTaskId: row.executor_task_id } : {}),
    },
    updatedAt: row.updated_at.toISOString(),
    suggestedActions: row.status === "failed" ? ["retry-task", "fork-session", "request-revision"] : ["review-blocked-dependency", "retry-task"],
    commands,
    ...(firstEnabledCommandId(commands) ? { suggestedCommandId: firstEnabledCommandId(commands) } : {}),
  };
}

function runAttentionItem(run: ActiveRun): OperatorAttentionItem {
  const commands = runCommands(run.runId, run.status);
  const failed = run.status === "failed";
  const cancelled = run.status === "cancelled";
  const paused = run.status === "paused";
  const blocked = run.status === "blocked";
  return {
    id: `run:${run.runId}`,
    kind: "run",
    severity: failed || cancelled ? "blocked" : paused || blocked ? "warning" : "info",
    interventionMode: "run",
    source: {
      resourceType: "workflow_run",
      resourceKey: run.runId,
      ref: `southstar.workflow_runs:${run.runId}`,
    },
    runId: run.runId,
    title: failed ? `Failed run: ${run.title}` : cancelled ? `Cancelled run: ${run.title}` : paused ? `Paused run: ${run.title}` : `Active run: ${run.title}`,
    status: run.status,
    reason: failed || cancelled ? "terminal run has unresolved operator attention" : paused ? "paused run" : "normal active run watch",
    detail: {
      runId: run.runId,
      status: run.status,
      title: run.title,
      ...(run.domain ? { domain: run.domain } : {}),
    },
    updatedAt: run.updatedAt,
    suggestedActions: failed || cancelled ? ["review-attention", "inspect-run"] : paused ? ["resume-run", "cancel-run"] : ["watch-events", "pause-run", "cancel-run"],
    commands,
    ...(firstEnabledCommandId(commands) ? { suggestedCommandId: firstEnabledCommandId(commands) } : {}),
  };
}

function commandResultView(row: Awaited<ReturnType<typeof readRuntimeCommandRows>>[number]): RuntimeCommandResultView | null {
  const payload = asRecord(row.payload_json);
  const result = asRecord(payload.result);
  const commandId = stringValue(result.commandId) ?? stringValue(payload.commandId) ?? row.resource_key;
  const status = stringValue(result.status) ?? row.status;
  const accepted = typeof result.accepted === "boolean" ? result.accepted : status !== "blocked" && status !== "rejected";
  return {
    commandId,
    accepted,
    status,
    ...(stringValue(result.affectedRunId) ?? row.run_id ? { affectedRunId: stringValue(result.affectedRunId) ?? row.run_id ?? undefined } : {}),
    ...(stringValue(result.affectedTaskId) ?? row.task_id ? { affectedTaskId: stringValue(result.affectedTaskId) ?? row.task_id ?? undefined } : {}),
    ...(stringValue(result.message) ? { message: stringValue(result.message) } : {}),
    resourceRefs: Array.isArray(result.resourceRefs) ? result.resourceRefs : [],
    eventRefs: Array.isArray(result.eventRefs) ? result.eventRefs : [],
    nextSuggestedActions: stringArray(result.nextSuggestedActions),
    updatedAt: row.updated_at.toISOString(),
    source: {
      resourceType: "runtime_command",
      resourceKey: row.resource_key,
      ref: `southstar.runtime_resources:runtime_command:${row.resource_key}`,
    },
  };
}

function commandsForResource(resourceType: string, input: {
  runId?: string;
  taskId?: string;
  status: string;
  resourceKey: string;
  payload: Record<string, unknown>;
}): OperatorCommand[] {
  if (resourceType === "executor_binding" || resourceType === "hand_execution") {
    return executorCommands(input.runId, executorJobId(input.payload, input.resourceKey), input.status);
  }
  if (resourceType === "approval") return approvalCommands(input.runId, approvalId(input.payload, input.resourceKey));
  if (resourceType === "recovery_decision") return recoveryCommands(input.runId, recoveryDecisionId(input.payload, input.resourceKey), input.status);
  if (resourceType === "runtime_exception") {
    return [
      ...input.runId && input.taskId ? taskCommands(input.runId, input.taskId, "blocked").slice(0, 1) : [],
    ];
  }
  return [];
}

function executorCommands(runId: string | undefined, jobId: string | undefined, status: string): OperatorCommand[] {
  const hasTarget = Boolean(runId && jobId);
  const cancelEnabled = hasTarget && (ACTIVE_EXECUTOR_STATUSES as readonly string[]).includes(status);
  return [
    command("executor.reconcile", "Reconcile Executor", hasTarget ? `/api/v2/runs/${encodeURIComponent(runId!)}/executor-jobs/${encodeURIComponent(jobId!)}/reconcile` : undefined, {
      enabled: hasTarget,
      disabledReason: hasTarget ? undefined : "executor job id is missing",
    }),
    command("executor.cancel", "Cancel Executor", hasTarget ? `/api/v2/runs/${encodeURIComponent(runId!)}/executor-jobs/${encodeURIComponent(jobId!)}/cancel` : undefined, {
      enabled: cancelEnabled,
      requiresConfirmation: true,
      disabledReason: hasTarget && !cancelEnabled ? `executor cannot cancel from status ${status}` : hasTarget ? undefined : "executor job id is missing",
    }),
  ];
}

function taskCommands(runId: string, taskId: string, status: string): OperatorCommand[] {
  const recoverable = isTaskRecoverableStatus(status);
  return [
    command("task.retry", "Retry Task", `/api/v2/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/retry`, {
      enabled: recoverable,
      requiresConfirmation: true,
      disabledReason: recoverable ? undefined : `task status ${status} does not allow retry`,
    }),
    command("task.fork-session", "Fork Session", `/api/v2/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/fork-session`, {
      enabled: recoverable,
      requiresConfirmation: true,
      disabledReason: recoverable ? undefined : `task status ${status} does not allow fork-session`,
    }),
    command("task.request-revision", "Request Revision", `/api/v2/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/request-revision`, {
      enabled: recoverable,
      requiresConfirmation: true,
      disabledReason: recoverable ? undefined : `task status ${status} does not allow request-revision`,
    }),
  ];
}

function runCommands(runId: string, status: string): OperatorCommand[] {
  const canPause = status === "scheduling" || status === "running";
  const canResume = status === "paused" || status === "blocked";
  const canCancel = !(TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
  return [
    command("run.pause", "Pause Run", `/api/v2/runs/${encodeURIComponent(runId)}/pause`, {
      enabled: canPause,
      disabledReason: canPause ? undefined : `run cannot pause from status ${status}`,
    }),
    command("run.resume", "Resume Run", `/api/v2/runs/${encodeURIComponent(runId)}/resume`, {
      enabled: canResume,
      disabledReason: canResume ? undefined : `run cannot resume from status ${status}`,
    }),
    command("run.cancel", "Cancel Run", `/api/v2/runs/${encodeURIComponent(runId)}/cancel`, {
      enabled: canCancel,
      requiresConfirmation: true,
      disabledReason: canCancel ? undefined : `run cannot cancel from terminal status ${status}`,
    }),
  ];
}

function approvalCommands(runId: string | undefined, approvalIdValue: string | undefined): OperatorCommand[] {
  const hasTarget = Boolean(runId && approvalIdValue);
  const endpoint = hasTarget ? `/api/v2/runs/${encodeURIComponent(runId!)}/approvals/${encodeURIComponent(approvalIdValue!)}/decision` : undefined;
  return [
    command("approval.approve", "Approve", endpoint, {
      enabled: hasTarget,
      requiresConfirmation: true,
      disabledReason: hasTarget ? undefined : "approval target is missing",
      body: { decision: "approved" },
    }),
    command("approval.reject", "Reject", endpoint, {
      enabled: hasTarget,
      requiresConfirmation: true,
      disabledReason: hasTarget ? undefined : "approval target is missing",
      body: { decision: "rejected" },
    }),
  ];
}

function recoveryCommands(runId: string | undefined, decisionIdValue: string | undefined, status: string): OperatorCommand[] {
  const hasTarget = Boolean(runId && decisionIdValue);
  const approvalEndpoint = hasTarget ? `/api/v2/runs/${encodeURIComponent(runId!)}/recovery-decisions/${encodeURIComponent(decisionIdValue!)}/approval` : undefined;
  const applyEndpoint = hasTarget ? `/api/v2/runs/${encodeURIComponent(runId!)}/recovery-decisions/${encodeURIComponent(decisionIdValue!)}/apply` : undefined;
  const waiting = status === "waiting_operator_approval";
  const approved = status === "approved" || status === "recorded";
  return [
    command("recovery.approve", "Approve Recovery", approvalEndpoint, {
      enabled: hasTarget && waiting,
      requiresConfirmation: true,
      disabledReason: !hasTarget ? "recovery decision target is missing" : waiting ? undefined : `recovery decision cannot approve from status ${status}`,
      body: { decision: "approved" },
    }),
    command("recovery.reject", "Reject Recovery", approvalEndpoint, {
      enabled: hasTarget && waiting,
      requiresConfirmation: true,
      disabledReason: !hasTarget ? "recovery decision target is missing" : waiting ? undefined : `recovery decision cannot reject from status ${status}`,
      body: { decision: "rejected" },
    }),
    command("recovery.apply", "Apply Recovery", applyEndpoint, {
      enabled: hasTarget && approved,
      requiresConfirmation: true,
      disabledReason: !hasTarget ? "recovery decision target is missing" : approved ? undefined : `recovery decision cannot apply from status ${status}`,
    }),
  ];
}

function command(id: string, label: string, endpoint: string | undefined, options: {
  method?: "GET" | "POST";
  enabled?: boolean;
  requiresConfirmation?: boolean;
  disabledReason?: string;
  body?: Record<string, unknown>;
} = {}): OperatorCommand {
  const enabled = options.enabled ?? Boolean(endpoint);
  return {
    id,
    label,
    ...(endpoint ? { endpoint } : {}),
    method: options.method ?? "POST",
    enabled,
    requiresConfirmation: options.requiresConfirmation ?? false,
    ...(options.disabledReason ? { disabledReason: options.disabledReason } : {}),
    ...(options.body ? { body: options.body } : {}),
  };
}

function interventionModeForResource(resourceType: string): InterventionMode | null {
  if (resourceType === "runtime_exception") return "exception";
  if (resourceType === "approval") return "approval";
  if (resourceType === "recovery_decision") return "recovery";
  if (resourceType === "executor_binding" || resourceType === "hand_execution") return "executor";
  return null;
}

function severityFor(resourceType: string, status: string): "blocked" | "error" | "warning" | "info" {
  if (resourceType === "runtime_exception") return "blocked";
  if (status.includes("failed") || status.includes("timeout") || status.includes("lost") || status.includes("missing")) return "error";
  if (resourceType === "approval" || resourceType === "recovery_decision") return "warning";
  return "info";
}

function compareAttention(a: { severity: string; updatedAt: string; id: string }, b: { severity: string; updatedAt: string; id: string }): number {
  const rank: Record<string, number> = { blocked: 0, error: 1, warning: 2, info: 3 };
  return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function titleFor(resourceType: string, status: string): string {
  if (resourceType === "runtime_exception") return "Runtime exception";
  if (resourceType === "approval") return "Approval required";
  if (resourceType === "recovery_decision") return "Recovery decision";
  if (resourceType === "executor_binding" || resourceType === "hand_execution") return "Executor attention";
  return `${resourceType} ${status}`;
}

function reasonFor(payload: unknown, status: string): string {
  const record = asRecord(payload);
  return String(record.kind ?? record.reason ?? record.message ?? status);
}

function suggestedActionsFor(resourceType: string, status: string): string[] {
  if (resourceType === "runtime_exception") return ["open-exception", "review-recovery"];
  if (resourceType === "approval") return ["approve", "reject"];
  if (resourceType === "recovery_decision") return ["approve-recovery", "apply-recovery"];
  if (status.includes("timeout") || status.includes("lost") || status.includes("missing")) return ["reconcile-executor-job", "cancel-executor-job"];
  return ["watch-events"];
}

function executorJobId(payload: Record<string, unknown>, fallback: string): string | undefined {
  return stringValue(payload.torkJobId)
    ?? stringValue(payload.externalJobId)
    ?? stringValue(payload.jobId)
    ?? stringValue(payload.executorJobId)
    ?? (fallback.startsWith("job-") ? fallback : undefined);
}

function approvalId(payload: Record<string, unknown>, fallback: string): string {
  return stringValue(payload.approvalId) ?? fallback;
}

function recoveryDecisionId(payload: Record<string, unknown>, fallback: string): string {
  return stringValue(payload.decisionId) ?? fallback;
}

function firstEnabledCommandId(commands: OperatorCommand[]): string | undefined {
  return commands.find((item) => item.enabled)?.id;
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
