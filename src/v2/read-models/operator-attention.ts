import { isTaskRecoverableStatus } from "../task-recovery.ts";
import type { GoalMissionReadModel } from "./workflow-ui.ts";

export const ACTIVE_RUN_STATUSES = ["created", "validated", "ready", "awaiting_approval", "scheduling", "running", "paused", "blocked"] as const;
export const TERMINAL_RUN_STATUSES = ["completed", "passed", "failed", "cancelled"] as const;
export const OPERATOR_ATTENTION_RUN_STATUSES = ["paused", "blocked", "failed", "cancelled"] as const;
export const RECENT_RESOLVED_RUN_STATUSES = ["completed", "passed", "cancelled"] as const;
export const ACTIVE_EXECUTOR_STATUSES = ["submitted", "queued", "starting", "running", "heartbeat-lost", "queue-timeout", "hard-timeout", "callback-missing", "orphaned"] as const;
export const NORMAL_EXECUTOR_RESOURCE_STATUSES = ["submitted", "queued", "starting", "running"] as const;
export const TERMINAL_RESOURCE_STATUSES = ["resolved", "rejected", "completed", "passed", "cancelled", "superseded", "applied"] as const;

type InterventionMode = "run" | "task" | "exception" | "executor" | "approval" | "recovery";

export type OperatorCommand = {
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

export type OperatorAttentionItem = {
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

export type RuntimeCommandResultView = {
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

export type ActiveRun = {
  runId: string;
  status: string;
  executionStatus: string;
  outcomeStatus: GoalMissionReadModel["status"]["outcome"];
  healthStatus: GoalMissionReadModel["status"]["health"];
  mission: GoalMissionReadModel | null;
  domain?: string;
  title: string;
  cwd?: string;
  projectRoot?: string;
  updatedAt: string;
  commands: OperatorCommand[];
};

export type OperatorRunRow = {
  id: string;
  status: string;
  domain: string | null;
  goal_prompt: string;
  runtime_context_json: unknown;
  updated_at: Date;
};

export type AttentionResourceRow = {
  resource_type: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  task_status: string | null;
  run_status: string | null;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
  updated_at: Date;
};

export type AttentionTaskRow = {
  id: string;
  run_id: string;
  task_key: string;
  status: string;
  depends_on_json: unknown;
  root_session_id: string | null;
  executor_task_id: string | null;
  updated_at: Date;
};

export type RuntimeCommandRow = {
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  status: string;
  title: string | null;
  payload_json: unknown;
  updated_at: Date;
};

export function activeRunFromRow(run: OperatorRunRow): ActiveRun {
  const runtimeContext = asRecord(run.runtime_context_json);
  const cwd = stringValue(runtimeContext.cwd);
  const projectRoot = stringValue(runtimeContext.projectRoot) ?? cwd;
  return {
    runId: run.id,
    status: run.status,
    executionStatus: run.status,
    outcomeStatus: "in_progress",
    healthStatus: "healthy",
    mission: null,
    domain: run.domain ?? undefined,
    title: run.goal_prompt,
    ...(cwd ? { cwd } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    updatedAt: run.updated_at.toISOString(),
    commands: runCommands(run.id, run.status),
  };
}

export function buildOperatorAttentionItems(input: {
  resourceRows: AttentionResourceRow[];
  taskRows: AttentionTaskRow[];
  activeRuns: ActiveRun[];
}): OperatorAttentionItem[] {
  const resourceAttention = input.resourceRows.map(resourceAttentionItem).filter((item): item is OperatorAttentionItem => item !== null);
  const taskAttention = input.taskRows.map(taskAttentionItem);
  const runAttention = input.activeRuns
    .filter((run) => !(RECENT_RESOLVED_RUN_STATUSES as readonly string[]).includes(run.status))
    .filter((run) => (OPERATOR_ATTENTION_RUN_STATUSES as readonly string[]).includes(run.status))
    .map(runAttentionItem);
  return [
    ...resourceAttention,
    ...taskAttention,
    ...input.activeRuns.flatMap(goalRequirementAttentionItems),
    ...runAttention,
  ].sort(compareAttention);
}

function goalRequirementAttentionItems(run: ActiveRun): OperatorAttentionItem[] {
  const mission = run.mission;
  if (!mission) return [];
  const covered = new Set(mission.coverage.entries.map((entry) => entry.requirementId));
  const byId = new Map(mission.goalContract.requirements.map((requirement) => [requirement.id, requirement]));
  const uncovered = mission.goalContract.requirements
    .filter((requirement) => !covered.has(requirement.id))
    .map((requirement): OperatorAttentionItem => ({
      id: `goal-requirement-uncovered:${run.runId}:${requirement.id}`,
      kind: "goal_requirement",
      severity: requirement.blocking ? "blocked" : "warning",
      interventionMode: "run",
      source: {
        resourceType: "goal_requirement_coverage",
        resourceKey: run.runId,
        ref: `southstar.runtime_resources:goal_requirement_coverage:${run.runId}`,
      },
      runId: run.runId,
      title: `Uncovered requirement: ${requirement.statement}`,
      status: "uncovered",
      reason: "Goal Contract requirement has no frozen coverage entry",
      detail: { requirement, goalContractHash: mission.goalContractHash },
      updatedAt: run.updatedAt,
      suggestedActions: ["inspect-workflow-coverage"],
      commands: [],
    }));
  const failed = mission.coverage.failedRequirementIds.map((requirementId): OperatorAttentionItem => {
    const requirement = byId.get(requirementId);
    return {
      id: `goal-requirement-failed:${run.runId}:${requirementId}`,
      kind: "goal_requirement",
      severity: requirement?.blocking === false ? "warning" : "error",
      interventionMode: "run",
      source: {
        resourceType: "goal_outcome",
        resourceKey: `goal-outcome:${run.runId}`,
        ref: `southstar.runtime_resources:goal_outcome:goal-outcome:${run.runId}`,
      },
      runId: run.runId,
      title: `Failed requirement: ${requirement?.statement ?? requirementId}`,
      status: "failed",
      reason: "Goal outcome evidence did not satisfy this requirement",
      detail: { requirementId, ...(requirement ? { requirement } : {}), goalContractHash: mission.goalContractHash },
      updatedAt: run.updatedAt,
      suggestedActions: ["inspect-evaluator-evidence", "review-repair"],
      commands: [],
    };
  });
  return [...uncovered, ...failed];
}

export function commandResultView(row: RuntimeCommandRow): RuntimeCommandResultView | null {
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

function resourceAttentionItem(row: AttentionResourceRow): OperatorAttentionItem | null {
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
    taskStatus: row.task_status ?? undefined,
    status: row.status,
    resourceKey: row.resource_key,
    payload,
  });
  return {
    id: `${row.resource_type}:${row.resource_key}`,
    kind: row.resource_type,
    severity: severityFor(row.resource_type, row.status, payload),
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

function taskAttentionItem(row: AttentionTaskRow): OperatorAttentionItem {
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
    title: failed ? `Failed run: ${run.title}` : cancelled ? `Cancelled run: ${run.title}` : paused ? `Paused run: ${run.title}` : blocked ? `Blocked run: ${run.title}` : `Active run: ${run.title}`,
    status: run.status,
    reason: failed || cancelled ? "terminal run has unresolved operator attention" : paused ? "paused run" : blocked ? "blocked run" : "normal active run watch",
    detail: {
      runId: run.runId,
      status: run.status,
      title: run.title,
      ...(run.domain ? { domain: run.domain } : {}),
    },
    updatedAt: run.updatedAt,
    suggestedActions: failed || cancelled ? ["review-attention", "inspect-run"] : paused || blocked ? ["resume-run", "cancel-run"] : ["watch-events", "pause-run", "cancel-run"],
    commands,
    ...(firstEnabledCommandId(commands) ? { suggestedCommandId: firstEnabledCommandId(commands) } : {}),
  };
}

function commandsForResource(resourceType: string, input: {
  runId?: string;
  taskId?: string;
  taskStatus?: string;
  status: string;
  resourceKey: string;
  payload: Record<string, unknown>;
}): OperatorCommand[] {
  if (resourceType === "executor_binding" || resourceType === "hand_execution") {
    return executorCommands(input.runId, executorJobId(input.payload, input.resourceKey), input.status);
  }
  if (resourceType === "approval") return approvalCommands(input.runId, approvalId(input.payload, input.resourceKey));
  if (resourceType === "recovery_decision") return recoveryCommands(input.runId, recoveryDecisionId(input.payload, input.resourceKey), input.status, input.resourceKey);
  if (resourceType === "runtime_exception") {
    return [
      ...input.runId && input.taskId ? taskCommands(input.runId, input.taskId, input.taskStatus ?? "unknown").slice(0, 1) : [],
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
    command("task.reset-session", "Reset Session", `/api/v2/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/reset-session`, {
      enabled: recoverable,
      requiresConfirmation: true,
      disabledReason: recoverable ? undefined : `task status ${status} does not allow reset-session`,
    }),
    command("task.rollback-session", "Rollback Session", `/api/v2/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/rollback-session`, {
      enabled: false,
      requiresConfirmation: true,
      disabledReason: "rollback requires a usable workspace snapshot",
    }),
    command("task.request-revision", "Request Workflow Revision", `/api/v2/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/request-revision`, {
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
      body: { payload: { cancelActiveJobs: true } },
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

export function approvalCommands(runId: string | undefined, approvalIdValue: string | undefined): OperatorCommand[] {
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

function recoveryCommands(runId: string | undefined, decisionIdValue: string | undefined, status: string, resourceKey?: string): OperatorCommand[] {
  const hasTarget = Boolean(runId && decisionIdValue);
  const managed = Boolean(resourceKey?.startsWith("managed-recovery:"));
  const approvalEndpoint = hasTarget ? `/api/v2/runs/${encodeURIComponent(runId!)}/recovery-decisions/${encodeURIComponent(decisionIdValue!)}/approval` : undefined;
  const applyEndpoint = hasTarget ? `/api/v2/runs/${encodeURIComponent(runId!)}/recovery-decisions/${encodeURIComponent(decisionIdValue!)}/apply` : undefined;
  const waiting = status === "waiting_operator_approval";
  const approved = status === "approved" || status === "recorded";
  const managedReason = "managed recovery decisions are applied by the runtime loop";
  return [
    command("recovery.approve", "Approve Recovery", approvalEndpoint, {
      enabled: hasTarget && waiting && !managed,
      requiresConfirmation: true,
      disabledReason: managed ? managedReason : !hasTarget ? "recovery decision target is missing" : waiting ? undefined : `recovery decision cannot approve from status ${status}`,
      body: { decision: "approved" },
    }),
    command("recovery.reject", "Reject Recovery", approvalEndpoint, {
      enabled: hasTarget && waiting && !managed,
      requiresConfirmation: true,
      disabledReason: managed ? managedReason : !hasTarget ? "recovery decision target is missing" : waiting ? undefined : `recovery decision cannot reject from status ${status}`,
      body: { decision: "rejected" },
    }),
    command("recovery.apply", "Apply Recovery", applyEndpoint, {
      enabled: hasTarget && approved && !managed,
      requiresConfirmation: true,
      disabledReason: managed ? managedReason : !hasTarget ? "recovery decision target is missing" : approved ? undefined : `recovery decision cannot apply from status ${status}`,
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

function severityFor(resourceType: string, status: string, payload: Record<string, unknown> = {}): "blocked" | "error" | "warning" | "info" {
  if (resourceType === "runtime_exception") return runtimeExceptionSeverity(payload);
  if (status.includes("failed") || status.includes("timeout") || status.includes("lost") || status.includes("missing")) return "error";
  if (resourceType === "approval" || resourceType === "recovery_decision") return "warning";
  return "info";
}

function runtimeExceptionSeverity(payload: Record<string, unknown>): "blocked" | "error" | "warning" | "info" {
  const severity = stringValue(payload.severity)?.toLowerCase();
  if (severity === "blocking" || severity === "blocked" || severity === "critical") return "blocked";
  if (severity === "error" || severity === "failed" || severity === "failure") return "error";
  if (severity === "warning" || severity === "warn" || severity === "recoverable") return "warning";
  if (severity === "info" || severity === "observed") return "info";
  return "blocked";
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
