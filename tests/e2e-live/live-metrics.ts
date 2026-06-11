export interface LiveE2EMetrics {
  github_temporary_issues_created: number;
  github_labels_synced: number;
  github_comments_synced: number;
  github_project_items_synced: number;
  github_issues_closed: number;
  github_retryable_projection_failures: number;
  github_live_cleanup_errors: number;
  sdk_packages_loaded: number;
  sdk_root_sessions_started: number;
  sdk_background_children_started: number;
  sdk_status_reads: number;
  sdk_shell_fallbacks: number;
  sdk_live_timeouts: number;
  sdk_live_duration_seconds: number;
}

export function emptyLiveE2EMetrics(): LiveE2EMetrics {
  return {
    github_temporary_issues_created: 0,
    github_labels_synced: 0,
    github_comments_synced: 0,
    github_project_items_synced: 0,
    github_issues_closed: 0,
    github_retryable_projection_failures: 0,
    github_live_cleanup_errors: 0,
    sdk_packages_loaded: 0,
    sdk_root_sessions_started: 0,
    sdk_background_children_started: 0,
    sdk_status_reads: 0,
    sdk_shell_fallbacks: 0,
    sdk_live_timeouts: 0,
    sdk_live_duration_seconds: 0,
  };
}

export function formatLiveSummary(metrics: LiveE2EMetrics): string {
  return [
    `github_temporary_issues_created=${metrics.github_temporary_issues_created}`,
    `github_labels_synced=${metrics.github_labels_synced}`,
    `github_comments_synced=${metrics.github_comments_synced}`,
    `github_project_items_synced=${metrics.github_project_items_synced}`,
    `github_issues_closed=${metrics.github_issues_closed}`,
    `github_retryable_projection_failures=${metrics.github_retryable_projection_failures}`,
    `github_live_cleanup_errors=${metrics.github_live_cleanup_errors}`,
    `sdk_packages_loaded=${metrics.sdk_packages_loaded}/2`,
    `sdk_root_sessions_started=${metrics.sdk_root_sessions_started}/2`,
    `sdk_background_children_started=${metrics.sdk_background_children_started}/2`,
    `sdk_status_reads=${metrics.sdk_status_reads}`,
    `sdk_shell_fallbacks=${metrics.sdk_shell_fallbacks}`,
    `sdk_live_timeouts=${metrics.sdk_live_timeouts}`,
    `sdk_live_duration_seconds=${metrics.sdk_live_duration_seconds}`,
  ].join(" ");
}
