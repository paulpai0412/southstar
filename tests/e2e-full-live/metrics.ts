export interface FullLiveMetrics {
  full_live_issues_created: number;
  full_live_runtime_issues_completed: number;
  full_live_codex_root_sessions_started: number;
  full_live_codex_child_runs_started: number;
  full_live_branches_pushed: number;
  full_live_prs_created: number;
  full_live_prs_merged: number;
  full_live_confirmed_merge_facts: number;
  full_live_fixture_files_created: number;
  full_live_fixture_content_matches: number;
  full_live_github_issues_closed: number;
  full_live_secret_leaks: number;
  full_live_single_duration_seconds: number;
  full_live_sequential_issues_created: number;
  full_live_sequential_completed: number;
  full_live_sequential_prs_created: number;
  full_live_sequential_prs_merged: number;
  full_live_sequential_ordering_violations: number;
  full_live_sequential_max_active_issue_workers: number;
  full_live_sequential_fixture_files_created: number;
  full_live_sequential_cross_issue_contamination: number;
  full_live_sequential_duration_seconds: number;
  full_live_parallel_issues_created: number;
  full_live_parallel_completed: number;
  full_live_parallel_prs_created: number;
  full_live_parallel_prs_merged: number;
  full_live_parallel_overlap_seconds: number;
  full_live_parallel_max_active_issue_workers: number;
  full_live_parallel_fixture_files_created: number;
  full_live_parallel_cross_issue_contamination: number;
  full_live_parallel_merge_conflicts: number;
  full_live_parallel_duration_seconds: number;
  full_live_total_issues_created: number;
  full_live_total_completed: number;
  full_live_total_prs_merged: number;
  full_live_total_fixture_files_created: number;
  full_live_total_failed_releases: number;
  full_live_total_secret_leaks: number;
  full_live_total_duration_seconds: number;
}

const metricKeys = [
  "full_live_issues_created",
  "full_live_runtime_issues_completed",
  "full_live_codex_root_sessions_started",
  "full_live_codex_child_runs_started",
  "full_live_branches_pushed",
  "full_live_prs_created",
  "full_live_prs_merged",
  "full_live_confirmed_merge_facts",
  "full_live_fixture_files_created",
  "full_live_fixture_content_matches",
  "full_live_github_issues_closed",
  "full_live_secret_leaks",
  "full_live_single_duration_seconds",
  "full_live_sequential_issues_created",
  "full_live_sequential_completed",
  "full_live_sequential_prs_created",
  "full_live_sequential_prs_merged",
  "full_live_sequential_ordering_violations",
  "full_live_sequential_max_active_issue_workers",
  "full_live_sequential_fixture_files_created",
  "full_live_sequential_cross_issue_contamination",
  "full_live_sequential_duration_seconds",
  "full_live_parallel_issues_created",
  "full_live_parallel_completed",
  "full_live_parallel_prs_created",
  "full_live_parallel_prs_merged",
  "full_live_parallel_overlap_seconds",
  "full_live_parallel_max_active_issue_workers",
  "full_live_parallel_fixture_files_created",
  "full_live_parallel_cross_issue_contamination",
  "full_live_parallel_merge_conflicts",
  "full_live_parallel_duration_seconds",
  "full_live_total_issues_created",
  "full_live_total_completed",
  "full_live_total_prs_merged",
  "full_live_total_fixture_files_created",
  "full_live_total_failed_releases",
  "full_live_total_secret_leaks",
  "full_live_total_duration_seconds",
] as const satisfies ReadonlyArray<keyof FullLiveMetrics>;

export function emptyFullLiveMetrics(): FullLiveMetrics {
  return Object.fromEntries(metricKeys.map((key) => [key, 0])) as unknown as FullLiveMetrics;
}

export function formatFullLiveSummary(metrics: FullLiveMetrics): string {
  return metricKeys.map((key) => `${key}=${metrics[key]}`).join(" ");
}

export function hasFullLiveSecretLeak(value: string): boolean {
  return /authorization:\s*bearer|gho_[A-Za-z0-9_]+|github[_-]?token\s*[:=]|api[_-]?key\s*[:=]|secret\s*[:=]|sk-[A-Za-z0-9_-]+/i.test(value);
}
