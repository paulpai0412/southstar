export type OpenCodeExceptionRequirementId =
  | "OCX-01" | "OCX-02" | "OCX-03" | "OCX-04" | "OCX-05" | "OCX-06" | "OCX-07"
  | "OCX-08" | "OCX-09" | "OCX-10" | "OCX-11" | "OCX-12" | "OCX-13" | "OCX-14";

const exceptionRequirementIds: OpenCodeExceptionRequirementId[] = [
  "OCX-01", "OCX-02", "OCX-03", "OCX-04", "OCX-05", "OCX-06", "OCX-07",
  "OCX-08", "OCX-09", "OCX-10", "OCX-11", "OCX-12", "OCX-13", "OCX-14",
];

export interface OpenCodeFullLiveMetrics {
  opencode_full_live_issues_created: number;
  opencode_full_live_root_sessions_started: number;
  opencode_full_live_child_runs_started: number;
  opencode_full_live_prs_created: number;
  opencode_full_live_prs_merged: number;
  opencode_full_live_runtime_completed: number;
  opencode_full_live_confirmed_merge_facts: number;
  opencode_full_live_fixture_files_created: number;
  opencode_full_live_fixture_content_matches: number;
  opencode_full_live_github_issues_closed: number;
  opencode_full_live_shell_fallbacks: number;
  opencode_full_live_secret_leaks: number;
  opencode_full_live_duration_seconds: number;
}

export interface OpenCodeExceptionMetrics {
  opencode_exception_requirements_total: number;
  opencode_exception_requirements_covered: number;
  opencode_exception_requirement_coverage_percent: number;
  opencode_exception_scenarios_total: number;
  opencode_exception_scenarios_passed: number;
  opencode_exception_sdk_boundary_cases: number;
  opencode_exception_fault_injection_cases: number;
  opencode_exception_retryable_failures: number;
  opencode_exception_quarantined_cases: number;
  opencode_exception_resume_successes: number;
  opencode_exception_recovery_completed_cases: number;
  opencode_exception_terminal_failures: number;
  opencode_exception_shell_fallbacks: number;
  opencode_exception_secret_leaks: number;
  opencode_exception_duration_seconds: number;
  covered_requirements: OpenCodeExceptionRequirementId[];
}

const fullLiveKeys = [
  "opencode_full_live_issues_created",
  "opencode_full_live_root_sessions_started",
  "opencode_full_live_child_runs_started",
  "opencode_full_live_prs_created",
  "opencode_full_live_prs_merged",
  "opencode_full_live_runtime_completed",
  "opencode_full_live_confirmed_merge_facts",
  "opencode_full_live_fixture_files_created",
  "opencode_full_live_fixture_content_matches",
  "opencode_full_live_github_issues_closed",
  "opencode_full_live_shell_fallbacks",
  "opencode_full_live_secret_leaks",
  "opencode_full_live_duration_seconds",
] as const satisfies ReadonlyArray<keyof OpenCodeFullLiveMetrics>;

const exceptionNumericKeys = [
  "opencode_exception_requirements_total",
  "opencode_exception_requirements_covered",
  "opencode_exception_requirement_coverage_percent",
  "opencode_exception_scenarios_total",
  "opencode_exception_scenarios_passed",
  "opencode_exception_sdk_boundary_cases",
  "opencode_exception_fault_injection_cases",
  "opencode_exception_retryable_failures",
  "opencode_exception_quarantined_cases",
  "opencode_exception_resume_successes",
  "opencode_exception_recovery_completed_cases",
  "opencode_exception_terminal_failures",
  "opencode_exception_shell_fallbacks",
  "opencode_exception_secret_leaks",
  "opencode_exception_duration_seconds",
] as const satisfies ReadonlyArray<keyof Omit<OpenCodeExceptionMetrics, "covered_requirements">>;

export function emptyOpenCodeFullLiveMetrics(): OpenCodeFullLiveMetrics {
  return Object.fromEntries(fullLiveKeys.map((key) => [key, 0])) as unknown as OpenCodeFullLiveMetrics;
}

export function emptyOpenCodeExceptionMetrics(): OpenCodeExceptionMetrics {
  return {
    ...Object.fromEntries(exceptionNumericKeys.map((key) => [key, 0])),
    opencode_exception_requirements_total: exceptionRequirementIds.length,
    covered_requirements: [],
  } as OpenCodeExceptionMetrics;
}

export function markOpenCodeExceptionRequirementCovered(metrics: OpenCodeExceptionMetrics, id: OpenCodeExceptionRequirementId): void {
  if (!metrics.covered_requirements.includes(id)) {
    metrics.covered_requirements.push(id);
  }
  metrics.opencode_exception_requirements_covered = metrics.covered_requirements.length;
  metrics.opencode_exception_requirement_coverage_percent = Math.floor(
    (metrics.opencode_exception_requirements_covered / metrics.opencode_exception_requirements_total) * 100,
  );
}

export function formatOpenCodeFullLiveSummary(metrics: OpenCodeFullLiveMetrics): string {
  return fullLiveKeys.map((key) => `${key}=${metrics[key]}`).join(" ");
}

export function formatOpenCodeExceptionSummary(metrics: OpenCodeExceptionMetrics): string {
  return [
    ...exceptionNumericKeys.map((key) => {
      if (key === "opencode_exception_scenarios_passed") {
        return `${key}=${metrics.opencode_exception_scenarios_passed}/${metrics.opencode_exception_scenarios_total}`;
      }
      return `${key}=${metrics[key]}`;
    }),
    `covered_requirements=${metrics.covered_requirements.join(",")}`,
  ].join(" ");
}

export function parseOpenCodeFullLiveSummary(output: string): OpenCodeFullLiveMetrics {
  const metrics = emptyOpenCodeFullLiveMetrics();
  const summaryLine = output.split(/\r?\n/).find((line) => line.includes("opencode_full_live_issues_created="));
  if (!summaryLine) return metrics;
  for (const token of summaryLine.trim().replace(/^#\s*/, "").split(/\s+/)) {
    const [key, rawValue = ""] = token.split("=");
    if ((fullLiveKeys as readonly string[]).includes(key)) {
      (metrics as unknown as Record<string, number>)[key] = Number(rawValue);
    }
  }
  return metrics;
}

export function parseOpenCodeExceptionSummary(output: string): OpenCodeExceptionMetrics {
  const metrics = emptyOpenCodeExceptionMetrics();
  const summaryLine = output.split(/\r?\n/).find((line) => line.includes("opencode_exception_requirements_total="));
  if (!summaryLine) return metrics;
  for (const token of summaryLine.trim().replace(/^#\s*/, "").split(/\s+/)) {
    const [key, rawValue = ""] = token.split("=");
    if (key === "covered_requirements") {
      for (const id of rawValue.split(",").filter(Boolean) as OpenCodeExceptionRequirementId[]) {
        markOpenCodeExceptionRequirementCovered(metrics, id);
      }
      continue;
    }
    if (key === "opencode_exception_scenarios_passed" && rawValue.includes("/")) {
      const [passed, total] = rawValue.split("/");
      metrics.opencode_exception_scenarios_passed = Number(passed);
      metrics.opencode_exception_scenarios_total = Number(total);
      continue;
    }
    if ((exceptionNumericKeys as readonly string[]).includes(key)) {
      (metrics as unknown as Record<string, number>)[key] = Number(rawValue);
    }
  }
  return metrics;
}

export function assertOpenCodeFullLiveThresholds(metrics: OpenCodeFullLiveMetrics): void {
  const failures: string[] = [];
  if (metrics.opencode_full_live_issues_created !== 1) failures.push("opencode_full_live_issues_created must equal 1");
  if (metrics.opencode_full_live_root_sessions_started < 1) failures.push("opencode_full_live_root_sessions_started must be >= 1");
  if (metrics.opencode_full_live_child_runs_started < 2) failures.push("opencode_full_live_child_runs_started must be >= 2");
  if (metrics.opencode_full_live_prs_created !== 1) failures.push("opencode_full_live_prs_created must equal 1");
  if (metrics.opencode_full_live_prs_merged !== 1) failures.push("opencode_full_live_prs_merged must equal 1");
  if (metrics.opencode_full_live_runtime_completed !== 1) failures.push("opencode_full_live_runtime_completed must equal 1");
  if (metrics.opencode_full_live_confirmed_merge_facts !== 1) failures.push("opencode_full_live_confirmed_merge_facts must equal 1");
  if (metrics.opencode_full_live_fixture_files_created !== 1) failures.push("opencode_full_live_fixture_files_created must equal 1");
  if (metrics.opencode_full_live_fixture_content_matches !== 1) failures.push("opencode_full_live_fixture_content_matches must equal 1");
  if (metrics.opencode_full_live_github_issues_closed !== 1) failures.push("opencode_full_live_github_issues_closed must equal 1");
  if (metrics.opencode_full_live_shell_fallbacks !== 0) failures.push("opencode_full_live_shell_fallbacks must equal 0");
  if (metrics.opencode_full_live_secret_leaks !== 0) failures.push("opencode_full_live_secret_leaks must equal 0");
  if (metrics.opencode_full_live_duration_seconds > 900) failures.push("opencode_full_live_duration_seconds must be <= 900");
  if (failures.length > 0) throw new Error(`OpenCode full live thresholds failed: ${failures.join("; ")}`);
}

export function assertOpenCodeExceptionThresholds(metrics: OpenCodeExceptionMetrics): void {
  const failures: string[] = [];
  if (metrics.opencode_exception_requirements_total !== 14) failures.push("opencode_exception_requirements_total must equal 14");
  if (metrics.opencode_exception_requirements_covered < 12) failures.push("opencode_exception_requirements_covered must be >= 12");
  if (metrics.opencode_exception_requirement_coverage_percent < 85) failures.push("opencode_exception_requirement_coverage_percent must be >= 85");
  if (metrics.opencode_exception_scenarios_passed !== metrics.opencode_exception_scenarios_total) failures.push("all OpenCode exception scenarios must pass");
  if (metrics.opencode_exception_sdk_boundary_cases < 4) failures.push("opencode_exception_sdk_boundary_cases must be >= 4");
  if (metrics.opencode_exception_fault_injection_cases < 5) failures.push("opencode_exception_fault_injection_cases must be >= 5");
  if (metrics.opencode_exception_retryable_failures < 3) failures.push("opencode_exception_retryable_failures must be >= 3");
  if (metrics.opencode_exception_quarantined_cases < 1) failures.push("opencode_exception_quarantined_cases must be >= 1");
  if (metrics.opencode_exception_resume_successes < 1) failures.push("opencode_exception_resume_successes must be >= 1");
  if (metrics.opencode_exception_recovery_completed_cases < 2) failures.push("opencode_exception_recovery_completed_cases must be >= 2");
  if (metrics.opencode_exception_terminal_failures < 1) failures.push("opencode_exception_terminal_failures must be >= 1");
  if (metrics.opencode_exception_shell_fallbacks !== 0) failures.push("opencode_exception_shell_fallbacks must equal 0");
  if (metrics.opencode_exception_secret_leaks !== 0) failures.push("opencode_exception_secret_leaks must equal 0");
  if (metrics.opencode_exception_duration_seconds > 1800) failures.push("opencode_exception_duration_seconds must be <= 1800");
  if (failures.length > 0) throw new Error(`OpenCode exception thresholds failed: ${failures.join("; ")}`);
}

export function hasOpenCodeSecretLeak(value: string): boolean {
  return /authorization:\s*bearer|gho_[A-Za-z0-9_]+|github[_-]?token\s*[:=]|api[_-]?key\s*[:=]|secret\s*[:=]|sk-[A-Za-z0-9_-]+/i.test(value);
}
