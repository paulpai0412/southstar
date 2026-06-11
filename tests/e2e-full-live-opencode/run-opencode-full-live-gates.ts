import { spawnSync } from "node:child_process";
import {
  assertOpenCodeExceptionThresholds,
  assertOpenCodeFullLiveThresholds,
  emptyOpenCodeExceptionMetrics,
  formatOpenCodeExceptionSummary,
  markOpenCodeExceptionRequirementCovered,
  parseOpenCodeExceptionSummary,
  parseOpenCodeFullLiveSummary,
} from "./metrics.ts";

export interface CommandSpec {
  command: string;
  args: string[];
}

export function buildOpenCodeFullLiveGateCommands(nodeCommand = process.execPath): CommandSpec[] {
  return [
    { command: nodeCommand, args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-opencode/opencode-full-live.test.ts"] },
    { command: nodeCommand, args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-opencode/opencode-exceptions.test.ts"] },
  ];
}

if (process.argv[1]?.endsWith("run-opencode-full-live-gates.ts")) {
  if (process.env.NORTHSTAR_FULL_LIVE_OPENCODE !== "1") {
    console.log("# SKIP Set NORTHSTAR_FULL_LIVE_OPENCODE=1 to run OpenCode full live E2E.");
    process.exit(0);
  }

  const started = Date.now();
  const outputs: string[] = [];
  for (const spec of buildOpenCodeFullLiveGateCommands()) {
    const result = spawnSync(spec.command, spec.args, { encoding: "utf8", shell: false });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    outputs.push(result.stdout ?? "", result.stderr ?? "");
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }

  const happyOutput = outputs.find((output) => output.includes("opencode_full_live_issues_created=")) ?? "";
  const happy = parseOpenCodeFullLiveSummary(happyOutput);
  assertOpenCodeFullLiveThresholds(happy);

  const aggregate = emptyOpenCodeExceptionMetrics();
  for (const output of outputs) {
    const parsed = parseOpenCodeExceptionSummary(output);
    for (const id of parsed.covered_requirements) {
      markOpenCodeExceptionRequirementCovered(aggregate, id);
    }
    aggregate.opencode_exception_scenarios_total += parsed.opencode_exception_scenarios_total;
    aggregate.opencode_exception_scenarios_passed += parsed.opencode_exception_scenarios_passed;
    aggregate.opencode_exception_sdk_boundary_cases += parsed.opencode_exception_sdk_boundary_cases;
    aggregate.opencode_exception_fault_injection_cases += parsed.opencode_exception_fault_injection_cases;
    aggregate.opencode_exception_retryable_failures += parsed.opencode_exception_retryable_failures;
    aggregate.opencode_exception_quarantined_cases += parsed.opencode_exception_quarantined_cases;
    aggregate.opencode_exception_resume_successes += parsed.opencode_exception_resume_successes;
    aggregate.opencode_exception_recovery_completed_cases += parsed.opencode_exception_recovery_completed_cases;
    aggregate.opencode_exception_terminal_failures += parsed.opencode_exception_terminal_failures;
    aggregate.opencode_exception_shell_fallbacks += parsed.opencode_exception_shell_fallbacks;
    aggregate.opencode_exception_secret_leaks += parsed.opencode_exception_secret_leaks;
  }
  aggregate.opencode_exception_duration_seconds = Math.ceil((Date.now() - started) / 1000);
  console.log(`# ${formatOpenCodeExceptionSummary(aggregate)}`);
  assertOpenCodeExceptionThresholds(aggregate);
}
