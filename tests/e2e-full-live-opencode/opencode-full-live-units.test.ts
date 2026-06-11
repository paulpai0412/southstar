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
import { OpenCodeFullLiveWorker } from "./opencode-worker.ts";
import { assertOpenCodeWorkerReturned, buildOpenCodeFixtureInput } from "./harness.ts";
import {
  createOpenCodeEmptyResponseFault,
  createOpenCodeMalformedArtifact,
  createOpenCodeTimeoutFault,
  createOpenCodeVerifierFailure,
  createOpenCodeLostChildArtifact,
} from "./faults.ts";

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

test("OpenCode aggregate runner clear-skips without live flag", () => {
  const specs = buildOpenCodeFullLiveGateCommands("node");
  assert.equal(specs.length, 2);
  for (const spec of specs) {
    assert.equal(spec.command, "node");
    assert.equal(spec.args.includes("--disable-warning=ExperimentalWarning"), true);
    assert.equal(spec.args.some((arg) => arg.includes("&&") || arg.includes("||") || arg.includes(";")), false);
  }
});

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
  assert.equal(createOpenCodeLostChildArtifact("child-4").kind, "lost_child_artifact");
});
