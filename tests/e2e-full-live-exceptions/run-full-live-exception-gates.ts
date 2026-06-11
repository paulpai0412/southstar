import { spawnSync } from "node:child_process";
import {
  assertFullLiveExceptionThresholds,
  emptyFullLiveExceptionMetrics,
  formatFullLiveExceptionSummary,
  markFullLiveExceptionRequirementCovered,
  type FullLiveExceptionMetrics,
  type FullLiveExceptionRequirementId,
} from "./metrics.ts";

export interface CommandSpec {
  command: string;
  args: string[];
}

export function buildFullLiveExceptionGateCommands(nodeCommand = process.execPath): CommandSpec[] {
  return [
    { command: nodeCommand, args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-exceptions/github-exceptions.test.ts"] },
    { command: nodeCommand, args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-exceptions/codex-exceptions.test.ts"] },
    { command: nodeCommand, args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-exceptions/recovery-exceptions.test.ts"] },
  ];
}

export function parseFullLiveExceptionSummary(output: string): FullLiveExceptionMetrics {
  const metrics = emptyFullLiveExceptionMetrics();
  const summaryLine = output.split(/\r?\n/).find((line) => line.includes("full_live_exception_requirements_total="));
  if (!summaryLine) return metrics;
  for (const token of summaryLine.trim().replace(/^#\s*/, "").split(/\s+/)) {
    const [key, rawValue = ""] = token.split("=");
    if (key === "covered_requirements") {
      for (const id of rawValue.split(",").filter(Boolean) as FullLiveExceptionRequirementId[]) {
        markFullLiveExceptionRequirementCovered(metrics, id);
      }
      continue;
    }
    if (key === "full_live_exception_scenarios_passed" && rawValue.includes("/")) {
      const [passed, total] = rawValue.split("/");
      metrics.full_live_exception_scenarios_passed = Number(passed);
      metrics.full_live_exception_scenarios_total = Number(total);
      continue;
    }
    if (key in metrics && key !== "covered_requirements" && key !== "covered_ex_mappings") {
      const value = Number(rawValue);
      if (Number.isFinite(value)) {
        (metrics as unknown as Record<string, number>)[key] = value;
      }
    }
  }
  return metrics;
}

if (process.argv[1]?.endsWith("run-full-live-exception-gates.ts")) {
  if (process.env.NORTHSTAR_FULL_LIVE_EXCEPTIONS !== "1") {
    console.log("# SKIP Set NORTHSTAR_FULL_LIVE_EXCEPTIONS=1 to run full live exception E2E.");
    process.exit(0);
  }
  const started = Date.now();
  const outputs: string[] = [];
  for (const spec of buildFullLiveExceptionGateCommands()) {
    const result = spawnSync(spec.command, spec.args, { encoding: "utf8", shell: false });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    outputs.push(result.stdout ?? "", result.stderr ?? "");
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
  const aggregate = emptyFullLiveExceptionMetrics();
  for (const output of outputs) {
    const parsed = parseFullLiveExceptionSummary(output);
    for (const id of parsed.covered_requirements) markFullLiveExceptionRequirementCovered(aggregate, id);
    aggregate.full_live_exception_scenarios_total += parsed.full_live_exception_scenarios_total;
    aggregate.full_live_exception_scenarios_passed += parsed.full_live_exception_scenarios_passed;
    aggregate.full_live_exception_live_github_cases += parsed.full_live_exception_live_github_cases;
    aggregate.full_live_exception_live_codex_cases += parsed.full_live_exception_live_codex_cases;
    aggregate.full_live_exception_fault_injection_cases += parsed.full_live_exception_fault_injection_cases;
    aggregate.full_live_exception_recovery_completed_cases += parsed.full_live_exception_recovery_completed_cases;
    aggregate.full_live_exception_prs_created += parsed.full_live_exception_prs_created;
    aggregate.full_live_exception_prs_merged += parsed.full_live_exception_prs_merged;
    aggregate.full_live_exception_real_merge_conflicts += parsed.full_live_exception_real_merge_conflicts;
    aggregate.full_live_exception_retryable_failures += parsed.full_live_exception_retryable_failures;
    aggregate.full_live_exception_quarantined_cases += parsed.full_live_exception_quarantined_cases;
    aggregate.full_live_exception_resume_successes += parsed.full_live_exception_resume_successes;
    aggregate.full_live_exception_terminal_failures += parsed.full_live_exception_terminal_failures;
    aggregate.full_live_exception_cleanup_failures_recorded += parsed.full_live_exception_cleanup_failures_recorded;
    aggregate.full_live_exception_secret_leaks += parsed.full_live_exception_secret_leaks;
    aggregate.full_live_exception_unclosed_failed_issues += parsed.full_live_exception_unclosed_failed_issues;
    aggregate.full_live_exception_failed_branch_cleanup_attempts += parsed.full_live_exception_failed_branch_cleanup_attempts;
  }
  aggregate.full_live_exception_duration_seconds = Math.ceil((Date.now() - started) / 1000);
  console.log(`# ${formatFullLiveExceptionSummary(aggregate)}`);
  assertFullLiveExceptionThresholds(aggregate);
}
