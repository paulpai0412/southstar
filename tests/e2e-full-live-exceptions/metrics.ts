export type FullLiveExceptionRequirementId =
  | "FLX-01" | "FLX-02" | "FLX-03" | "FLX-04" | "FLX-05" | "FLX-06"
  | "FLX-07" | "FLX-08" | "FLX-09" | "FLX-10" | "FLX-11" | "FLX-12"
  | "FLX-13" | "FLX-14" | "FLX-15" | "FLX-16" | "FLX-17" | "FLX-18";

export type OfflineExceptionRequirementId =
  | "EX-01" | "EX-02" | "EX-03" | "EX-04" | "EX-05" | "EX-06" | "EX-07"
  | "EX-08" | "EX-09" | "EX-10" | "EX-11" | "EX-12" | "EX-13" | "EX-14";

const requirementIds: FullLiveExceptionRequirementId[] = [
  "FLX-01", "FLX-02", "FLX-03", "FLX-04", "FLX-05", "FLX-06",
  "FLX-07", "FLX-08", "FLX-09", "FLX-10", "FLX-11", "FLX-12",
  "FLX-13", "FLX-14", "FLX-15", "FLX-16", "FLX-17", "FLX-18",
];

const offlineExIds: OfflineExceptionRequirementId[] = [
  "EX-01", "EX-02", "EX-03", "EX-04", "EX-05", "EX-06", "EX-07",
  "EX-08", "EX-09", "EX-10", "EX-11", "EX-12", "EX-13", "EX-14",
];

const exMappings: Record<FullLiveExceptionRequirementId, OfflineExceptionRequirementId[]> = {
  "FLX-01": ["EX-12"],
  "FLX-02": ["EX-12"],
  "FLX-03": ["EX-13"],
  "FLX-04": ["EX-13"],
  "FLX-05": ["EX-13"],
  "FLX-06": ["EX-13", "EX-14"],
  "FLX-07": ["EX-10", "EX-11"],
  "FLX-08": ["EX-10"],
  "FLX-09": ["EX-09"],
  "FLX-10": ["EX-07"],
  "FLX-11": ["EX-07"],
  "FLX-12": ["EX-07", "EX-08", "EX-10"],
  "FLX-13": ["EX-01", "EX-02"],
  "FLX-14": ["EX-03", "EX-04", "EX-05", "EX-06"],
  "FLX-15": ["EX-13"],
  "FLX-16": ["EX-14"],
  "FLX-17": ["EX-13", "EX-14"],
  "FLX-18": ["EX-12", "EX-13"],
};

export interface FullLiveExceptionMetrics {
  full_live_exception_requirements_total: number;
  full_live_exception_requirements_covered: number;
  full_live_exception_requirement_coverage_percent: number;
  full_live_exception_ex_mappings_total: number;
  full_live_exception_ex_mappings_covered: number;
  full_live_exception_ex_mapping_percent: number;
  full_live_exception_scenarios_total: number;
  full_live_exception_scenarios_passed: number;
  full_live_exception_live_github_cases: number;
  full_live_exception_live_codex_cases: number;
  full_live_exception_fault_injection_cases: number;
  full_live_exception_recovery_completed_cases: number;
  full_live_exception_prs_created: number;
  full_live_exception_prs_merged: number;
  full_live_exception_real_merge_conflicts: number;
  full_live_exception_retryable_failures: number;
  full_live_exception_quarantined_cases: number;
  full_live_exception_resume_successes: number;
  full_live_exception_terminal_failures: number;
  full_live_exception_cleanup_failures_recorded: number;
  full_live_exception_secret_leaks: number;
  full_live_exception_unclosed_failed_issues: number;
  full_live_exception_failed_branch_cleanup_attempts: number;
  full_live_exception_duration_seconds: number;
  covered_requirements: FullLiveExceptionRequirementId[];
  covered_ex_mappings: OfflineExceptionRequirementId[];
}

const numericMetricKeys = [
  "full_live_exception_requirements_total",
  "full_live_exception_requirements_covered",
  "full_live_exception_requirement_coverage_percent",
  "full_live_exception_ex_mappings_total",
  "full_live_exception_ex_mappings_covered",
  "full_live_exception_ex_mapping_percent",
  "full_live_exception_scenarios_total",
  "full_live_exception_scenarios_passed",
  "full_live_exception_live_github_cases",
  "full_live_exception_live_codex_cases",
  "full_live_exception_fault_injection_cases",
  "full_live_exception_recovery_completed_cases",
  "full_live_exception_prs_created",
  "full_live_exception_prs_merged",
  "full_live_exception_real_merge_conflicts",
  "full_live_exception_retryable_failures",
  "full_live_exception_quarantined_cases",
  "full_live_exception_resume_successes",
  "full_live_exception_terminal_failures",
  "full_live_exception_cleanup_failures_recorded",
  "full_live_exception_secret_leaks",
  "full_live_exception_unclosed_failed_issues",
  "full_live_exception_failed_branch_cleanup_attempts",
  "full_live_exception_duration_seconds",
] as const satisfies ReadonlyArray<keyof Omit<FullLiveExceptionMetrics, "covered_requirements" | "covered_ex_mappings">>;

export function emptyFullLiveExceptionMetrics(): FullLiveExceptionMetrics {
  return {
    ...Object.fromEntries(numericMetricKeys.map((key) => [key, 0])),
    full_live_exception_requirements_total: requirementIds.length,
    full_live_exception_ex_mappings_total: offlineExIds.length,
    covered_requirements: [],
    covered_ex_mappings: [],
  } as FullLiveExceptionMetrics;
}

export function markFullLiveExceptionRequirementCovered(
  metrics: FullLiveExceptionMetrics,
  id: FullLiveExceptionRequirementId,
): void {
  if (!metrics.covered_requirements.includes(id)) {
    metrics.covered_requirements.push(id);
  }
  for (const ex of exMappings[id]) {
    if (!metrics.covered_ex_mappings.includes(ex)) {
      metrics.covered_ex_mappings.push(ex);
    }
  }
  refreshCoverage(metrics);
}

export function mergeFullLiveExceptionMetrics(layers: FullLiveExceptionMetrics[], durationSeconds: number): FullLiveExceptionMetrics {
  const merged = emptyFullLiveExceptionMetrics();
  for (const layer of layers) {
    for (const key of numericMetricKeys) {
      if (
        key !== "full_live_exception_requirements_total" &&
        key !== "full_live_exception_requirements_covered" &&
        key !== "full_live_exception_requirement_coverage_percent" &&
        key !== "full_live_exception_ex_mappings_total" &&
        key !== "full_live_exception_ex_mappings_covered" &&
        key !== "full_live_exception_ex_mapping_percent" &&
        key !== "full_live_exception_duration_seconds"
      ) {
        merged[key] += layer[key];
      }
    }
    for (const id of layer.covered_requirements) markFullLiveExceptionRequirementCovered(merged, id);
  }
  merged.full_live_exception_duration_seconds = durationSeconds;
  merged.full_live_exception_secret_leaks = layers.reduce((sum, layer) => sum + layer.full_live_exception_secret_leaks, 0);
  return merged;
}

export function formatFullLiveExceptionSummary(metrics: FullLiveExceptionMetrics): string {
  return [
    ...numericMetricKeys.map((key) => {
      if (key === "full_live_exception_scenarios_passed") {
        return `${key}=${metrics.full_live_exception_scenarios_passed}/${metrics.full_live_exception_scenarios_total}`;
      }
      return `${key}=${metrics[key]}`;
    }),
    `covered_requirements=${metrics.covered_requirements.join(",")}`,
    `covered_ex_mappings=${metrics.covered_ex_mappings.join(",")}`,
  ].join(" ");
}

export function assertFullLiveExceptionThresholds(metrics: FullLiveExceptionMetrics): void {
  const failures: string[] = [];
  if (metrics.full_live_exception_requirements_total !== 18) failures.push("full_live_exception_requirements_total must equal 18");
  if (metrics.full_live_exception_requirements_covered < 16) failures.push("full_live_exception_requirements_covered must be >= 16");
  if (metrics.full_live_exception_requirement_coverage_percent < 88) failures.push("full_live_exception_requirement_coverage_percent must be >= 88");
  if (metrics.full_live_exception_ex_mappings_total < 14) failures.push("full_live_exception_ex_mappings_total must be >= 14");
  if (metrics.full_live_exception_ex_mappings_covered < 12) failures.push("full_live_exception_ex_mappings_covered must be >= 12");
  if (metrics.full_live_exception_ex_mapping_percent < 85) failures.push("full_live_exception_ex_mapping_percent must be >= 85");
  if (metrics.full_live_exception_scenarios_passed !== metrics.full_live_exception_scenarios_total) failures.push("all full live exception scenarios must pass");
  if (metrics.full_live_exception_live_github_cases < 6) failures.push("full_live_exception_live_github_cases must be >= 6");
  if (metrics.full_live_exception_live_codex_cases < 3) failures.push("full_live_exception_live_codex_cases must be >= 3");
  if (metrics.full_live_exception_fault_injection_cases < 4) failures.push("full_live_exception_fault_injection_cases must be >= 4");
  if (metrics.full_live_exception_recovery_completed_cases < 4) failures.push("full_live_exception_recovery_completed_cases must be >= 4");
  if (metrics.full_live_exception_prs_created < 4) failures.push("full_live_exception_prs_created must be >= 4");
  if (metrics.full_live_exception_prs_merged < 4) failures.push("full_live_exception_prs_merged must be >= 4");
  if (metrics.full_live_exception_real_merge_conflicts !== 1) failures.push("full_live_exception_real_merge_conflicts must equal 1");
  if (metrics.full_live_exception_retryable_failures < 5) failures.push("full_live_exception_retryable_failures must be >= 5");
  if (metrics.full_live_exception_quarantined_cases < 1) failures.push("full_live_exception_quarantined_cases must be >= 1");
  if (metrics.full_live_exception_resume_successes < 1) failures.push("full_live_exception_resume_successes must be >= 1");
  if (metrics.full_live_exception_terminal_failures < 1) failures.push("full_live_exception_terminal_failures must be >= 1");
  if (metrics.full_live_exception_cleanup_failures_recorded < 1) failures.push("full_live_exception_cleanup_failures_recorded must be >= 1");
  if (metrics.full_live_exception_secret_leaks !== 0) failures.push("full_live_exception_secret_leaks must equal 0");
  if (metrics.full_live_exception_unclosed_failed_issues !== 0) failures.push("full_live_exception_unclosed_failed_issues must equal 0");
  if (metrics.full_live_exception_failed_branch_cleanup_attempts < 1) failures.push("full_live_exception_failed_branch_cleanup_attempts must be >= 1");
  if (metrics.full_live_exception_duration_seconds > 2400) failures.push("full_live_exception_duration_seconds must be <= 2400");
  if (failures.length > 0) throw new Error(`Full live exception E2E thresholds failed: ${failures.join("; ")}`);
}

export function hasFullLiveExceptionSecretLeak(value: string): boolean {
  return /authorization:\s*bearer|gho_[A-Za-z0-9_]+|github[_-]?token\s*[:=]|api[_-]?key\s*[:=]|secret\s*[:=]|sk-[A-Za-z0-9_-]+/i.test(value);
}

function refreshCoverage(metrics: FullLiveExceptionMetrics): void {
  metrics.full_live_exception_requirements_covered = metrics.covered_requirements.length;
  metrics.full_live_exception_requirement_coverage_percent = Math.floor(
    (metrics.full_live_exception_requirements_covered / metrics.full_live_exception_requirements_total) * 100,
  );
  metrics.full_live_exception_ex_mappings_covered = metrics.covered_ex_mappings.length;
  metrics.full_live_exception_ex_mapping_percent = Math.floor(
    (metrics.full_live_exception_ex_mappings_covered / metrics.full_live_exception_ex_mappings_total) * 100,
  );
}
