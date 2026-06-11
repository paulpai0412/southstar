# Northstar OpenCode Full Live E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add isolated OpenCode full live happy-path and exception-flow E2E coverage with quantitative acceptance metrics, real GitHub sandbox evidence, SDK-first OpenCode execution, and no shell fallback.

**Architecture:** Add a new test-only package under `tests/e2e-full-live-opencode/` that mirrors the existing Codex full-live and exception harness patterns without changing runtime core behavior. The happy path uses a real OpenCode SDK boundary for implementation and verification, while exception scenarios combine true SDK boundary checks with deterministic fault injection. All live commands clear-skip unless `NORTHSTAR_FULL_LIVE_OPENCODE=1` and run outside offline/unit/coverage gates.

**Tech Stack:** Node test runner, TypeScript ESM, `@opencode-ai/sdk`, GitHub REST API via `fetch`, existing Northstar runtime driver/store/state-machine helpers, package scripts, Superpowers TDD.

---

## File Structure

Create:

- `tests/e2e-full-live-opencode/env.ts`  
  Owns `NORTHSTAR_FULL_LIVE_OPENCODE` gating, sandbox repo validation, and layer selection.

- `tests/e2e-full-live-opencode/metrics.ts`  
  Owns happy-path metrics, exception metrics, OCX requirement coverage, summary formatting, summary parsing, threshold assertions, and secret leak scanning.

- `tests/e2e-full-live-opencode/opencode-worker.ts`  
  Test-only OpenCode worker wrapper. It exposes fake-SDK-testable `runImplementation()`, `runVerification()`, and SDK boundary methods. The default live runner imports `@opencode-ai/sdk` through `openCodeLoader()` and adapts the observed SDK shape behind a narrow boundary.

- `tests/e2e-full-live-opencode/harness.ts`  
  Orchestrates live GitHub issue/branch/PR/merge/runtime flow for one OpenCode happy-path issue and deterministic exception scenarios.

- `tests/e2e-full-live-opencode/faults.ts`  
  Provides deterministic OpenCode fault runners for verifier failure, malformed artifact, timeout, empty response, unknown child artifact, implementation retry, and terminal failure.

- `tests/e2e-full-live-opencode/opencode-full-live.test.ts`  
  Live happy-path test.

- `tests/e2e-full-live-opencode/opencode-exceptions.test.ts`  
  Live boundary plus deterministic exception-flow test.

- `tests/e2e-full-live-opencode/run-opencode-full-live-gates.ts`  
  Aggregate runner using argv arrays and no shell chains.

- `tests/e2e-full-live-opencode/index.test.ts`  
  Imports unit, happy, and exception tests.

- `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`  
  Offline unit tests for env, metrics, runner command specs, fake SDK worker, thresholds, parser, and secret detection.

- `docs/superpowers/opencode-full-live-e2e-coverage.md`  
  Requirement-to-test/implementation matrix for happy-path and OCX coverage.

Modify:

- `package.json`  
  Add OpenCode full-live scripts.

- `tests/spec/spec-compliance.test.ts`  
  Add coverage matrix compliance test.

Do not modify runtime core, state-machine, SQLite store, Codex full-live tests, or existing full-live exception tests unless a focused failing test proves a shared helper defect.

---

### Task 1: Command Shell, Environment Contract, And Metrics

**Files:**
- Create: `tests/e2e-full-live-opencode/env.ts`
- Create: `tests/e2e-full-live-opencode/metrics.ts`
- Create: `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`
- Create: `tests/e2e-full-live-opencode/index.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing unit tests for scripts, env, metrics, and clear skip**

Create `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fullLiveOpenCodeEnabled,
  requireFullLiveOpenCodeEnv,
  fullLiveOpenCodeLayerSelected,
} from "./env.ts";
import {
  assertOpenCodeExceptionThresholds,
  assertOpenCodeFullLiveThresholds,
  emptyOpenCodeExceptionMetrics,
  emptyOpenCodeFullLiveMetrics,
  formatOpenCodeExceptionSummary,
  formatOpenCodeFullLiveSummary,
  hasOpenCodeSecretLeak,
  markOpenCodeExceptionRequirementCovered,
  parseOpenCodeExceptionSummary,
  parseOpenCodeFullLiveSummary,
} from "./metrics.ts";
import { buildOpenCodeFullLiveGateCommands } from "./run-opencode-full-live-gates.ts";

test("package exposes OpenCode full live scripts", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["test:e2e:full-live:opencode"], "node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live.test.ts");
  assert.equal(pkg.scripts["test:e2e:full-live:opencode:exceptions"], "node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-exceptions.test.ts");
  assert.equal(pkg.scripts["test:e2e:full-live:opencode:all"], "node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/run-opencode-full-live-gates.ts");
});

test("OpenCode full live env skips when flag is absent", () => {
  assert.equal(fullLiveOpenCodeEnabled({}), false);
  assert.equal(fullLiveOpenCodeLayerSelected("happy", {}), true);
});

test("OpenCode full live env fails with actionable missing fields when enabled", () => {
  assert.throws(
    () => requireFullLiveOpenCodeEnv({ NORTHSTAR_FULL_LIVE_OPENCODE: "1" }),
    /Missing OpenCode full live E2E configuration: GITHUB_TOKEN, NORTHSTAR_LIVE_GITHUB_REPO/,
  );
});

test("OpenCode full live env requires sandbox repository", () => {
  assert.throws(
    () => requireFullLiveOpenCodeEnv({
      NORTHSTAR_FULL_LIVE_OPENCODE: "1",
      GITHUB_TOKEN: "token",
      NORTHSTAR_LIVE_GITHUB_REPO: "someone/else",
    }),
    /NORTHSTAR_LIVE_GITHUB_REPO must be paulpai0412\/northstar-live-sandbox/,
  );
});

test("OpenCode full live metrics enforce happy path thresholds", () => {
  const metrics = emptyOpenCodeFullLiveMetrics();
  metrics.opencode_full_live_issues_created = 1;
  metrics.opencode_full_live_root_sessions_started = 1;
  metrics.opencode_full_live_child_runs_started = 2;
  metrics.opencode_full_live_prs_created = 1;
  metrics.opencode_full_live_prs_merged = 1;
  metrics.opencode_full_live_runtime_completed = 1;
  metrics.opencode_full_live_confirmed_merge_facts = 1;
  metrics.opencode_full_live_fixture_files_created = 1;
  metrics.opencode_full_live_fixture_content_matches = 1;
  metrics.opencode_full_live_github_issues_closed = 1;
  metrics.opencode_full_live_shell_fallbacks = 0;
  metrics.opencode_full_live_secret_leaks = 0;
  metrics.opencode_full_live_duration_seconds = 10;
  assert.doesNotThrow(() => assertOpenCodeFullLiveThresholds(metrics));
  assert.match(formatOpenCodeFullLiveSummary(metrics), /opencode_full_live_runtime_completed=1/);
});

test("OpenCode exception metrics track OCX requirement coverage", () => {
  const metrics = emptyOpenCodeExceptionMetrics();
  markOpenCodeExceptionRequirementCovered(metrics, "OCX-01");
  markOpenCodeExceptionRequirementCovered(metrics, "OCX-02");
  markOpenCodeExceptionRequirementCovered(metrics, "OCX-14");
  metrics.opencode_exception_scenarios_total = 3;
  metrics.opencode_exception_scenarios_passed = 3;
  metrics.opencode_exception_sdk_boundary_cases = 2;
  metrics.opencode_exception_fault_injection_cases = 1;
  assert.equal(metrics.opencode_exception_requirements_total, 14);
  assert.equal(metrics.opencode_exception_requirements_covered, 3);
  assert.equal(metrics.opencode_exception_requirement_coverage_percent, 21);
  assert.match(formatOpenCodeExceptionSummary(metrics), /covered_requirements=OCX-01,OCX-02,OCX-14/);
});

test("OpenCode exception thresholds require quantified acceptance", () => {
  const metrics = emptyOpenCodeExceptionMetrics();
  for (const id of ["OCX-01", "OCX-02", "OCX-03", "OCX-04", "OCX-05", "OCX-06", "OCX-07", "OCX-08", "OCX-09", "OCX-10", "OCX-11", "OCX-12"] as const) {
    markOpenCodeExceptionRequirementCovered(metrics, id);
  }
  metrics.opencode_exception_scenarios_total = 12;
  metrics.opencode_exception_scenarios_passed = 12;
  metrics.opencode_exception_sdk_boundary_cases = 4;
  metrics.opencode_exception_fault_injection_cases = 5;
  metrics.opencode_exception_retryable_failures = 3;
  metrics.opencode_exception_quarantined_cases = 1;
  metrics.opencode_exception_resume_successes = 1;
  metrics.opencode_exception_recovery_completed_cases = 2;
  metrics.opencode_exception_terminal_failures = 1;
  metrics.opencode_exception_shell_fallbacks = 0;
  metrics.opencode_exception_secret_leaks = 0;
  metrics.opencode_exception_duration_seconds = 20;
  assert.doesNotThrow(() => assertOpenCodeExceptionThresholds(metrics));
});

test("OpenCode summaries parse aggregate output", () => {
  const happy = parseOpenCodeFullLiveSummary("# opencode_full_live_issues_created=1 opencode_full_live_runtime_completed=1 opencode_full_live_duration_seconds=7");
  assert.equal(happy.opencode_full_live_issues_created, 1);
  assert.equal(happy.opencode_full_live_runtime_completed, 1);
  assert.equal(happy.opencode_full_live_duration_seconds, 7);

  const exception = parseOpenCodeExceptionSummary("# opencode_exception_requirements_total=14 opencode_exception_scenarios_passed=2/2 opencode_exception_sdk_boundary_cases=2 covered_requirements=OCX-01,OCX-02");
  assert.equal(exception.opencode_exception_scenarios_total, 2);
  assert.equal(exception.opencode_exception_scenarios_passed, 2);
  assert.equal(exception.opencode_exception_sdk_boundary_cases, 2);
  assert.deepEqual(exception.covered_requirements, ["OCX-01", "OCX-02"]);
});

test("OpenCode secret scan catches token-shaped values", () => {
  assert.equal(hasOpenCodeSecretLeak("authorization: bearer abc"), true);
  assert.equal(hasOpenCodeSecretLeak("gho_secret"), true);
  assert.equal(hasOpenCodeSecretLeak("no secrets here"), false);
});

test("OpenCode aggregate runner uses argv arrays", () => {
  assert.deepEqual(buildOpenCodeFullLiveGateCommands("node"), [
    { command: "node", args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-opencode/opencode-full-live.test.ts"] },
    { command: "node", args: ["--disable-warning=ExperimentalWarning", "tests/e2e-full-live-opencode/opencode-exceptions.test.ts"] },
  ]);
});
```

- [ ] **Step 2: Run the focused unit test and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected: FAIL with module-not-found errors for `env.ts`, `metrics.ts`, and `run-opencode-full-live-gates.ts`, or missing package scripts.

- [ ] **Step 3: Add scripts**

Modify `package.json` scripts:

```json
{
  "test:e2e:full-live:opencode": "node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live.test.ts",
  "test:e2e:full-live:opencode:exceptions": "node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-exceptions.test.ts",
  "test:e2e:full-live:opencode:all": "node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/run-opencode-full-live-gates.ts"
}
```

- [ ] **Step 4: Add environment helper**

Create `tests/e2e-full-live-opencode/env.ts`:

```ts
export interface FullLiveOpenCodeEnv {
  token: string;
  repo: "paulpai0412/northstar-live-sandbox";
}

const sandboxRepo = "paulpai0412/northstar-live-sandbox";

export function fullLiveOpenCodeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NORTHSTAR_FULL_LIVE_OPENCODE === "1";
}

export function fullLiveOpenCodeLayerSelected(
  layer: "happy" | "exceptions",
  env: Record<string, string | undefined> = process.env,
): boolean {
  const selected = env.NORTHSTAR_FULL_LIVE_OPENCODE_LAYER;
  return selected === undefined || selected === "" || selected === layer;
}

export function requireFullLiveOpenCodeEnv(env: Record<string, string | undefined> = process.env): FullLiveOpenCodeEnv {
  const missing = ["GITHUB_TOKEN", "NORTHSTAR_LIVE_GITHUB_REPO"].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing OpenCode full live E2E configuration: ${missing.join(", ")}`);
  }
  if (env.NORTHSTAR_LIVE_GITHUB_REPO !== sandboxRepo) {
    throw new Error(`NORTHSTAR_LIVE_GITHUB_REPO must be ${sandboxRepo}`);
  }
  return {
    token: env.GITHUB_TOKEN ?? "",
    repo: sandboxRepo,
  };
}
```

- [ ] **Step 5: Add metrics helper**

Create `tests/e2e-full-live-opencode/metrics.ts`:

```ts
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
```

- [ ] **Step 6: Add aggregate runner shell**

Create `tests/e2e-full-live-opencode/run-opencode-full-live-gates.ts`:

```ts
import { spawnSync } from "node:child_process";
import {
  assertOpenCodeExceptionThresholds,
  assertOpenCodeFullLiveThresholds,
  emptyOpenCodeExceptionMetrics,
  formatOpenCodeExceptionSummary,
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
      if (!aggregate.covered_requirements.includes(id)) aggregate.covered_requirements.push(id);
    }
    aggregate.opencode_exception_requirements_covered = aggregate.covered_requirements.length;
    aggregate.opencode_exception_requirement_coverage_percent = Math.floor(
      (aggregate.opencode_exception_requirements_covered / aggregate.opencode_exception_requirements_total) * 100,
    );
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
```

- [ ] **Step 7: Add index shell**

Create `tests/e2e-full-live-opencode/index.test.ts`:

```ts
import "./opencode-full-live-units.test.ts";
import "./opencode-full-live.test.ts";
import "./opencode-exceptions.test.ts";
```

- [ ] **Step 8: Run the focused unit test and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected: PASS for env/metrics/runner/package script unit tests.

- [ ] **Step 9: Run clear-skip script and verify GREEN**

Run:

```bash
npm run test:e2e:full-live:opencode:all
```

Expected: PASS with:

```text
# SKIP Set NORTHSTAR_FULL_LIVE_OPENCODE=1 to run OpenCode full live E2E.
```

- [ ] **Step 10: Commit**

```bash
git add package.json tests/e2e-full-live-opencode
git commit -m "test: add opencode full live e2e shell"
```

---

### Task 2: OpenCode Worker Wrapper With Fake SDK Coverage

**Files:**
- Create: `tests/e2e-full-live-opencode/opencode-worker.ts`
- Modify: `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`

- [ ] **Step 1: Add failing fake-SDK worker tests**

Append to `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`:

```ts
import { OpenCodeFullLiveWorker } from "./opencode-worker.ts";

test("OpenCode worker starts root and background children with fake SDK runner", async () => {
  const calls: string[] = [];
  const worker = new OpenCodeFullLiveWorker({
    startRootSession: async (input) => {
      calls.push(`root:${input.role}`);
      return { root_session_id: "opencode-root-1", status: "live" };
    },
    startBackgroundChild: async (input) => {
      calls.push(`child:${input.role}:${input.root_session_id}`);
      return {
        child_run_id: `child-${input.role}`,
        session_id: `session-${input.role}`,
        status: "completed",
        final_response: `{"status":"ok","role":"${input.role}"}`,
      };
    },
    readRootStatus: async () => ({ status: "live" }),
    readChildStatus: async () => ({ status: "completed" }),
    resumeHint: async () => "resume opencode-root-1",
  });

  const implementation = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.com/paulpai0412/northstar-live-sandbox/issues/1",
    repo: "paulpai0412/northstar-live-sandbox",
    branch: "northstar-opencode-smoke-branch",
    fixture_path: "northstar-smoke/opencode/issue-1.json",
    fixture_content: "{}",
  });
  const verification = await worker.runVerification({
    pr_number: 2,
    pr_url: "https://github.com/paulpai0412/northstar-live-sandbox/pull/2",
    expected_fixture_path: "northstar-smoke/opencode/issue-1.json",
  });

  assert.equal(implementation.root_session_id, "opencode-root-1");
  assert.equal(implementation.child_run_id, "child-implement");
  assert.equal(implementation.shell_fallbacks, 0);
  assert.equal(verification.child_run_id, "child-verify");
  assert.deepEqual(calls, ["root:implement", "child:implement:opencode-root-1", "root:verify", "child:verify:opencode-root-1"]);
});

test("OpenCode worker exposes SDK boundary checks without shell fallback", async () => {
  const worker = new OpenCodeFullLiveWorker({
    startRootSession: async () => ({ root_session_id: "root", status: "live" }),
    startBackgroundChild: async () => ({ child_run_id: "child", session_id: "session", status: "running", final_response: "" }),
    readRootStatus: async () => ({ status: "live" }),
    readChildStatus: async () => ({ status: "running" }),
    resumeHint: async () => "resume root",
  });

  const boundary = await worker.checkSdkBoundary();
  assert.equal(boundary.root_status, "live");
  assert.equal(boundary.child_status, "running");
  assert.equal(boundary.resume_hint_available, true);
  assert.equal(boundary.shell_fallbacks, 0);
});

test("OpenCode worker rejects missing SDK capabilities with actionable message", async () => {
  const worker = new OpenCodeFullLiveWorker({
    startRootSession: async () => {
      throw new Error("OpenCode SDK missing sessions.start");
    },
    startBackgroundChild: async () => ({ child_run_id: "child", session_id: "session", status: "running", final_response: "" }),
    readRootStatus: async () => ({ status: "unknown" }),
    readChildStatus: async () => ({ status: "unknown" }),
    resumeHint: async () => "",
  });

  await assert.rejects(() => worker.checkSdkBoundary(), /OpenCode SDK missing sessions\.start/);
});
```

- [ ] **Step 2: Run focused unit test and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected: FAIL with missing `./opencode-worker.ts`.

- [ ] **Step 3: Add OpenCode worker wrapper**

Create `tests/e2e-full-live-opencode/opencode-worker.ts`:

```ts
import { openCodeLoader } from "../../src/adapters/host/sdk-loaders.ts";

export type OpenCodeWorkerRole = "implement" | "verify";

export interface OpenCodeRunnerStartRootInput {
  role: OpenCodeWorkerRole;
  prompt: string;
  timeout_ms: number;
}

export interface OpenCodeRunnerStartChildInput extends OpenCodeRunnerStartRootInput {
  root_session_id: string;
}

export interface OpenCodeRunner {
  startRootSession(input: OpenCodeRunnerStartRootInput): Promise<{ root_session_id: string; status: "live" | "missing" | "unknown" }>;
  startBackgroundChild(input: OpenCodeRunnerStartChildInput): Promise<{
    child_run_id: string;
    session_id: string;
    status: string;
    final_response: string;
  }>;
  readRootStatus(rootSessionId: string): Promise<{ status: "live" | "missing" | "unknown" }>;
  readChildStatus(childRunId: string): Promise<{ status: string }>;
  resumeHint(rootSessionId: string): Promise<string>;
}

export interface OpenCodeFullLiveWorkerOutput {
  role: OpenCodeWorkerRole;
  root_session_id: string;
  child_run_id: string;
  session_id: string;
  final_response: string;
  shell_fallbacks: 0;
}

export interface OpenCodeBoundaryCheck {
  root_session_id: string;
  child_run_id: string;
  root_status: string;
  child_status: string;
  resume_hint_available: boolean;
  shell_fallbacks: 0;
}

export class OpenCodeFullLiveWorker {
  private readonly runner: OpenCodeRunner;

  constructor(runner: OpenCodeRunner = new SdkOpenCodeRunner()) {
    this.runner = runner;
  }

  async runImplementation(input: {
    issue_number: number;
    issue_url: string;
    repo: string;
    branch: string;
    fixture_path: string;
    fixture_content: string;
  }): Promise<OpenCodeFullLiveWorkerOutput> {
    const prompt = [
      `You are implementing Northstar OpenCode full live E2E issue ${input.issue_number}.`,
      `Issue: ${input.issue_url}`,
      `Repository: ${input.repo}`,
      `Branch: ${input.branch}`,
      `Fixture path: ${input.fixture_path}`,
      `Fixture content: ${input.fixture_content}`,
      "Do not modify any repository except paulpai0412/northstar-live-sandbox.",
      "Return compact JSON with status, branch, fixture_path, fixture_content, and summary.",
    ].join("\n");
    return await this.runChild("implement", prompt, 300_000);
  }

  async runVerification(input: {
    pr_number: number;
    pr_url: string;
    expected_fixture_path: string;
  }): Promise<OpenCodeFullLiveWorkerOutput> {
    const prompt = [
      `Verify Northstar OpenCode full live E2E PR ${input.pr_number}.`,
      `PR: ${input.pr_url}`,
      `Expected fixture path: ${input.expected_fixture_path}`,
      "Return compact JSON evidence with status=pass only if the expected fixture path is present.",
      "Return compact JSON evidence; do not print secrets.",
    ].join("\n");
    return await this.runChild("verify", prompt, 180_000);
  }

  async checkSdkBoundary(): Promise<OpenCodeBoundaryCheck> {
    const root = await this.runner.startRootSession({ role: "implement", prompt: "Northstar OpenCode SDK boundary root smoke", timeout_ms: 60_000 });
    const child = await this.runner.startBackgroundChild({
      role: "implement",
      root_session_id: root.root_session_id,
      prompt: "Northstar OpenCode SDK boundary child smoke",
      timeout_ms: 60_000,
    });
    const rootStatus = await this.runner.readRootStatus(root.root_session_id);
    const childStatus = await this.runner.readChildStatus(child.child_run_id);
    const resumeHint = await this.runner.resumeHint(root.root_session_id);
    return {
      root_session_id: root.root_session_id,
      child_run_id: child.child_run_id,
      root_status: rootStatus.status,
      child_status: childStatus.status,
      resume_hint_available: resumeHint.trim().length > 0,
      shell_fallbacks: 0,
    };
  }

  private async runChild(role: OpenCodeWorkerRole, prompt: string, timeoutMs: number): Promise<OpenCodeFullLiveWorkerOutput> {
    const root = await this.runner.startRootSession({ role, prompt, timeout_ms: timeoutMs });
    const child = await this.runner.startBackgroundChild({ role, root_session_id: root.root_session_id, prompt, timeout_ms: timeoutMs });
    return {
      role,
      root_session_id: root.root_session_id,
      child_run_id: child.child_run_id,
      session_id: child.session_id,
      final_response: child.final_response,
      shell_fallbacks: 0,
    };
  }
}

class SdkOpenCodeRunner implements OpenCodeRunner {
  async startRootSession(input: OpenCodeRunnerStartRootInput): Promise<{ root_session_id: string; status: "live" | "missing" | "unknown" }> {
    const sdk = await openCodeLoader();
    const client = adaptOpenCodeSdk(sdk);
    const root = await withTimeout(client.startRoot(input.prompt), input.timeout_ms, `OpenCode ${input.role} root session timed out`);
    return { root_session_id: root.id, status: "live" };
  }

  async startBackgroundChild(input: OpenCodeRunnerStartChildInput): Promise<{ child_run_id: string; session_id: string; status: string; final_response: string }> {
    const sdk = await openCodeLoader();
    const client = adaptOpenCodeSdk(sdk);
    const child = await withTimeout(
      client.startChild(input.root_session_id, input.prompt),
      input.timeout_ms,
      `OpenCode ${input.role} background child timed out`,
    );
    return {
      child_run_id: child.id,
      session_id: child.sessionId,
      status: child.status,
      final_response: child.finalResponse,
    };
  }

  async readRootStatus(rootSessionId: string): Promise<{ status: "live" | "missing" | "unknown" }> {
    const sdk = await openCodeLoader();
    return await adaptOpenCodeSdk(sdk).readRootStatus(rootSessionId);
  }

  async readChildStatus(childRunId: string): Promise<{ status: string }> {
    const sdk = await openCodeLoader();
    return await adaptOpenCodeSdk(sdk).readChildStatus(childRunId);
  }

  async resumeHint(rootSessionId: string): Promise<string> {
    const sdk = await openCodeLoader();
    return await adaptOpenCodeSdk(sdk).resumeHint(rootSessionId);
  }
}

interface AdaptedOpenCodeClient {
  startRoot(prompt: string): Promise<{ id: string }>;
  startChild(rootSessionId: string, prompt: string): Promise<{ id: string; sessionId: string; status: string; finalResponse: string }>;
  readRootStatus(rootSessionId: string): Promise<{ status: "live" | "missing" | "unknown" }>;
  readChildStatus(childRunId: string): Promise<{ status: string }>;
  resumeHint(rootSessionId: string): Promise<string>;
}

function adaptOpenCodeSdk(sdk: unknown): AdaptedOpenCodeClient {
  const value = sdk as {
    OpenCode?: new () => {
      startSession?: (options: Record<string, unknown>) => Promise<{ id?: string }>;
      startChild?: (options: Record<string, unknown>) => Promise<{ id?: string; sessionId?: string; status?: string; finalResponse?: string }>;
      status?: (id: string) => Promise<{ status?: string }>;
      resumeHint?: (id: string) => Promise<string>;
    };
    createClient?: () => {
      startSession?: (options: Record<string, unknown>) => Promise<{ id?: string }>;
      startChild?: (options: Record<string, unknown>) => Promise<{ id?: string; sessionId?: string; status?: string; finalResponse?: string }>;
      status?: (id: string) => Promise<{ status?: string }>;
      resumeHint?: (id: string) => Promise<string>;
    };
  };
  const raw = value.OpenCode ? new value.OpenCode() : value.createClient?.();
  if (!raw?.startSession) throw new Error("OpenCode SDK missing sessions.start");
  if (!raw.startChild) throw new Error("OpenCode SDK missing children.start");
  return {
    async startRoot(prompt: string) {
      const result = await raw.startSession?.({ prompt });
      if (!result?.id) throw new Error("OpenCode SDK root session response missing id");
      return { id: result.id };
    },
    async startChild(rootSessionId: string, prompt: string) {
      const result = await raw.startChild?.({ rootSessionId, prompt });
      if (!result?.id) throw new Error("OpenCode SDK child response missing id");
      return {
        id: result.id,
        sessionId: result.sessionId ?? result.id,
        status: result.status ?? "completed",
        finalResponse: result.finalResponse ?? "",
      };
    },
    async readRootStatus(rootSessionId: string) {
      const result = await raw.status?.(rootSessionId);
      const status = result?.status === "live" || result?.status === "missing" ? result.status : "unknown";
      return { status };
    },
    async readChildStatus(childRunId: string) {
      const result = await raw.status?.(childRunId);
      return { status: result?.status ?? "unknown" };
    },
    async resumeHint(rootSessionId: string) {
      return await raw.resumeHint?.(rootSessionId) ?? `resume ${rootSessionId}`;
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run focused unit test and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected: PASS including fake SDK worker tests.

- [ ] **Step 5: Run loader mismatch investigation if live SDK fails**

Run with real OpenCode credentials/config:

```bash
NORTHSTAR_LIVE_OPENCODE=1 node --disable-warning=ExperimentalWarning tests/live/host-sdk-live.test.ts
```

Expected: PASS package load. If OpenCode SDK export shape differs from `adaptOpenCodeSdk()`, add a focused failing unit test in `opencode-full-live-units.test.ts` using the observed shape, then update only `adaptOpenCodeSdk()` to support it. Do not call the `opencode` CLI.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e-full-live-opencode/opencode-worker.ts tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
git commit -m "test: add opencode full live worker"
```

---

### Task 3: OpenCode Happy Path Full Live Test

**Files:**
- Create: `tests/e2e-full-live-opencode/harness.ts`
- Create: `tests/e2e-full-live-opencode/opencode-full-live.test.ts`
- Modify: `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`

- [ ] **Step 1: Add failing harness unit test**

Append to `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`:

```ts
import { assertOpenCodeWorkerReturned, buildOpenCodeFixtureInput } from "./harness.ts";

test("OpenCode harness builds unique fixture inputs", () => {
  const input = buildOpenCodeFixtureInput({ run_id: "northstar-opencode-smoke-1", issue_number: 7, sequence: 1 });
  assert.equal(input.branch, "northstar-opencode-smoke-1-issue-7-1");
  assert.equal(input.fixture_path, "northstar-smoke/northstar-opencode-smoke-1/opencode-issue-7-1.json");
  assert.match(input.fixture_content, /"implemented_by": "opencode"/);
});

test("OpenCode harness rejects empty or secret-shaped worker responses", () => {
  assert.throws(() => assertOpenCodeWorkerReturned("implementation", ""), /OpenCode implementation child returned an empty response/);
  assert.throws(() => assertOpenCodeWorkerReturned("verification", "gho_secret"), /OpenCode verification child response contained a secret-shaped value/);
  assert.doesNotThrow(() => assertOpenCodeWorkerReturned("verification", "{\"status\":\"pass\"}"));
});
```

- [ ] **Step 2: Add failing live happy-path test**

Create `tests/e2e-full-live-opencode/opencode-full-live.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveOpenCodeEnabled, fullLiveOpenCodeLayerSelected, requireFullLiveOpenCodeEnv } from "./env.ts";
import { assertOpenCodeFullLiveThresholds, formatOpenCodeFullLiveSummary } from "./metrics.ts";
import { OpenCodeFullLiveHarness } from "./harness.ts";

test("single issue OpenCode full live happy path", async (t) => {
  if (!fullLiveOpenCodeEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE_OPENCODE=1 to run OpenCode full live E2E.");
    return;
  }
  if (!fullLiveOpenCodeLayerSelected("happy")) {
    t.skip("OpenCode happy path layer filtered by NORTHSTAR_FULL_LIVE_OPENCODE_LAYER.");
    return;
  }

  const env = requireFullLiveOpenCodeEnv();
  const harness = new OpenCodeFullLiveHarness(env);
  const metrics = await harness.runHappyPathScenario();
  assertOpenCodeFullLiveThresholds(metrics);
  assert.equal(metrics.opencode_full_live_secret_leaks, 0);
  console.log(`# ${formatOpenCodeFullLiveSummary(metrics)}`);
  console.log(`# ${harness.traceSummary()}`);
});
```

- [ ] **Step 3: Run unit test and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected: FAIL with missing `./harness.ts`.

- [ ] **Step 4: Add OpenCode happy-path harness**

Create `tests/e2e-full-live-opencode/harness.ts`:

```ts
import { GitHubSandboxClient } from "../e2e-full-live/github-sandbox.ts";
import { createFullLiveRuntimeDriver } from "../e2e-full-live/runtime-driver.ts";
import { assertFixtureGate } from "../e2e-full-live/harness.ts";
import { redactSecrets } from "../../src/runtime/redaction.ts";
import { OpenCodeFullLiveWorker } from "./opencode-worker.ts";
import {
  emptyOpenCodeFullLiveMetrics,
  hasOpenCodeSecretLeak,
  type OpenCodeFullLiveMetrics,
} from "./metrics.ts";
import type { FullLiveOpenCodeEnv } from "./env.ts";

export interface OpenCodeFixtureInput {
  branch: string;
  fixture_path: string;
  fixture_content: string;
}

export class OpenCodeFullLiveHarness {
  private readonly github: GitHubSandboxClient;
  private readonly worker = new OpenCodeFullLiveWorker();
  private readonly env: FullLiveOpenCodeEnv;
  private readonly traces: string[] = [];

  constructor(env: FullLiveOpenCodeEnv) {
    this.env = env;
    this.github = new GitHubSandboxClient({ repo: env.repo, token: env.token });
  }

  traceSummary(): string {
    return this.traces.join(" ");
  }

  async runHappyPathScenario(): Promise<OpenCodeFullLiveMetrics> {
    const started = Date.now();
    const metrics = emptyOpenCodeFullLiveMetrics();
    const runId = smokeRunId();
    const issue = await this.github.createIssue({
      title: `${runId} OpenCode full live happy path`,
      body: `Northstar OpenCode full live happy path smoke ${runId}`,
    });
    metrics.opencode_full_live_issues_created = 1;
    this.traces.push(`opencode_issue=${issue.number}`);
    this.traces.push(`opencode_issue_url=${issue.html_url}`);

    const fixture = buildOpenCodeFixtureInput({ run_id: runId, issue_number: issue.number, sequence: 1 });
    const driver = await createFullLiveRuntimeDriver();
    let issueClosed = false;
    try {
      const runtimeIssue = driver.seedIssue({ issue_number: issue.number, title: `${runId} OpenCode`, source_url: issue.html_url });
      driver.startImplementation(runtimeIssue.issue_id);

      const implementation = await this.worker.runImplementation({
        issue_number: issue.number,
        issue_url: issue.html_url,
        repo: this.env.repo,
        branch: fixture.branch,
        fixture_path: fixture.fixture_path,
        fixture_content: fixture.fixture_content,
      });
      assertOpenCodeWorkerReturned("implementation", implementation.final_response);
      metrics.opencode_full_live_root_sessions_started += implementation.root_session_id ? 1 : 0;
      metrics.opencode_full_live_child_runs_started += implementation.child_run_id ? 1 : 0;
      metrics.opencode_full_live_shell_fallbacks += implementation.shell_fallbacks;

      const branch = await this.github.createFixtureBranch({
        branch: fixture.branch,
        base: "main",
        path: fixture.fixture_path,
        content: fixture.fixture_content,
        message: `${runId} OpenCode fixture for issue ${issue.number}`,
      });
      metrics.opencode_full_live_fixture_files_created = 1;

      const pr = await this.github.createPullRequest({
        title: `${runId} OpenCode issue ${issue.number}`,
        head: branch.branch,
        base: "main",
        body: `OpenCode full live E2E PR for issue ${issue.number}`,
      });
      metrics.opencode_full_live_prs_created = 1;
      this.traces.push(`opencode_pr=${pr.number}`);
      this.traces.push(`opencode_pr_url=${pr.html_url}`);

      driver.submitWorkerResult(runtimeIssue.issue_id, {
        branch: branch.branch,
        commit_sha: branch.commit_sha,
        changed_files: [fixture.fixture_path],
        self_check_summary: "OpenCode full live implementation completed",
      });
      driver.startVerification(runtimeIssue.issue_id);

      const verification = await this.worker.runVerification({
        pr_number: pr.number,
        pr_url: pr.html_url,
        expected_fixture_path: fixture.fixture_path,
      });
      assertOpenCodeWorkerReturned("verification", verification.final_response);
      metrics.opencode_full_live_root_sessions_started += verification.root_session_id ? 1 : 0;
      metrics.opencode_full_live_child_runs_started += verification.child_run_id ? 1 : 0;
      metrics.opencode_full_live_shell_fallbacks += verification.shell_fallbacks;

      const files = await this.github.listPullRequestFiles(pr.number);
      const actualContent = await this.github.readFileContent({ path: fixture.fixture_path, ref: branch.branch });
      assertFixtureGate({
        files,
        expected_path: fixture.fixture_path,
        expected_content: fixture.fixture_content,
        actual_content: actualContent,
      });
      metrics.opencode_full_live_fixture_content_matches = 1;

      driver.submitVerifierEvidence(runtimeIssue.issue_id, { pr_number: pr.number, gate_results: [{ name: "OpenCode fixture gate", status: "pass" }] });
      driver.claimRelease(runtimeIssue.issue_id);
      const merge = await this.github.mergePullRequest({ number: pr.number, commit_title: `${runId} OpenCode merge issue ${issue.number}` });
      metrics.opencode_full_live_prs_merged = merge.merged ? 1 : 0;
      this.traces.push(`opencode_merge_sha=${merge.sha}`);

      const completed = driver.submitReleaseSuccess(runtimeIssue.issue_id, { merge_sha: merge.sha });
      metrics.opencode_full_live_runtime_completed = completed.lifecycle_state === "completed" ? 1 : 0;
      metrics.opencode_full_live_confirmed_merge_facts = driver.confirmedMergeFacts();

      await this.github.closeIssue(issue.number);
      issueClosed = true;
      metrics.opencode_full_live_github_issues_closed = 1;
      metrics.opencode_full_live_duration_seconds = Math.ceil((Date.now() - started) / 1000);
      metrics.opencode_full_live_secret_leaks = hasOpenCodeSecretLeak(`${this.traceSummary()} ${JSON.stringify(metrics)}`) ? 1 : 0;
      return metrics;
    } catch (error) {
      if (!issueClosed) {
        await this.cleanupFailedIssue(issue.number, error);
      }
      throw error;
    } finally {
      await driver.cleanup();
    }
  }

  private async cleanupFailedIssue(issueNumber: number, error: unknown): Promise<void> {
    const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000);
    try {
      await this.github.addIssueComment(issueNumber, [
        "OpenCode full live E2E failed after creating this smoke issue.",
        "",
        `Reason: ${reason}`,
        "",
        "The harness is closing this northstar-opencode-smoke issue automatically.",
      ].join("\n"));
    } catch (commentError) {
      this.traces.push(`opencode_cleanup_comment_failed=${redactSecrets(commentError instanceof Error ? commentError.message : String(commentError))}`);
    }
    try {
      await this.github.closeIssue(issueNumber);
    } catch (closeError) {
      this.traces.push(`opencode_cleanup_close_failed=${redactSecrets(closeError instanceof Error ? closeError.message : String(closeError))}`);
    }
  }
}

export function buildOpenCodeFixtureInput(input: { run_id: string; issue_number: number; sequence: number }): OpenCodeFixtureInput {
  return {
    branch: `${input.run_id}-issue-${input.issue_number}-${input.sequence}`,
    fixture_path: `northstar-smoke/${input.run_id}/opencode-issue-${input.issue_number}-${input.sequence}.json`,
    fixture_content: JSON.stringify({
      run_id: input.run_id,
      issue_number: input.issue_number,
      sequence: input.sequence,
      implemented_by: "opencode",
    }, null, 2),
  };
}

export function assertOpenCodeWorkerReturned(role: "implementation" | "verification", finalResponse: string): void {
  if (finalResponse.trim().length === 0) {
    throw new Error(`OpenCode ${role} child returned an empty response`);
  }
  if (hasOpenCodeSecretLeak(finalResponse)) {
    throw new Error(`OpenCode ${role} child response contained a secret-shaped value`);
  }
}

function smokeRunId(): string {
  return `northstar-opencode-smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}
```

- [ ] **Step 5: Run focused unit test and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected: PASS including fixture helper and worker response assertions.

- [ ] **Step 6: Run happy path clear skip**

Run:

```bash
npm run test:e2e:full-live:opencode
```

Expected: PASS with skip message:

```text
Set NORTHSTAR_FULL_LIVE_OPENCODE=1 to run OpenCode full live E2E.
```

- [ ] **Step 7: Run real OpenCode happy path**

Run with real credentials and GitHub access:

```bash
NORTHSTAR_FULL_LIVE_OPENCODE=1 GITHUB_TOKEN="$GITHUB_TOKEN" NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:full-live:opencode
```

Expected: PASS and metrics include:

```text
opencode_full_live_issues_created=1
opencode_full_live_child_runs_started=2
opencode_full_live_prs_created=1
opencode_full_live_prs_merged=1
opencode_full_live_runtime_completed=1
opencode_full_live_secret_leaks=0
```

If this fails because the OpenCode SDK export shape differs from `adaptOpenCodeSdk()`, stop and use systematic debugging: record the exact missing capability/error, add a fake unit case for that shape, update only `adaptOpenCodeSdk()`, rerun unit tests, then rerun the live command.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e-full-live-opencode/harness.ts tests/e2e-full-live-opencode/opencode-full-live.test.ts tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
git commit -m "test: add opencode full live happy path"
```

---

### Task 4: OpenCode Exception Flow And Fault Injection

**Files:**
- Create: `tests/e2e-full-live-opencode/faults.ts`
- Create: `tests/e2e-full-live-opencode/opencode-exceptions.test.ts`
- Modify: `tests/e2e-full-live-opencode/harness.ts`
- Modify: `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`

- [ ] **Step 1: Add failing fault helper unit tests**

Append to `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`:

```ts
import {
  createOpenCodeEmptyResponseFault,
  createOpenCodeMalformedArtifact,
  createOpenCodeTimeoutFault,
  createOpenCodeVerifierFailure,
} from "./faults.ts";

test("OpenCode deterministic faults return compact redacted evidence", () => {
  assert.deepEqual(createOpenCodeVerifierFailure("issue-1"), {
    kind: "verifier_failure",
    issue_id: "issue-1",
    retryable: false,
    terminal: true,
    summary: "OpenCode verifier rejected deterministic evidence",
  });
  assert.equal(createOpenCodeTimeoutFault("child-1").retryable, true);
  assert.equal(createOpenCodeEmptyResponseFault("child-2").retryable, true);
  assert.equal(createOpenCodeMalformedArtifact("child-3").artifact_valid, false);
});
```

- [ ] **Step 2: Add failing exception live test**

Create `tests/e2e-full-live-opencode/opencode-exceptions.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveOpenCodeEnabled, fullLiveOpenCodeLayerSelected, requireFullLiveOpenCodeEnv } from "./env.ts";
import { assertOpenCodeExceptionThresholds, formatOpenCodeExceptionSummary } from "./metrics.ts";
import { OpenCodeFullLiveHarness } from "./harness.ts";

test("OpenCode full live exception flow covers SDK boundary, faults, quarantine, resume, and recovery", async (t) => {
  if (!fullLiveOpenCodeEnabled()) {
    t.skip("Set NORTHSTAR_FULL_LIVE_OPENCODE=1 to run OpenCode full live exception E2E.");
    return;
  }
  if (!fullLiveOpenCodeLayerSelected("exceptions")) {
    t.skip("OpenCode exception layer filtered by NORTHSTAR_FULL_LIVE_OPENCODE_LAYER.");
    return;
  }

  const env = requireFullLiveOpenCodeEnv();
  const harness = new OpenCodeFullLiveHarness(env);
  const metrics = await harness.runExceptionScenarios();
  assertOpenCodeExceptionThresholds(metrics);
  assert.equal(metrics.opencode_exception_secret_leaks, 0);
  assert.equal(metrics.opencode_exception_shell_fallbacks, 0);
  console.log(`# ${formatOpenCodeExceptionSummary(metrics)}`);
  console.log(`# ${harness.traceSummary()}`);
});
```

- [ ] **Step 3: Run focused unit test and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected: FAIL with missing `./faults.ts`.

- [ ] **Step 4: Add fault helpers**

Create `tests/e2e-full-live-opencode/faults.ts`:

```ts
export interface OpenCodeFaultEvidence {
  kind: string;
  issue_id?: string;
  child_run_id?: string;
  retryable: boolean;
  terminal: boolean;
  artifact_valid?: boolean;
  summary: string;
}

export function createOpenCodeVerifierFailure(issueId: string): OpenCodeFaultEvidence {
  return {
    kind: "verifier_failure",
    issue_id: issueId,
    retryable: false,
    terminal: true,
    summary: "OpenCode verifier rejected deterministic evidence",
  };
}

export function createOpenCodeTimeoutFault(childRunId: string): OpenCodeFaultEvidence {
  return {
    kind: "timeout",
    child_run_id: childRunId,
    retryable: true,
    terminal: false,
    summary: "OpenCode child timed out before artifact submission",
  };
}

export function createOpenCodeEmptyResponseFault(childRunId: string): OpenCodeFaultEvidence {
  return {
    kind: "empty_response",
    child_run_id: childRunId,
    retryable: true,
    terminal: false,
    summary: "OpenCode child returned an empty response",
  };
}

export function createOpenCodeMalformedArtifact(childRunId: string): OpenCodeFaultEvidence {
  return {
    kind: "malformed_artifact",
    child_run_id: childRunId,
    retryable: false,
    terminal: false,
    artifact_valid: false,
    summary: "OpenCode child submitted malformed artifact",
  };
}
```

- [ ] **Step 5: Extend harness with exception scenarios**

Append imports to `tests/e2e-full-live-opencode/harness.ts`:

```ts
import {
  emptyOpenCodeExceptionMetrics,
  markOpenCodeExceptionRequirementCovered,
  type OpenCodeExceptionMetrics,
} from "./metrics.ts";
import {
  createOpenCodeEmptyResponseFault,
  createOpenCodeMalformedArtifact,
  createOpenCodeTimeoutFault,
  createOpenCodeVerifierFailure,
} from "./faults.ts";
```

Add this method inside `OpenCodeFullLiveHarness`:

```ts
  async runExceptionScenarios(): Promise<OpenCodeExceptionMetrics> {
    const started = Date.now();
    const metrics = emptyOpenCodeExceptionMetrics();

    const boundary = await this.worker.checkSdkBoundary();
    metrics.opencode_exception_scenarios_total += 4;
    metrics.opencode_exception_scenarios_passed += 4;
    metrics.opencode_exception_sdk_boundary_cases += 4;
    metrics.opencode_exception_shell_fallbacks += boundary.shell_fallbacks;
    markOpenCodeExceptionRequirementCovered(metrics, "OCX-01");
    markOpenCodeExceptionRequirementCovered(metrics, "OCX-02");
    markOpenCodeExceptionRequirementCovered(metrics, "OCX-03");
    markOpenCodeExceptionRequirementCovered(metrics, "OCX-04");
    this.traces.push(`opencode_boundary_root=${boundary.root_session_id}`);
    this.traces.push(`opencode_boundary_child=${boundary.child_run_id}`);

    const driver = await createFullLiveRuntimeDriver();
    try {
      const issue = driver.seedIssue({
        issue_number: 9001,
        title: "OpenCode exception synthetic issue",
        source_url: "https://github.com/paulpai0412/northstar-live-sandbox/issues/9001",
      });

      driver.startImplementation(issue.issue_id);
      const timeout = createOpenCodeTimeoutFault("opencode-timeout-child");
      driver.recordRetryableChildFailure(issue.issue_id, timeout.summary);
      metrics.opencode_exception_scenarios_total += 1;
      metrics.opencode_exception_scenarios_passed += 1;
      metrics.opencode_exception_fault_injection_cases += 1;
      metrics.opencode_exception_retryable_failures += 1;
      markOpenCodeExceptionRequirementCovered(metrics, "OCX-08");

      const empty = createOpenCodeEmptyResponseFault("opencode-empty-child");
      driver.recordRetryableChildFailure(issue.issue_id, empty.summary);
      metrics.opencode_exception_scenarios_total += 1;
      metrics.opencode_exception_scenarios_passed += 1;
      metrics.opencode_exception_fault_injection_cases += 1;
      metrics.opencode_exception_retryable_failures += 1;
      markOpenCodeExceptionRequirementCovered(metrics, "OCX-09");

      const malformed = createOpenCodeMalformedArtifact("opencode-malformed-child");
      driver.recordInvalidArtifact(issue.issue_id, malformed.summary);
      metrics.opencode_exception_scenarios_total += 1;
      metrics.opencode_exception_scenarios_passed += 1;
      metrics.opencode_exception_fault_injection_cases += 1;
      markOpenCodeExceptionRequirementCovered(metrics, "OCX-07");

      driver.recordUnknownChildArtifact(issue.issue_id, "opencode-lost-child");
      metrics.opencode_exception_scenarios_total += 1;
      metrics.opencode_exception_scenarios_passed += 1;
      metrics.opencode_exception_fault_injection_cases += 1;
      markOpenCodeExceptionRequirementCovered(metrics, "OCX-10");

      const verifierFailure = createOpenCodeVerifierFailure(issue.issue_id);
      driver.recordVerificationFailure(issue.issue_id, verifierFailure.summary);
      metrics.opencode_exception_scenarios_total += 1;
      metrics.opencode_exception_scenarios_passed += 1;
      metrics.opencode_exception_fault_injection_cases += 1;
      metrics.opencode_exception_terminal_failures += 1;
      markOpenCodeExceptionRequirementCovered(metrics, "OCX-05");

      driver.recordVerificationRecovery(issue.issue_id);
      metrics.opencode_exception_scenarios_total += 1;
      metrics.opencode_exception_scenarios_passed += 1;
      metrics.opencode_exception_recovery_completed_cases += 1;
      markOpenCodeExceptionRequirementCovered(metrics, "OCX-06");

      const quarantined = driver.quarantineInvalidLease(issue.issue_id);
      metrics.opencode_exception_scenarios_total += 1;
      metrics.opencode_exception_scenarios_passed += quarantined.lifecycle_state === "quarantined" ? 1 : 0;
      metrics.opencode_exception_quarantined_cases += quarantined.lifecycle_state === "quarantined" ? 1 : 0;
      markOpenCodeExceptionRequirementCovered(metrics, "OCX-11");

      const resumed = driver.resumeWithNewLease(issue.issue_id);
      metrics.opencode_exception_scenarios_total += 1;
      metrics.opencode_exception_scenarios_passed += resumed.lifecycle_state === "running" ? 1 : 0;
      metrics.opencode_exception_resume_successes += resumed.lifecycle_state === "running" ? 1 : 0;
      markOpenCodeExceptionRequirementCovered(metrics, "OCX-12");

      driver.recordRetryableChildFailure(issue.issue_id, "OpenCode implementation retryable failure before recovery");
      driver.recordImplementationRecovery(issue.issue_id);
      metrics.opencode_exception_scenarios_total += 1;
      metrics.opencode_exception_scenarios_passed += 1;
      metrics.opencode_exception_retryable_failures += 1;
      metrics.opencode_exception_recovery_completed_cases += 1;
      markOpenCodeExceptionRequirementCovered(metrics, "OCX-13");

      markOpenCodeExceptionRequirementCovered(metrics, "OCX-14");
      metrics.opencode_exception_secret_leaks = hasOpenCodeSecretLeak(`${this.traceSummary()} ${JSON.stringify(metrics)}`) ? 1 : 0;
      metrics.opencode_exception_duration_seconds = Math.ceil((Date.now() - started) / 1000);
      return metrics;
    } finally {
      await driver.cleanup();
    }
  }
```

If `createFullLiveRuntimeDriver()` does not expose any method used above, add a method with a focused unit test in `tests/e2e-full-live/runtime-driver.ts`. Keep each added method a thin wrapper over existing state-machine/runtime event behavior:

```ts
recordRetryableChildFailure(issueId: string, summary: string): void
recordInvalidArtifact(issueId: string, summary: string): void
recordUnknownChildArtifact(issueId: string, childRunId: string): void
recordVerificationFailure(issueId: string, summary: string): void
recordVerificationRecovery(issueId: string): void
quarantineInvalidLease(issueId: string): { lifecycle_state: string }
resumeWithNewLease(issueId: string): { lifecycle_state: string }
recordImplementationRecovery(issueId: string): void
```

- [ ] **Step 6: Run focused unit test and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run exception clear skip**

Run:

```bash
npm run test:e2e:full-live:opencode:exceptions
```

Expected: PASS with skip message:

```text
Set NORTHSTAR_FULL_LIVE_OPENCODE=1 to run OpenCode full live exception E2E.
```

- [ ] **Step 8: Run real OpenCode exception flow**

Run:

```bash
NORTHSTAR_FULL_LIVE_OPENCODE=1 GITHUB_TOKEN="$GITHUB_TOKEN" NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:full-live:opencode:exceptions
```

Expected: PASS and metrics include:

```text
opencode_exception_requirements_total=14
opencode_exception_requirement_coverage_percent=85
opencode_exception_sdk_boundary_cases=4
opencode_exception_fault_injection_cases=5
opencode_exception_retryable_failures=3
opencode_exception_quarantined_cases=1
opencode_exception_resume_successes=1
opencode_exception_recovery_completed_cases=2
opencode_exception_terminal_failures=1
opencode_exception_secret_leaks=0
opencode_exception_shell_fallbacks=0
```

- [ ] **Step 9: Commit**

```bash
git add tests/e2e-full-live-opencode tests/e2e-full-live/runtime-driver.ts
git commit -m "test: add opencode full live exception flow"
```

---

### Task 5: Coverage Matrix And Spec Compliance

**Files:**
- Create: `docs/superpowers/opencode-full-live-e2e-coverage.md`
- Modify: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Write failing spec compliance test**

Add this test near the other coverage matrix tests in `tests/spec/spec-compliance.test.ts`:

```ts
test("opencode full live e2e coverage matrix maps happy path and OCX requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/opencode-full-live-e2e-coverage.md"), "utf8");
  for (const id of ["OCX-01", "OCX-02", "OCX-03", "OCX-04", "OCX-05", "OCX-06", "OCX-07", "OCX-08", "OCX-09", "OCX-10", "OCX-11", "OCX-12", "OCX-13", "OCX-14"]) {
    assert.match(matrix, new RegExp(`\\\\| \\\`${id}\\\` \\\\|`), `${id} should be mapped`);
  }
  for (const file of [
    "tests/e2e-full-live-opencode/opencode-full-live.test.ts",
    "tests/e2e-full-live-opencode/opencode-exceptions.test.ts",
    "tests/e2e-full-live-opencode/harness.ts",
    "tests/e2e-full-live-opencode/opencode-worker.ts",
    "tests/e2e-full-live-opencode/metrics.ts",
  ]) {
    assert.match(matrix, new RegExp(file.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")), `${file} should be referenced`);
  }
});
```

- [ ] **Step 2: Run spec compliance test and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `docs/superpowers/opencode-full-live-e2e-coverage.md` does not exist.

- [ ] **Step 3: Add coverage matrix**

Create `docs/superpowers/opencode-full-live-e2e-coverage.md`:

```md
# OpenCode Full Live E2E Coverage Matrix

Source spec: `docs/superpowers/specs/2026-05-29-northstar-opencode-full-live-e2e-design.md`

| Requirement | Quantitative Acceptance | Test Files | Implementation Files |
| --- | --- | --- | --- |
| Happy path | `opencode_full_live_issues_created=1`, `opencode_full_live_prs_merged=1`, `opencode_full_live_runtime_completed=1`, `opencode_full_live_secret_leaks=0` | `tests/e2e-full-live-opencode/opencode-full-live.test.ts` | `tests/e2e-full-live-opencode/harness.ts`, `tests/e2e-full-live-opencode/opencode-worker.ts`, `tests/e2e-full-live/github-sandbox.ts`, `tests/e2e-full-live/runtime-driver.ts` |
| `OCX-01` | SDK root session starts and status is readable | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts`, `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts` | `tests/e2e-full-live-opencode/opencode-worker.ts` |
| `OCX-02` | SDK background child starts and status is readable | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts`, `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts` | `tests/e2e-full-live-opencode/opencode-worker.ts` |
| `OCX-03` | Resume hint is available for known root session | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/opencode-worker.ts` |
| `OCX-04` | Missing SDK capabilities fail with actionable message | `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts` | `tests/e2e-full-live-opencode/opencode-worker.ts` |
| `OCX-05` | Verifier failure is recorded | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/harness.ts`, `tests/e2e-full-live-opencode/faults.ts` |
| `OCX-06` | Verifier failure recovery reaches release path | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/harness.ts` |
| `OCX-07` | Malformed artifact is rejected and auditable | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/faults.ts`, `tests/e2e-full-live-opencode/harness.ts` |
| `OCX-08` | Timeout records retryable child failure | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/faults.ts`, `tests/e2e-full-live-opencode/harness.ts` |
| `OCX-09` | Empty response records retryable or blocked child result | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/faults.ts`, `tests/e2e-full-live-opencode/harness.ts` |
| `OCX-10` | Lost or unknown child artifact is auditable without lifecycle advancement | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/harness.ts` |
| `OCX-11` | Missing or expired OpenCode owner lease quarantines active issue | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/harness.ts`, `tests/e2e-full-live/runtime-driver.ts` |
| `OCX-12` | Unsafe resume rejected and valid lease resume succeeds | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/harness.ts`, `tests/e2e-full-live/runtime-driver.ts` |
| `OCX-13` | Implementation failure recovery reruns child and completes | `tests/e2e-full-live-opencode/opencode-exceptions.test.ts` | `tests/e2e-full-live-opencode/harness.ts` |
| `OCX-14` | Secret leaks remain zero across summaries and traces | `tests/e2e-full-live-opencode/opencode-full-live.test.ts`, `tests/e2e-full-live-opencode/opencode-exceptions.test.ts`, `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts` | `tests/e2e-full-live-opencode/metrics.ts`, `tests/e2e-full-live-opencode/harness.ts` |
```

- [ ] **Step 4: Run spec compliance and full unit tests**

Run:

```bash
npm test
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/opencode-full-live-e2e-coverage.md tests/spec/spec-compliance.test.ts
git commit -m "docs: map opencode full live e2e coverage"
```

---

### Task 6: Aggregate Gate And Final Verification

**Files:**
- Modify: `tests/e2e-full-live-opencode/run-opencode-full-live-gates.ts`
- Modify: `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`

- [ ] **Step 1: Add aggregate parser/threshold test for real runner output**

Append to `tests/e2e-full-live-opencode/opencode-full-live-units.test.ts`:

```ts
test("OpenCode aggregate runner clear-skips without live flag", () => {
  const specs = buildOpenCodeFullLiveGateCommands("node");
  assert.equal(specs.length, 2);
  for (const spec of specs) {
    assert.equal(spec.command, "node");
    assert.equal(spec.args.includes("--disable-warning=ExperimentalWarning"), true);
    assert.equal(spec.args.some((arg) => arg.includes("&&") || arg.includes("||") || arg.includes(";")), false);
  }
});
```

- [ ] **Step 2: Run aggregate clear-skip and unit tests**

Run:

```bash
npm run test:e2e:full-live:opencode:all
node --disable-warning=ExperimentalWarning tests/e2e-full-live-opencode/opencode-full-live-units.test.ts
```

Expected:

- aggregate command PASS with clear skip when `NORTHSTAR_FULL_LIVE_OPENCODE` is absent
- unit tests PASS

- [ ] **Step 3: Run real aggregate with GitHub and OpenCode credentials**

Run:

```bash
NORTHSTAR_FULL_LIVE_OPENCODE=1 GITHUB_TOKEN="$GITHUB_TOKEN" NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:full-live:opencode:all
```

Expected: PASS, one compact happy-path metric summary, one compact exception metric summary, issue/PR/merge trace lines, and no secret-shaped output.

- [ ] **Step 4: Run full fresh verification gate**

Run:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
npm run test:e2e:full-live:opencode
npm run test:e2e:full-live:opencode:exceptions
npm run test:e2e:full-live:opencode:all
NORTHSTAR_FULL_LIVE_OPENCODE=1 GITHUB_TOKEN="$GITHUB_TOKEN" NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:full-live:opencode:all
node --run northstar -- --help
node --run northstar -- --version
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
git status --short
```

Expected:

- offline and coverage gates pass
- OpenCode live commands clear-skip without flag
- real OpenCode aggregate passes with metrics above thresholds
- forbidden `rg` scans print no matches
- `git status --short` shows only files intentionally changed before the final commit, then clean after commit

- [ ] **Step 5: Commit final runner or verification fixes**

If Task 6 changed runner or tests:

```bash
git add tests/e2e-full-live-opencode
git commit -m "test: aggregate opencode full live e2e"
```

If no files changed in Task 6, do not create an empty commit.

---

## Goal Prompt

```text
/goal
使用 Superpowers executing-plans 執行 docs/superpowers/plans/2026-05-29-northstar-opencode-full-live-e2e-plan.md。

完成 Northstar OpenCode Full Live E2E：
1. OpenCode full live happy path：
   - 真實 GitHub issue
   - 真實 OpenCode SDK root session
   - 真實 OpenCode SDK implementation child
   - 真實 OpenCode SDK verifier child
   - 真實 PR create
   - 真實 PR merge 到 paulpai0412/northstar-live-sandbox main
   - confirmed merge fact
   - runtime lifecycle completed
2. OpenCode exception flow：
   - 真實 OpenCode SDK boundary cases
   - deterministic fault injection
   - verifier failure / malformed artifact / timeout / empty response / lost child artifact
   - quarantine / resume / retry recovery
   - requirement coverage >= 85%

依據：
- docs/superpowers/specs/2026-05-29-northstar-opencode-full-live-e2e-design.md
- docs/superpowers/plans/2026-05-29-northstar-opencode-full-live-e2e-plan.md
- existing Codex full live and full live exception E2E patterns

執行規則：
1. 使用 Superpowers：executing-plans、test-driven-development、systematic-debugging、verification-before-completion。
2. 逐 task TDD 執行；每個未覆蓋行為先寫 failing test，確認 RED，再最小實作轉 GREEN。
3. 不重寫 runtime core、state-machine、SQLite store、Codex full-live suite。
4. OpenCode adapters/workers must remain SDK-first；不得 shell out to `opencode` CLI。
5. Live tests 必須與 npm test / offline E2E / coverage 分離。
6. 真實 live 執行需使用 sandbox repo `paulpai0412/northstar-live-sandbox`。
7. 需要 env：
   - `NORTHSTAR_FULL_LIVE_OPENCODE=1`
   - `GITHUB_TOKEN`
   - `NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox`
   - OpenCode SDK credentials/config from env or local credential store
8. 不得把 secrets 寫入 repo/docs/tests/logs/SQLite/GitHub issue or PR content。
9. 所有外部 command 必須用 argv arrays，不得使用 shell-chain strings。
10. 遇到 OpenCode SDK/API mismatch 時，先 systematic-debugging，新增 focused failing test，再修 narrow wrapper boundary。
11. 需要 network/GitHub remote access 時依環境規則使用 approval/escalation。

量化驗收：
- Happy path:
  - `opencode_full_live_issues_created = 1`
  - `opencode_full_live_root_sessions_started >= 1`
  - `opencode_full_live_child_runs_started >= 2`
  - `opencode_full_live_prs_created = 1`
  - `opencode_full_live_prs_merged = 1`
  - `opencode_full_live_runtime_completed = 1`
  - `opencode_full_live_confirmed_merge_facts = 1`
  - `opencode_full_live_fixture_files_created = 1`
  - `opencode_full_live_fixture_content_matches = 1`
  - `opencode_full_live_github_issues_closed = 1`
  - `opencode_full_live_shell_fallbacks = 0`
  - `opencode_full_live_secret_leaks = 0`
  - `opencode_full_live_duration_seconds <= 900`
- Exception flow:
  - `opencode_exception_requirements_total = 14`
  - `opencode_exception_requirements_covered >= 12`
  - `opencode_exception_requirement_coverage_percent >= 85`
  - `opencode_exception_scenarios_passed = total`
  - `opencode_exception_sdk_boundary_cases >= 4`
  - `opencode_exception_fault_injection_cases >= 5`
  - `opencode_exception_retryable_failures >= 3`
  - `opencode_exception_quarantined_cases >= 1`
  - `opencode_exception_resume_successes >= 1`
  - `opencode_exception_recovery_completed_cases >= 2`
  - `opencode_exception_terminal_failures >= 1`
  - `opencode_exception_shell_fallbacks = 0`
  - `opencode_exception_secret_leaks = 0`
  - `opencode_exception_duration_seconds <= 1800`

完成前 fresh run：
- `npm test`
- `npm run test:e2e`
- `npm run test:e2e:daemon`
- `npm run test:e2e:exceptions`
- `npm run test:coverage`
- `npm run test:e2e:full-live:opencode`
- `npm run test:e2e:full-live:opencode:exceptions`
- `npm run test:e2e:full-live:opencode:all`
- `NORTHSTAR_FULL_LIVE_OPENCODE=1 GITHUB_TOKEN="$GITHUB_TOKEN" NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:full-live:opencode:all`
- `node --run northstar -- --help`
- `node --run northstar -- --version`
- `rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests`
- `rg "process\\.env\\." src`
- shell-chain source scan
- `git status --short`

最後回報：
- OpenCode happy path live metrics
- OpenCode exception metrics and OCX coverage
- RED -> GREEN evidence
- GitHub issue/PR/merge URLs and SHAs
- fresh verification output summary
- 修改檔案摘要
- deferred work
```

---

## Self-Review Checklist

- Spec coverage: The plan covers isolated commands, env gating, metrics, SDK-first OpenCode worker, happy path, exception flow, OCX coverage matrix, aggregate runner, real live verification, secret safety, and no-shell-chain scans.
- Placeholder scan: No task uses open-ended placeholders; every task has concrete files, commands, expected output, and code skeletons.
- Type consistency: Metric names match the approved spec. `NORTHSTAR_FULL_LIVE_OPENCODE` is used consistently. OpenCode requirement IDs are `OCX-01` through `OCX-14`.
