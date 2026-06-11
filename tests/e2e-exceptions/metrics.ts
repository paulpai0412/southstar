export type ExceptionRequirementId =
  | "EX-01"
  | "EX-02"
  | "EX-03"
  | "EX-04"
  | "EX-05"
  | "EX-06"
  | "EX-07"
  | "EX-08"
  | "EX-09"
  | "EX-10"
  | "EX-11"
  | "EX-12"
  | "EX-13"
  | "EX-14";

const requirementIds: ExceptionRequirementId[] = [
  "EX-01",
  "EX-02",
  "EX-03",
  "EX-04",
  "EX-05",
  "EX-06",
  "EX-07",
  "EX-08",
  "EX-09",
  "EX-10",
  "EX-11",
  "EX-12",
  "EX-13",
  "EX-14",
];

export interface ExceptionE2EMetrics {
  exception_e2e_requirements_total: number;
  exception_e2e_requirements_covered: number;
  exception_e2e_requirement_coverage_percent: number;
  exception_e2e_scenarios_total: number;
  exception_e2e_scenarios_passed: number;
  exception_e2e_quarantined_cases: number;
  exception_e2e_failed_cases: number;
  exception_e2e_recovery_cases: number;
  exception_e2e_resume_rejections: number;
  exception_e2e_retryable_failures: number;
  exception_e2e_terminal_failures: number;
  exception_e2e_artifact_rejections: number;
  exception_e2e_repair_admin_actions: number;
  exception_e2e_duplicate_child_runs: number;
  exception_e2e_secret_leaks: number;
  exception_e2e_network_calls: number;
  exception_e2e_live_credential_reads: number;
  covered_requirements: ExceptionRequirementId[];
}

export function emptyExceptionE2EMetrics(): ExceptionE2EMetrics {
  return {
    exception_e2e_requirements_total: requirementIds.length,
    exception_e2e_requirements_covered: 0,
    exception_e2e_requirement_coverage_percent: 0,
    exception_e2e_scenarios_total: 0,
    exception_e2e_scenarios_passed: 0,
    exception_e2e_quarantined_cases: 0,
    exception_e2e_failed_cases: 0,
    exception_e2e_recovery_cases: 0,
    exception_e2e_resume_rejections: 0,
    exception_e2e_retryable_failures: 0,
    exception_e2e_terminal_failures: 0,
    exception_e2e_artifact_rejections: 0,
    exception_e2e_repair_admin_actions: 0,
    exception_e2e_duplicate_child_runs: 0,
    exception_e2e_secret_leaks: 0,
    exception_e2e_network_calls: 0,
    exception_e2e_live_credential_reads: 0,
    covered_requirements: [],
  };
}

export function markRequirementCovered(
  metrics: ExceptionE2EMetrics,
  id: ExceptionRequirementId,
): void {
  if (!metrics.covered_requirements.includes(id)) {
    metrics.covered_requirements.push(id);
  }
  metrics.exception_e2e_requirements_covered = metrics.covered_requirements.length;
  metrics.exception_e2e_requirement_coverage_percent = Math.floor(
    (metrics.exception_e2e_requirements_covered / metrics.exception_e2e_requirements_total) * 100,
  );
}

export function formatExceptionE2ESummary(metrics: ExceptionE2EMetrics): string {
  return [
    `exception_e2e_requirements_total=${metrics.exception_e2e_requirements_total}`,
    `exception_e2e_requirements_covered=${metrics.exception_e2e_requirements_covered}`,
    `exception_e2e_requirement_coverage_percent=${metrics.exception_e2e_requirement_coverage_percent}`,
    `exception_e2e_scenarios_passed=${metrics.exception_e2e_scenarios_passed}/${metrics.exception_e2e_scenarios_total}`,
    `exception_e2e_quarantined_cases=${metrics.exception_e2e_quarantined_cases}`,
    `exception_e2e_failed_cases=${metrics.exception_e2e_failed_cases}`,
    `exception_e2e_recovery_cases=${metrics.exception_e2e_recovery_cases}`,
    `exception_e2e_resume_rejections=${metrics.exception_e2e_resume_rejections}`,
    `exception_e2e_retryable_failures=${metrics.exception_e2e_retryable_failures}`,
    `exception_e2e_terminal_failures=${metrics.exception_e2e_terminal_failures}`,
    `exception_e2e_artifact_rejections=${metrics.exception_e2e_artifact_rejections}`,
    `exception_e2e_repair_admin_actions=${metrics.exception_e2e_repair_admin_actions}`,
    `exception_e2e_duplicate_child_runs=${metrics.exception_e2e_duplicate_child_runs}`,
    `exception_e2e_secret_leaks=${metrics.exception_e2e_secret_leaks}`,
    `exception_e2e_network_calls=${metrics.exception_e2e_network_calls}`,
    `exception_e2e_live_credential_reads=${metrics.exception_e2e_live_credential_reads}`,
  ].join(" ");
}

export function hasExceptionE2ESecretLeak(value: string): boolean {
  return /authorization:\s*bearer|gho_[A-Za-z0-9_]+|github[_-]?token\s*[:=]|api[_-]?key\s*[:=]|secret\s*[:=]|sk-[A-Za-z0-9_-]+/i.test(
    value,
  );
}
