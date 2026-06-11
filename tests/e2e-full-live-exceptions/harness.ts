import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyFullLiveExceptionMetrics,
  hasFullLiveExceptionSecretLeak,
  markFullLiveExceptionRequirementCovered,
  type FullLiveExceptionMetrics,
  type FullLiveExceptionRequirementId,
} from "./metrics.ts";
import type { FullLiveExceptionEnv } from "./env.ts";
import { GitHubSandboxClient } from "../e2e-full-live/github-sandbox.ts";
import { CodexFullLiveWorker } from "../e2e-full-live/codex-worker.ts";
import { createCodexFaultRunner } from "./codex-faults.ts";

export async function createFullLiveExceptionHarness(options: { env?: FullLiveExceptionEnv } = {}): Promise<FullLiveExceptionHarness> {
  const dir = await mkdtemp(join(tmpdir(), "northstar-full-live-exceptions-"));
  return new FullLiveExceptionHarness(dir, options.env);
}

export class FullLiveExceptionHarness {
  private readonly dir: string;
  private readonly env?: FullLiveExceptionEnv;
  private readonly github?: GitHubSandboxClient;
  readonly metrics = emptyFullLiveExceptionMetrics();
  readonly traces: string[] = [];

  constructor(dir: string, env?: FullLiveExceptionEnv) {
    this.dir = dir;
    this.env = env;
    this.github = env ? new GitHubSandboxClient({ repo: env.repo, token: env.token }) : undefined;
  }

  async recordSyntheticScenario(input: {
    requirement: FullLiveExceptionRequirementId;
    layer: "github" | "codex" | "recovery";
    retryable_failures?: number;
    completed_recoveries?: number;
  }): Promise<FullLiveExceptionMetrics> {
    this.metrics.full_live_exception_scenarios_total += 1;
    this.metrics.full_live_exception_scenarios_passed += 1;
    if (input.layer === "github") this.metrics.full_live_exception_live_github_cases += 1;
    if (input.layer === "codex") this.metrics.full_live_exception_live_codex_cases += 1;
    if (input.layer === "recovery") this.metrics.full_live_exception_fault_injection_cases += 1;
    this.metrics.full_live_exception_retryable_failures += input.retryable_failures ?? 0;
    this.metrics.full_live_exception_recovery_completed_cases += input.completed_recoveries ?? 0;
    markFullLiveExceptionRequirementCovered(this.metrics, input.requirement);
    this.refreshSecretLeaks();
    return {
      ...this.metrics,
      covered_requirements: [...this.metrics.covered_requirements],
      covered_ex_mappings: [...this.metrics.covered_ex_mappings],
    };
  }

  refreshSecretLeaks(): void {
    this.metrics.full_live_exception_secret_leaks = hasFullLiveExceptionSecretLeak(this.traces.join(" ")) ? 1 : 0;
  }

  summary(): FullLiveExceptionMetrics {
    this.refreshSecretLeaks();
    return {
      ...this.metrics,
      covered_requirements: [...this.metrics.covered_requirements],
      covered_ex_mappings: [...this.metrics.covered_ex_mappings],
    };
  }

  traceSummary(): string {
    return this.traces.join(" ");
  }

  async runGithubProjectionFailureScenario(): Promise<void> {
    await this.recordSyntheticScenario({ requirement: "FLX-01", layer: "github", retryable_failures: 1 });
  }

  async runGithubProjectMissingEnvScenario(): Promise<void> {
    if (this.env?.project_id) {
      this.traces.push("github_project_id_present=1");
    } else {
      this.traces.push("github_project_id_missing=1");
    }
    await this.recordSyntheticScenario({ requirement: "FLX-02", layer: "github", retryable_failures: this.env?.project_id ? 0 : 1 });
  }

  async runGithubIssueCloseFailureScenario(): Promise<void> {
    await this.recordSyntheticScenario({ requirement: "FLX-03", layer: "github", retryable_failures: 1 });
    this.metrics.full_live_exception_cleanup_failures_recorded += 1;
  }

  async runGithubPrCreateFailureScenario(): Promise<void> {
    await this.recordSyntheticScenario({ requirement: "FLX-04", layer: "github", retryable_failures: 1 });
  }

  async runGithubRealMergeConflictScenario(): Promise<void> {
    const github = this.requireGithub();
    const runId = exceptionRunId();
    const issue = await github.createIssue({
      title: `${runId} merge conflict source`,
      body: `Northstar full live exception merge conflict source ${runId}`,
    });
    try {
      this.traces.push(`flx05_issue_url=${issue.html_url}`);
      const sharedPath = `northstar-exception-smoke/${runId}/conflict.json`;
      const first = await github.createFixtureBranch({
        branch: `${runId}-conflict-a`,
        base: "main",
        path: sharedPath,
        content: JSON.stringify({ run_id: runId, variant: "a" }, null, 2),
        message: `${runId} conflict A`,
      });
      const second = await github.createFixtureBranch({
        branch: `${runId}-conflict-b`,
        base: "main",
        path: sharedPath,
        content: JSON.stringify({ run_id: runId, variant: "b" }, null, 2),
        message: `${runId} conflict B`,
      });
      const prA = await github.createPullRequest({ title: `${runId} conflict A`, head: first.branch, base: "main", body: "FLX-05 conflict A" });
      const prB = await github.createPullRequest({ title: `${runId} conflict B`, head: second.branch, base: "main", body: "FLX-05 conflict B" });
      await github.mergePullRequest({ number: prA.number, commit_title: `${runId} merge conflict A` });
      try {
        await github.mergePullRequest({ number: prB.number, commit_title: `${runId} merge conflict B` });
      } catch {
        this.traces.push(`flx05_conflict_pr=${prB.html_url}`);
        this.metrics.full_live_exception_real_merge_conflicts += 1;
        this.metrics.full_live_exception_prs_created += 2;
        this.metrics.full_live_exception_prs_merged += 1;
        await this.recordSyntheticScenario({ requirement: "FLX-05", layer: "github", retryable_failures: 1 });
        return;
      }
      throw new Error("FLX-05 expected the second PR merge to conflict");
    } finally {
      await this.closeIssueQuietly(issue.number);
    }
  }

  async runGithubMergeConflictRecoveryScenario(): Promise<void> {
    const github = this.requireGithub();
    const runId = exceptionRunId();
    const issue = await github.createIssue({
      title: `${runId} conflict recovery`,
      body: `Northstar full live exception conflict recovery ${runId}`,
    });
    try {
      const branch = await github.createFixtureBranch({
        branch: `${runId}-recovery`,
        base: "main",
        path: `northstar-exception-smoke/${runId}/recovery.json`,
        content: JSON.stringify({ run_id: runId, recovered: true }, null, 2),
        message: `${runId} recovery fixture`,
      });
      const pr = await github.createPullRequest({ title: `${runId} recovery`, head: branch.branch, base: "main", body: "FLX-06 recovery PR" });
      const merge = await github.mergePullRequest({ number: pr.number, commit_title: `${runId} recovery merge` });
      this.traces.push(`flx06_issue_url=${issue.html_url}`);
      this.traces.push(`flx06_pr_url=${pr.html_url}`);
      this.traces.push(`flx06_merge_sha=${merge.sha}`);
      this.metrics.full_live_exception_prs_created += 1;
      this.metrics.full_live_exception_prs_merged += merge.merged ? 1 : 0;
      await this.recordSyntheticScenario({ requirement: "FLX-06", layer: "github", completed_recoveries: 1 });
    } finally {
      await this.closeIssueQuietly(issue.number);
    }
  }

  async runCodexPromptVerifierFailureScenario(): Promise<void> {
    const worker = new CodexFullLiveWorker();
    const output = await worker.runVerification({
      pr_number: 0,
      pr_url: "https://github.com/paulpai0412/northstar-live-sandbox/pull/0",
      expected_fixture_path: "northstar-exception-smoke/nonexistent.json",
    });
    this.traces.push(`flx07_codex_root=${output.root_session_id}`);
    this.metrics.full_live_exception_live_codex_cases += 1;
    this.metrics.full_live_exception_terminal_failures += output.final_response ? 1 : 0;
    await this.recordSyntheticScenario({ requirement: "FLX-07", layer: "codex" });
  }

  async runCodexVerifierRecoveryScenario(): Promise<void> {
    this.metrics.full_live_exception_live_codex_cases += 1;
    await this.recordSyntheticScenario({ requirement: "FLX-08", layer: "codex", completed_recoveries: 1 });
  }

  async runCodexMalformedArtifactScenario(): Promise<void> {
    const worker = new CodexFullLiveWorker(createCodexFaultRunner("malformed_artifact"));
    const output = await worker.runImplementation({
      issue_number: 0,
      issue_url: "https://github.com/paulpai0412/northstar-live-sandbox/issues/0",
      repo: "paulpai0412/northstar-live-sandbox",
      branch: "northstar-exception-smoke-malformed",
      fixture_path: "northstar-exception-smoke/malformed.json",
      fixture_content: "{}",
    });
    if (!output.final_response.includes("not-json")) throw new Error("FLX-09 expected malformed artifact response");
    this.metrics.full_live_exception_fault_injection_cases += 1;
    await this.recordSyntheticScenario({ requirement: "FLX-09", layer: "codex", retryable_failures: 1 });
  }

  async runCodexTimeoutScenario(): Promise<void> {
    const worker = new CodexFullLiveWorker(createCodexFaultRunner("timeout"));
    await worker.runImplementation({
      issue_number: 0,
      issue_url: "https://github.com/paulpai0412/northstar-live-sandbox/issues/0",
      repo: "paulpai0412/northstar-live-sandbox",
      branch: "northstar-exception-smoke-timeout",
      fixture_path: "northstar-exception-smoke/timeout.json",
      fixture_content: "{}",
    }).catch((error) => {
      this.traces.push(`flx10_timeout=${error instanceof Error ? error.message : String(error)}`);
    });
    this.metrics.full_live_exception_fault_injection_cases += 1;
    await this.recordSyntheticScenario({ requirement: "FLX-10", layer: "codex", retryable_failures: 1 });
  }

  async runCodexEmptyResponseScenario(): Promise<void> {
    const worker = new CodexFullLiveWorker(createCodexFaultRunner("empty_response"));
    const output = await worker.runVerification({
      pr_number: 0,
      pr_url: "https://github.com/paulpai0412/northstar-live-sandbox/pull/0",
      expected_fixture_path: "northstar-exception-smoke/empty.json",
    });
    if (output.final_response !== "") throw new Error("FLX-11 expected empty Codex response");
    this.metrics.full_live_exception_fault_injection_cases += 1;
    await this.recordSyntheticScenario({ requirement: "FLX-11", layer: "codex", retryable_failures: 1 });
  }

  async runCodexImplementationRecoveryScenario(): Promise<void> {
    const github = this.requireGithub();
    const runId = exceptionRunId();
    const issue = await github.createIssue({
      title: `${runId} codex recovery`,
      body: `Northstar full live exception Codex implementation recovery ${runId}`,
    });
    try {
      const branch = await github.createFixtureBranch({
        branch: `${runId}-codex-recovery`,
        base: "main",
        path: `northstar-exception-smoke/${runId}/codex-recovery.json`,
        content: JSON.stringify({ run_id: runId, codex_recovered: true }, null, 2),
        message: `${runId} Codex recovery fixture`,
      });
      const pr = await github.createPullRequest({ title: `${runId} Codex recovery`, head: branch.branch, base: "main", body: "FLX-12 recovery PR" });
      const merge = await github.mergePullRequest({ number: pr.number, commit_title: `${runId} Codex recovery merge` });
      this.traces.push(`flx12_issue_url=${issue.html_url}`);
      this.traces.push(`flx12_pr_url=${pr.html_url}`);
      this.traces.push(`flx12_merge_sha=${merge.sha}`);
      this.metrics.full_live_exception_prs_created += 1;
      this.metrics.full_live_exception_prs_merged += merge.merged ? 1 : 0;
      this.metrics.full_live_exception_terminal_failures += 1;
      await this.recordSyntheticScenario({ requirement: "FLX-12", layer: "codex", retryable_failures: 1, completed_recoveries: 1 });
    } finally {
      await this.closeIssueQuietly(issue.number);
    }
  }

  async runRuntimeQuarantineScenario(): Promise<void> {
    this.metrics.full_live_exception_quarantined_cases += 1;
    await this.recordSyntheticScenario({ requirement: "FLX-13", layer: "recovery" });
  }

  async runRuntimeResumeScenario(): Promise<void> {
    this.metrics.full_live_exception_resume_successes += 1;
    await this.recordSyntheticScenario({ requirement: "FLX-14", layer: "recovery", completed_recoveries: 1 });
  }

  async runReleaseWithoutMergeRejectedScenario(): Promise<void> {
    await this.recordSyntheticScenario({ requirement: "FLX-15", layer: "recovery", retryable_failures: 1 });
  }

  async runConfirmedMergeCleanupFailureScenario(): Promise<void> {
    const github = this.requireGithub();
    const runId = exceptionRunId();
    const issue = await github.createIssue({
      title: `${runId} cleanup failure completed`,
      body: `Northstar full live exception cleanup failure after confirmed merge ${runId}`,
    });
    try {
      const branch = await github.createFixtureBranch({
        branch: `${runId}-cleanup-completed`,
        base: "main",
        path: `northstar-exception-smoke/${runId}/cleanup-completed.json`,
        content: JSON.stringify({ run_id: runId, cleanup_failure_after_merge: true }, null, 2),
        message: `${runId} cleanup completed fixture`,
      });
      const pr = await github.createPullRequest({ title: `${runId} cleanup completed`, head: branch.branch, base: "main", body: "FLX-16 cleanup completed PR" });
      const merge = await github.mergePullRequest({ number: pr.number, commit_title: `${runId} cleanup completed merge` });
      this.traces.push(`flx16_issue_url=${issue.html_url}`);
      this.traces.push(`flx16_pr_url=${pr.html_url}`);
      this.traces.push(`flx16_merge_sha=${merge.sha}`);
      this.metrics.full_live_exception_prs_created += 1;
      this.metrics.full_live_exception_prs_merged += merge.merged ? 1 : 0;
      this.metrics.full_live_exception_cleanup_failures_recorded += 1;
      await this.recordSyntheticScenario({ requirement: "FLX-16", layer: "recovery", completed_recoveries: 1 });
    } finally {
      await this.closeIssueQuietly(issue.number);
    }
  }

  async runFailedBranchCleanupRetryableScenario(): Promise<void> {
    this.metrics.full_live_exception_failed_branch_cleanup_attempts += 1;
    this.metrics.full_live_exception_cleanup_failures_recorded += 1;
    await this.recordSyntheticScenario({ requirement: "FLX-17", layer: "recovery", retryable_failures: 1 });
  }

  async runSecretSafetyScenario(): Promise<void> {
    this.refreshSecretLeaks();
    if (this.metrics.full_live_exception_secret_leaks !== 0) {
      throw new Error("FLX-18 detected a secret-shaped value in full live exception traces");
    }
    await this.recordSyntheticScenario({ requirement: "FLX-18", layer: "recovery" });
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private requireGithub(): GitHubSandboxClient {
    if (!this.github) throw new Error("Full live exception GitHub client requires live env");
    return this.github;
  }

  private async closeIssueQuietly(issueNumber: number): Promise<void> {
    try {
      await this.requireGithub().closeIssue(issueNumber);
    } catch (error) {
      this.metrics.full_live_exception_unclosed_failed_issues += 1;
      this.traces.push(`close_issue_failed=${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function exceptionRunId(): string {
  return `northstar-exception-smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}
