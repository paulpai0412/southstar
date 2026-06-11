export interface ManualCliMetrics {
  manual_cli_issues_intaken: number;
  manual_cli_ready_snapshots: number;
  manual_cli_dependency_edges_parsed: number;
  manual_cli_dependency_order_violations: number;
  manual_cli_owner_leases_claimed: number;
  manual_cli_root_sessions_started: number;
  manual_cli_child_runs_started: number;
  manual_cli_worktrees_created: number;
  manual_cli_branches_created: number;
  manual_cli_commits_created: number;
  manual_cli_branches_pushed: number;
  manual_cli_prs_created: number;
  manual_cli_verified_issues: number;
  manual_cli_releases_started: number;
  manual_cli_prs_merged: number;
  manual_cli_completed_issues: number;
  manual_cli_confirmed_release_facts: number;
  manual_cli_inspect_fields_present: number;
  manual_cli_secret_leaks: number;
  manual_cli_shell_fallbacks: number;
  github_project_items_synced: number;
  github_project_lifecycle_completed: number;
  github_project_status_done: number;
  github_project_pr_urls_synced: number;
  github_project_merge_shas_synced: number;
  github_project_status_mismatches: number;
  github_projection_failures_retryable: number;
  github_projection_failures_do_not_mutate_lifecycle: number;
}

export function emptyManualCliMetrics(): ManualCliMetrics {
  return {
    manual_cli_issues_intaken: 0,
    manual_cli_ready_snapshots: 0,
    manual_cli_dependency_edges_parsed: 0,
    manual_cli_dependency_order_violations: 0,
    manual_cli_owner_leases_claimed: 0,
    manual_cli_root_sessions_started: 0,
    manual_cli_child_runs_started: 0,
    manual_cli_worktrees_created: 0,
    manual_cli_branches_created: 0,
    manual_cli_commits_created: 0,
    manual_cli_branches_pushed: 0,
    manual_cli_prs_created: 0,
    manual_cli_verified_issues: 0,
    manual_cli_releases_started: 0,
    manual_cli_prs_merged: 0,
    manual_cli_completed_issues: 0,
    manual_cli_confirmed_release_facts: 0,
    manual_cli_inspect_fields_present: 0,
    manual_cli_secret_leaks: 0,
    manual_cli_shell_fallbacks: 0,
    github_project_items_synced: 0,
    github_project_lifecycle_completed: 0,
    github_project_status_done: 0,
    github_project_pr_urls_synced: 0,
    github_project_merge_shas_synced: 0,
    github_project_status_mismatches: 0,
    github_projection_failures_retryable: 0,
    github_projection_failures_do_not_mutate_lifecycle: 0,
  };
}

export function formatManualCliSummary(metrics: ManualCliMetrics): string {
  return Object.entries(metrics).map(([key, value]) => `${key}=${value}`).join(" ");
}

export function assertManualCliMetrics(metrics: ManualCliMetrics): void {
  const failures: string[] = [];
  if (metrics.manual_cli_issues_intaken < 1) failures.push("manual_cli_issues_intaken >= 1");
  if (metrics.manual_cli_ready_snapshots < 1) failures.push("manual_cli_ready_snapshots >= 1");
  if (metrics.manual_cli_owner_leases_claimed < 3) failures.push("manual_cli_owner_leases_claimed >= 3");
  if (metrics.manual_cli_root_sessions_started < 3) failures.push("manual_cli_root_sessions_started >= 3");
  if (metrics.manual_cli_child_runs_started < 2) failures.push("manual_cli_child_runs_started >= 2");
  if (metrics.manual_cli_prs_created < 1) failures.push("manual_cli_prs_created >= 1");
  if (metrics.manual_cli_prs_merged < 1) failures.push("manual_cli_prs_merged >= 1");
  if (metrics.manual_cli_completed_issues < 1) failures.push("manual_cli_completed_issues >= 1");
  if (metrics.manual_cli_confirmed_release_facts < 1) failures.push("manual_cli_confirmed_release_facts >= 1");
  if (metrics.manual_cli_inspect_fields_present < 8) failures.push("manual_cli_inspect_fields_present >= 8");
  if (metrics.manual_cli_secret_leaks !== 0) failures.push("manual_cli_secret_leaks = 0");
  if (metrics.manual_cli_shell_fallbacks !== 0) failures.push("manual_cli_shell_fallbacks = 0");
  if (failures.length > 0) throw new Error(`Manual CLI metrics failed: ${failures.join("; ")}`);
}

export interface ErrorRecoveryMetrics {
  orchestrator_quarantined_detected: number;
  orchestrator_resume_attempts: number;
  orchestrator_retryable_effects_recorded: number;
  orchestrator_terminal_failures_recorded: number;
  orchestrator_completed_reversals: number;
}

export type RecoveryFact =
  | "quarantined"
  | "resume_attempted"
  | "retryable_effect"
  | "terminal_failure"
  | "completed_preserved"
  | "completed_reversed";

export function emptyErrorRecoveryMetrics(): ErrorRecoveryMetrics {
  return {
    orchestrator_quarantined_detected: 0,
    orchestrator_resume_attempts: 0,
    orchestrator_retryable_effects_recorded: 0,
    orchestrator_terminal_failures_recorded: 0,
    orchestrator_completed_reversals: 0,
  };
}

export function recordRecoveryFact(metrics: ErrorRecoveryMetrics, fact: RecoveryFact): void {
  switch (fact) {
    case "quarantined":
      metrics.orchestrator_quarantined_detected += 1;
      return;
    case "resume_attempted":
      metrics.orchestrator_resume_attempts += 1;
      return;
    case "retryable_effect":
      metrics.orchestrator_retryable_effects_recorded += 1;
      return;
    case "terminal_failure":
      metrics.orchestrator_terminal_failures_recorded += 1;
      return;
    case "completed_preserved":
      return;
    case "completed_reversed":
      metrics.orchestrator_completed_reversals += 1;
      return;
  }
}

export function formatErrorRecoverySummary(metrics: ErrorRecoveryMetrics): string {
  return Object.entries(metrics).map(([key, value]) => `${key}=${value}`).join(" ");
}

export function assertErrorRecoveryMetrics(metrics: ErrorRecoveryMetrics): void {
  const failures: string[] = [];
  if (metrics.orchestrator_quarantined_detected < 1) failures.push("orchestrator_quarantined_detected >= 1");
  if (metrics.orchestrator_resume_attempts < 1) failures.push("orchestrator_resume_attempts >= 1");
  if (metrics.orchestrator_retryable_effects_recorded < 1) failures.push("orchestrator_retryable_effects_recorded >= 1");
  if (metrics.orchestrator_terminal_failures_recorded < 1) failures.push("orchestrator_terminal_failures_recorded >= 1");
  if (metrics.orchestrator_completed_reversals !== 0) failures.push("orchestrator_completed_reversals = 0");
  if (failures.length > 0) throw new Error(`Error recovery metrics failed: ${failures.join("; ")}`);
}
