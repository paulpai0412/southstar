import { projectStatusForLifecycle } from "../adapters/github/project-v2.ts";
import { redactSecrets } from "../runtime/redaction.ts";
import type { HistoryEntry, IssueSnapshot } from "../types/control-plane.ts";

export interface OrchestratorInspectModel {
  issue_id: string;
  lifecycle_state: string;
  project_lifecycle: string | null;
  project_status: string | null;
  dependencies: unknown;
  owner_lease: unknown;
  root_sessions: string[];
  child_runs: unknown[];
  pr: unknown;
  pr_url: string | null;
  merge_sha: string | null;
  current_stage: string | null;
  last_heartbeat: string | null;
  cleanup_backlog: number;
  retryable_effects: HistoryEntry[];
  recovery_suggestion: string;
  next_action: string;
  fields_present: number;
}

export function inspectIssueSnapshot(snapshot: IssueSnapshot, history: HistoryEntry[]): OrchestratorInspectModel {
  const runtime = snapshot.runtime_context_json;
  const terminal = isTerminal(snapshot.lifecycle_state);
  const childRuns = terminal
    ? terminalChildRuns(snapshot.runtime_context_json.child_runs ?? [], snapshot.lifecycle_state)
    : snapshot.runtime_context_json.child_runs ?? [];
  const retryableEffects = redactSecrets(history.filter((row) => row.event_type === "effect_failed_retryable"));
  const project = objectValue(runtime.project);
  const pr = objectValue(runtime.pr);
  const release = objectValue(runtime.release);
  const ownerLease = terminal ? null : objectValue(runtime.owner_lease);
  const cleanup = objectValue(runtime.cleanup);
  const projectStatus = projectStatusForLifecycle(snapshot.lifecycle_state);
  const model = {
    issue_id: snapshot.issue_id,
    lifecycle_state: snapshot.lifecycle_state,
    project_lifecycle: stringValue(project?.lifecycle ?? snapshot.lifecycle_state),
    project_status: stringValue(project?.status ?? projectStatus.status),
    dependencies: runtime.dependencies ?? [],
    owner_lease: terminal ? null : runtime.owner_lease ?? null,
    root_sessions: childRuns.map((run) => run.root_session_id).filter((value, index, values) => values.indexOf(value) === index),
    child_runs: childRuns,
    pr: runtime.pr ?? null,
    pr_url: stringValue(pr?.url ?? pr?.pr_url ?? pr?.html_url ?? pr?.prUrl),
    merge_sha: stringValue(pr?.merge_sha ?? pr?.mergeSha ?? release?.merge_sha ?? release?.mergeSha),
    current_stage: terminal ? snapshot.lifecycle_state : stringValue(runtime.current_stage ?? runtime.stage_cursor),
    last_heartbeat: stringValue(ownerLease?.last_heartbeat_at ?? ownerLease?.lastHeartbeatAt),
    cleanup_backlog: numberValue(cleanup?.backlog),
    retryable_effects: retryableEffects,
    recovery_suggestion: recoverySuggestion(retryableEffects, snapshot.lifecycle_state),
    next_action: nextAction(snapshot.lifecycle_state),
    fields_present: 0,
  };
  return { ...model, fields_present: countPresentFields(model) };
}

function isTerminal(state: string): boolean {
  return state === "completed" || state === "cancelled" || state === "failed" || state === "quarantined";
}

function terminalChildRuns(childRuns: NonNullable<IssueSnapshot["runtime_context_json"]["child_runs"]>, state: string) {
  const terminalStatus = state === "completed" ? "succeeded" : state === "quarantined" || state === "cancelled" ? "blocked" : "failed";
  return childRuns.map((run) =>
    run.status === "running" || run.status === "queued"
      ? { ...run, status: terminalStatus }
      : run
  );
}

function nextAction(state: string): string {
  if (state === "ready") return "start";
  if (state === "running" || state === "verifying") return "reconcile";
  if (state === "verified") return "release";
  if (state === "quarantined") return "operator_resume_or_repair_runtime";
  if (state === "completed" || state === "cancelled") return "none";
  return "inspect_history";
}

function recoverySuggestion(retryableEffects: HistoryEntry[], state: string): string {
  if (retryableEffects.length > 0) {
    return "Inspect retryable effect history and retry the failed projection or effect after the next retry window.";
  }
  if (state === "quarantined") {
    return "Issue is quarantined. Choose operator action: northstar repair-runtime --issue <N>, northstar resume --issue <N> --to ready --reason <text>, or northstar resume --issue <N> --to running --reason <text>.";
  }
  return "No retryable effects found; inspect lifecycle history for the next operator action.";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function countPresentFields(model: Omit<OrchestratorInspectModel, "fields_present"> & { fields_present: number }): number {
  return Object.entries(model).filter(([key, value]) => {
    if (key === "fields_present") return false;
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== "";
  }).length;
}
