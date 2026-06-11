import { emptyFullLiveMetrics, type FullLiveMetrics } from "./metrics.ts";

type ScenarioName = "single" | "sequential" | "parallel";

export interface FullLiveScenarioMetrics {
  single?: FullLiveMetrics;
  sequential?: FullLiveMetrics;
  parallel?: FullLiveMetrics;
}

const recorded: FullLiveScenarioMetrics = {};
const suiteStartedAt = Date.now();

export function recordFullLiveScenarioMetrics(name: ScenarioName, metrics: FullLiveMetrics): void {
  recorded[name] = { ...metrics };
}

export function recordedFullLiveSuiteMetrics(): FullLiveScenarioMetrics {
  return { ...recorded };
}

export function buildRecordedSuiteMetrics(): FullLiveMetrics {
  return buildSuiteMetrics(recorded, Math.ceil((Date.now() - suiteStartedAt) / 1000));
}

export function buildSuiteMetrics(input: FullLiveScenarioMetrics, durationSeconds: number): FullLiveMetrics {
  const metrics = emptyFullLiveMetrics();
  const single = input.single ?? emptyFullLiveMetrics();
  const sequential = input.sequential ?? emptyFullLiveMetrics();
  const parallel = input.parallel ?? emptyFullLiveMetrics();

  metrics.full_live_total_issues_created =
    single.full_live_issues_created +
    sequential.full_live_sequential_issues_created +
    parallel.full_live_parallel_issues_created;
  metrics.full_live_total_completed =
    single.full_live_runtime_issues_completed +
    sequential.full_live_sequential_completed +
    parallel.full_live_parallel_completed;
  metrics.full_live_total_prs_merged =
    single.full_live_prs_merged +
    sequential.full_live_sequential_prs_merged +
    parallel.full_live_parallel_prs_merged;
  metrics.full_live_total_fixture_files_created =
    single.full_live_fixture_files_created +
    sequential.full_live_sequential_fixture_files_created +
    parallel.full_live_parallel_fixture_files_created;
  metrics.full_live_total_failed_releases =
    metrics.full_live_total_issues_created - metrics.full_live_total_completed;
  metrics.full_live_total_secret_leaks =
    single.full_live_secret_leaks +
    sequential.full_live_secret_leaks +
    parallel.full_live_secret_leaks;
  metrics.full_live_total_duration_seconds = durationSeconds;
  return metrics;
}
