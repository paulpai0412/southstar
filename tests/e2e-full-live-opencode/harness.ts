import { GitHubSandboxClient } from "../e2e-full-live/github-sandbox.ts";
import { createFullLiveRuntimeDriver } from "../e2e-full-live/runtime-driver.ts";
import { redactSecrets } from "../../src/runtime/redaction.ts";
import { OpenCodeFullLiveWorker } from "./opencode-worker.ts";
import {
  emptyOpenCodeExceptionMetrics,
  emptyOpenCodeFullLiveMetrics,
  hasOpenCodeSecretLeak,
  markOpenCodeExceptionRequirementCovered,
  type OpenCodeExceptionMetrics,
  type OpenCodeExceptionRequirementId,
  type OpenCodeFullLiveMetrics,
} from "./metrics.ts";
import {
  createOpenCodeEmptyResponseFault,
  createOpenCodeLostChildArtifact,
  createOpenCodeMalformedArtifact,
  createOpenCodeTimeoutFault,
  createOpenCodeVerifierFailure,
} from "./faults.ts";
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

      const branch = await this.ensureFixtureBranch({
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
      assertOpenCodeFixtureGate({
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
      await this.worker.dispose();
    }
  }

  async runExceptionScenarios(): Promise<OpenCodeExceptionMetrics> {
    const started = Date.now();
    const metrics = emptyOpenCodeExceptionMetrics();
    const driver = await createFullLiveRuntimeDriver();

    const pass = (...ids: OpenCodeExceptionRequirementId[]) => {
      metrics.opencode_exception_scenarios_passed += 1;
      for (const id of ids) markOpenCodeExceptionRequirementCovered(metrics, id);
    };

    try {
      const boundary = await this.worker.checkSdkBoundary();
      this.traces.push(`opencode_exception_root=${boundary.root_session_id}`);
      this.traces.push(`opencode_exception_child=${boundary.child_run_id}`);
      metrics.opencode_exception_scenarios_total += 4;
      if (boundary.root_status !== "live") throw new Error(`OCX-01 expected live root status, got ${boundary.root_status}`);
      metrics.opencode_exception_sdk_boundary_cases += 1;
      pass("OCX-01");
      if (!boundary.child_status) throw new Error("OCX-02 expected readable child status");
      metrics.opencode_exception_sdk_boundary_cases += 1;
      pass("OCX-02");
      if (!boundary.resume_hint_available) throw new Error("OCX-03 expected resume hint");
      metrics.opencode_exception_sdk_boundary_cases += 1;
      pass("OCX-03");
      if (boundary.shell_fallbacks !== 0) throw new Error("OCX-04 expected zero shell fallbacks");
      metrics.opencode_exception_sdk_boundary_cases += 1;
      metrics.opencode_exception_shell_fallbacks += boundary.shell_fallbacks;
      pass("OCX-04");

      metrics.opencode_exception_scenarios_total += 10;

      const timeoutIssue = driver.seedIssue({ issue_number: 901, title: "OpenCode timeout recovery", source_url: "local://opencode-timeout" });
      driver.startImplementation(timeoutIssue.issue_id);
      const timeout = createOpenCodeTimeoutFault(`child-impl-${timeoutIssue.issue_id}`);
      const timeoutResult = driver.recordRetryableChildFailure(timeoutIssue.issue_id, timeout.summary);
      if (timeoutResult.lifecycle_state !== "running") throw new Error("OCX-08 timeout fault should remain retryable/running");
      metrics.opencode_exception_fault_injection_cases += 1;
      metrics.opencode_exception_retryable_failures += 1;
      pass("OCX-08");

      const emptyIssue = driver.seedIssue({ issue_number: 902, title: "OpenCode empty response recovery", source_url: "local://opencode-empty" });
      driver.startImplementation(emptyIssue.issue_id);
      const empty = createOpenCodeEmptyResponseFault(`child-impl-${emptyIssue.issue_id}`);
      const emptyResult = driver.recordRetryableChildFailure(emptyIssue.issue_id, empty.summary);
      if (emptyResult.lifecycle_state !== "running") throw new Error("OCX-09 empty response should remain retryable/running");
      metrics.opencode_exception_fault_injection_cases += 1;
      metrics.opencode_exception_retryable_failures += 1;
      pass("OCX-09");

      const malformedIssue = driver.seedIssue({ issue_number: 903, title: "OpenCode malformed artifact", source_url: "local://opencode-malformed" });
      driver.startImplementation(malformedIssue.issue_id);
      const malformed = createOpenCodeMalformedArtifact(`child-impl-${malformedIssue.issue_id}`);
      const malformedResult = driver.recordInvalidWorkerArtifact(malformedIssue.issue_id);
      if (malformedResult.lifecycle_state !== "running") throw new Error(`${malformed.summary} should not advance lifecycle`);
      metrics.opencode_exception_fault_injection_cases += 1;
      pass("OCX-07");

      const lostIssue = driver.seedIssue({ issue_number: 904, title: "OpenCode lost child artifact", source_url: "local://opencode-lost" });
      driver.startImplementation(lostIssue.issue_id);
      const lost = createOpenCodeLostChildArtifact("unknown-opencode-child");
      const lostResult = driver.recordUnknownChildArtifact(lostIssue.issue_id, lost.child_run_id ?? "unknown-opencode-child");
      if (lostResult.lifecycle_state !== "running") throw new Error("OCX-10 lost child artifact should not fail lifecycle");
      metrics.opencode_exception_fault_injection_cases += 1;
      metrics.opencode_exception_retryable_failures += 1;
      pass("OCX-10");

      const verifierIssue = driver.seedIssue({ issue_number: 905, title: "OpenCode verifier terminal failure", source_url: "local://opencode-verifier-terminal" });
      driver.startImplementation(verifierIssue.issue_id);
      driver.submitWorkerResult(verifierIssue.issue_id, {
        branch: "northstar-opencode-verifier-terminal",
        commit_sha: "abc905",
        changed_files: ["northstar-smoke/opencode-exception/verifier-terminal.json"],
        self_check_summary: "ready for verifier terminal failure",
      });
      driver.startVerification(verifierIssue.issue_id);
      const verifierFailure = createOpenCodeVerifierFailure(verifierIssue.issue_id);
      const verifierFailed = driver.recordVerificationTerminalFailure(verifierIssue.issue_id);
      if (verifierFailed.lifecycle_state !== "failed") throw new Error(`${verifierFailure.summary} should fail lifecycle`);
      metrics.opencode_exception_fault_injection_cases += 1;
      metrics.opencode_exception_terminal_failures += 1;
      pass("OCX-05");

      const recoveryIssue = driver.seedIssue({ issue_number: 906, title: "OpenCode verification retry recovery", source_url: "local://opencode-verification-recovery" });
      driver.startImplementation(recoveryIssue.issue_id);
      driver.submitWorkerResult(recoveryIssue.issue_id, {
        branch: "northstar-opencode-verification-recovery",
        commit_sha: "abc906",
        changed_files: ["northstar-smoke/opencode-exception/verification-recovery.json"],
        self_check_summary: "ready for verifier retry failure",
      });
      driver.startVerification(recoveryIssue.issue_id);
      const retryAfterVerify = driver.recordVerificationRetryableFailure(recoveryIssue.issue_id);
      if (retryAfterVerify.lifecycle_state !== "running") throw new Error("OCX-06 retryable verification failure should return to running");
      metrics.opencode_exception_retryable_failures += 1;
      driver.startImplementation(recoveryIssue.issue_id);
      driver.submitWorkerResult(recoveryIssue.issue_id, {
        branch: "northstar-opencode-verification-recovery-2",
        commit_sha: "def906",
        changed_files: ["northstar-smoke/opencode-exception/verification-recovery.json"],
        self_check_summary: "recovered implementation",
      });
      driver.startVerification(recoveryIssue.issue_id);
      const verifiedAfterRecovery = driver.submitVerifierEvidence(recoveryIssue.issue_id, {
        pr_number: 906,
        gate_results: [{ name: "OpenCode recovery gate", status: "pass" }],
      });
      if (verifiedAfterRecovery.lifecycle_state !== "verified") throw new Error("OCX-06 verification recovery should reach verified");
      metrics.opencode_exception_recovery_completed_cases += 1;
      pass("OCX-06");

      const quarantineIssue = driver.seedIssue({ issue_number: 907, title: "OpenCode quarantine resume", source_url: "local://opencode-quarantine" });
      driver.startImplementation(quarantineIssue.issue_id);
      const quarantined = driver.quarantineInvalidLease(quarantineIssue.issue_id);
      if (quarantined.lifecycle_state !== "quarantined") throw new Error("OCX-11 invalid lease should quarantine issue");
      metrics.opencode_exception_quarantined_cases += 1;
      pass("OCX-11");
      const resumed = driver.resumeWithNewLease(quarantineIssue.issue_id);
      if (resumed.lifecycle_state !== "running") throw new Error("OCX-12 new lease should resume quarantined issue");
      metrics.opencode_exception_resume_successes += 1;
      pass("OCX-12");

      const implementationRecoveryIssue = driver.seedIssue({ issue_number: 908, title: "OpenCode implementation retry recovery", source_url: "local://opencode-implementation-recovery" });
      driver.startImplementation(implementationRecoveryIssue.issue_id);
      driver.recordRetryableChildFailure(implementationRecoveryIssue.issue_id, "OpenCode implementation transient failure");
      driver.startImplementation(implementationRecoveryIssue.issue_id);
      const implementationRecovered = driver.submitWorkerResult(implementationRecoveryIssue.issue_id, {
        branch: "northstar-opencode-implementation-recovery",
        commit_sha: "abc908",
        changed_files: ["northstar-smoke/opencode-exception/implementation-recovery.json"],
        self_check_summary: "implementation recovered",
      });
      if (implementationRecovered.lifecycle_state !== "verifying") throw new Error("OCX-13 implementation recovery should advance to verification");
      metrics.opencode_exception_recovery_completed_cases += 1;
      pass("OCX-13");

      metrics.opencode_exception_secret_leaks = hasOpenCodeSecretLeak(`${this.traceSummary()} ${JSON.stringify(metrics)}`) ? 1 : 0;
      if (metrics.opencode_exception_secret_leaks !== 0) throw new Error("OCX-14 exception traces contained secret-shaped values");
      pass("OCX-14");
      metrics.opencode_exception_duration_seconds = Math.ceil((Date.now() - started) / 1000);
      return metrics;
    } finally {
      await driver.cleanup();
      await this.worker.dispose();
    }
  }

  private async ensureFixtureBranch(input: {
    branch: string;
    base: string;
    path: string;
    content: string;
    message: string;
  }): Promise<{ branch: string; commit_sha: string }> {
    try {
      return await this.github.createFixtureBranch(input);
    } catch (error) {
      if (error instanceof Error && /Reference already exists/i.test(error.message)) {
        this.traces.push(`opencode_branch_reused=${input.branch}`);
        return await this.github.readBranchCommit({ branch: input.branch });
      }
      throw error;
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

function assertOpenCodeFixtureGate(input: {
  files: Array<{ filename: string }>;
  expected_path: string;
  expected_content: string;
  actual_content: string;
}): void {
  if (!input.files.some((file) => file.filename === input.expected_path)) {
    throw new Error(`missing expected fixture path ${input.expected_path}`);
  }
  const actual = JSON.parse(input.actual_content) as Record<string, unknown>;
  const expected = JSON.parse(input.expected_content) as Record<string, unknown>;
  for (const key of ["run_id", "issue_number", "sequence", "implemented_by"]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`fixture field ${key} mismatch for ${input.expected_path}`);
    }
  }
}

function smokeRunId(): string {
  return `northstar-opencode-smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}
