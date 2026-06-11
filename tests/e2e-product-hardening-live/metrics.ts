export interface ProductHardeningMetrics {
  live_issues_created: number;
  live_completed_issues: number;
  live_prs_merged: number;
  live_project_lifecycle_completed: number;
  live_project_status_done: number;
  live_parallel_active_issue_workers: number;
  parallel_overlap_seconds: number;
  dependency_order_violations: number;
  github_project_status_mismatches: number;
  live_browser_tests_passed: number;
  live_secret_leaks: number;
  live_smoke_only: number;
  fake_production_path_used: number;
}

const metricKeys = [
  "live_issues_created",
  "live_completed_issues",
  "live_prs_merged",
  "live_project_lifecycle_completed",
  "live_project_status_done",
  "live_parallel_active_issue_workers",
  "parallel_overlap_seconds",
  "dependency_order_violations",
  "github_project_status_mismatches",
  "live_browser_tests_passed",
  "live_secret_leaks",
  "live_smoke_only",
  "fake_production_path_used",
] as const satisfies ReadonlyArray<keyof ProductHardeningMetrics>;

export function emptyProductHardeningMetrics(): ProductHardeningMetrics {
  return {
    ...Object.fromEntries(metricKeys.map((key) => [key, 0])),
    live_smoke_only: 1,
  } as unknown as ProductHardeningMetrics;
}

export function formatProductHardeningSummary(metrics: ProductHardeningMetrics): string {
  return metricKeys.map((key) => `${key}=${metrics[key]}`).join(" ");
}

export function assertProductHardeningMetrics(metrics: ProductHardeningMetrics): void {
  assertAtLeast(metrics, "live_issues_created", 5);
  assertAtLeast(metrics, "live_completed_issues", 5);
  assertAtLeast(metrics, "live_prs_merged", 5);
  assertAtLeast(metrics, "live_project_lifecycle_completed", 5);
  assertAtLeast(metrics, "live_project_status_done", 5);
  assertAtLeast(metrics, "live_parallel_active_issue_workers", 2);
  assertAtLeast(metrics, "parallel_overlap_seconds", 1);
  assertEquals(metrics, "dependency_order_violations", 0);
  assertEquals(metrics, "github_project_status_mismatches", 0);
  assertAtLeast(metrics, "live_browser_tests_passed", 1);
  assertEquals(metrics, "live_secret_leaks", 0);
  assertEquals(metrics, "live_smoke_only", 0);
  assertEquals(metrics, "fake_production_path_used", 0);
}

export function finalizeProductHardeningMetrics(
  metrics: ProductHardeningMetrics,
  gates: {
    runtimeFlowComplete: boolean;
    projectReadBackComplete: boolean;
    browserEvidenceComplete: boolean;
    runtimeHistoryMetricsComplete: boolean;
  },
): ProductHardeningMetrics {
  if (
    !gates.runtimeFlowComplete ||
    !gates.projectReadBackComplete ||
    !gates.browserEvidenceComplete ||
    !gates.runtimeHistoryMetricsComplete
  ) {
    metrics.live_smoke_only = 1;
    throw new Error("live_smoke_only cannot be cleared until runtime flow, Project read-back, browser evidence, and runtime history metrics complete");
  }
  metrics.live_smoke_only = 0;
  return metrics;
}

function assertAtLeast(metrics: ProductHardeningMetrics, key: keyof ProductHardeningMetrics, expected: number): void {
  if (metrics[key] < expected) {
    throw new Error(`${key} must be >= ${expected}; got ${metrics[key]}`);
  }
}

function assertEquals(metrics: ProductHardeningMetrics, key: keyof ProductHardeningMetrics, expected: number): void {
  if (metrics[key] !== expected) {
    throw new Error(`${key} must equal ${expected}; got ${metrics[key]}`);
  }
}
