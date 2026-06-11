import { GitHubSandboxClient } from "./github-sandbox.ts";
import { CodexFullLiveWorker } from "./codex-worker.ts";
import { createFullLiveRuntimeDriver } from "./runtime-driver.ts";
import { emptyFullLiveMetrics, hasFullLiveSecretLeak, type FullLiveMetrics } from "./metrics.ts";
import type { FullLiveEnv } from "./env.ts";
import { redactSecrets } from "../../src/runtime/redaction.ts";

interface IssueRunResult {
  metrics: FullLiveMetrics;
  started_at: number;
  completed_at: number;
  issue_number: number;
  issue_url: string;
  pr_number: number;
  pr_url: string;
  merge_sha: string;
  fixture_path: string;
  completed: boolean;
  merged: boolean;
}

interface IssueMetricInput {
  started_at: number;
  completed_at: number;
  completed: boolean;
  merged: boolean;
  fixture_path: string;
}

export class FullLiveHarness {
  private readonly github: GitHubSandboxClient;
  private readonly codex = new CodexFullLiveWorker();
  private readonly env: FullLiveEnv;
  private readonly traces: string[] = [];

  constructor(env: FullLiveEnv) {
    this.env = env;
    this.github = new GitHubSandboxClient({ repo: env.repo, token: env.token });
  }

  traceSummary(): string {
    return this.traces.join(" ");
  }

  async runSingleIssueScenario(): Promise<FullLiveMetrics> {
    const started = Date.now();
    const result = await this.runOneIssue({ scenario: "single", sequence: 1 });
    result.metrics.full_live_single_duration_seconds = Math.ceil((Date.now() - started) / 1000);
    return result.metrics;
  }

  async runSequentialIssuesScenario(): Promise<FullLiveMetrics> {
    const started = Date.now();
    const first = await this.runOneIssue({ scenario: "sequential", sequence: 1 });
    const second = await this.runOneIssue({ scenario: "sequential", sequence: 2 });
    const duration = Math.ceil((Date.now() - started) / 1000);
    return buildSequentialMetrics([first, second], duration);
  }

  async runParallelIssuesScenario(): Promise<FullLiveMetrics> {
    const started = Date.now();
    const [first, second] = await Promise.all([
      this.runOneIssue({ scenario: "parallel", sequence: 1 }),
      this.runOneIssue({ scenario: "parallel", sequence: 2 }),
    ]);
    const duration = Math.ceil((Date.now() - started) / 1000);
    return buildParallelMetrics([first, second], duration);
  }

  private async runOneIssue(input: { scenario: "single" | "sequential" | "parallel"; sequence: number }): Promise<IssueRunResult> {
    const startedAt = Date.now();
    const metrics = emptyFullLiveMetrics();
    const runId = smokeRunId();
    const issue = await this.github.createIssue({
      title: `${runId} ${input.scenario} issue ${input.sequence}`,
      body: `Northstar full live ${input.scenario} issue ${input.sequence} smoke ${runId}`,
    });
    metrics.full_live_issues_created += 1;
    this.traces.push(`issue_${input.scenario}_${input.sequence}=${issue.number}`);
    this.traces.push(`issue_url_${input.scenario}_${input.sequence}=${issue.html_url}`);

    const fixturePath = `northstar-smoke/${runId}/${input.scenario}-${input.sequence}-issue-${issue.number}.json`;
    const fixtureContent = JSON.stringify({
      run_id: runId,
      issue_number: issue.number,
      scenario: input.scenario,
      sequence: input.sequence,
      implemented_by: "codex",
    }, null, 2);
    const branchName = `${runId}-${input.scenario}-${input.sequence}-issue-${issue.number}`;

    const driver = await createFullLiveRuntimeDriver();
    let issueClosed = false;
    try {
      const runtimeIssue = driver.seedIssue({ issue_number: issue.number, title: `${runId} ${input.scenario}`, source_url: issue.html_url });
      driver.startImplementation(runtimeIssue.issue_id);
      const implementation = await this.codex.runImplementation({
        issue_number: issue.number,
        issue_url: issue.html_url,
        repo: this.env.repo,
        branch: branchName,
        fixture_path: fixturePath,
        fixture_content: fixtureContent,
      });
      ensureWorkerReturned("implementation", implementation.final_response);
      metrics.full_live_codex_root_sessions_started += implementation.root_session_id ? 1 : 0;
      metrics.full_live_codex_child_runs_started += implementation.child_run_id ? 1 : 0;

      const branch = await this.github.createFixtureBranch({
        branch: branchName,
        base: "main",
        path: fixturePath,
        content: fixtureContent,
        message: `${runId} fixture for issue ${issue.number}`,
      });
      metrics.full_live_branches_pushed += 1;
      metrics.full_live_fixture_files_created += 1;

      const pr = await this.github.createPullRequest({
        title: `${runId} issue ${issue.number}`,
        head: branch.branch,
        base: "main",
        body: `Full live E2E PR for issue ${issue.number}`,
      });
      metrics.full_live_prs_created += 1;
      this.traces.push(`pr_${input.scenario}_${input.sequence}=${pr.number}`);
      this.traces.push(`pr_url_${input.scenario}_${input.sequence}=${pr.html_url}`);

      driver.submitWorkerResult(runtimeIssue.issue_id, {
        branch: branch.branch,
        commit_sha: branch.commit_sha,
        changed_files: [fixturePath],
        self_check_summary: "Codex full live implementation completed",
      });
      driver.startVerification(runtimeIssue.issue_id);
      const verification = await this.codex.runVerification({
        pr_number: pr.number,
        pr_url: pr.html_url,
        expected_fixture_path: fixturePath,
      });
      ensureWorkerReturned("verification", verification.final_response);
      metrics.full_live_codex_root_sessions_started += verification.root_session_id ? 1 : 0;
      metrics.full_live_codex_child_runs_started += verification.child_run_id ? 1 : 0;

      const files = await this.github.listPullRequestFiles(pr.number);
      const actualContent = await this.github.readFileContent({ path: fixturePath, ref: branch.branch });
      assertFixtureGate({ files, expected_path: fixturePath, expected_content: fixtureContent, actual_content: actualContent });
      metrics.full_live_fixture_content_matches += 1;
      driver.submitVerifierEvidence(runtimeIssue.issue_id, { pr_number: pr.number, gate_results: [{ name: "fixture gate", status: "pass" }] });
      driver.claimRelease(runtimeIssue.issue_id);
      const merge = await this.github.mergePullRequest({ number: pr.number, commit_title: `${runId} merge issue ${issue.number}` });
      metrics.full_live_prs_merged += merge.merged ? 1 : 0;
      this.traces.push(`merge_sha_${input.scenario}_${input.sequence}=${merge.sha}`);
      const completed = driver.submitReleaseSuccess(runtimeIssue.issue_id, { merge_sha: merge.sha });
      metrics.full_live_runtime_issues_completed += completed.lifecycle_state === "completed" ? 1 : 0;
      metrics.full_live_confirmed_merge_facts = driver.confirmedMergeFacts();
      await this.github.closeIssue(issue.number);
      issueClosed = true;
      metrics.full_live_github_issues_closed += 1;
      metrics.full_live_secret_leaks = hasFullLiveSecretLeak(`${this.traceSummary()} ${JSON.stringify(metrics)}`) ? 1 : 0;
      const completedAt = Date.now();
      return {
        metrics,
        started_at: startedAt,
        completed_at: completedAt,
        issue_number: issue.number,
        issue_url: issue.html_url,
        pr_number: pr.number,
        pr_url: pr.html_url,
        merge_sha: merge.sha,
        fixture_path: fixturePath,
        completed: completed.lifecycle_state === "completed",
        merged: merge.merged,
      };
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
    const body = [
      "Full live E2E failed after creating this smoke issue.",
      "",
      `Reason: ${reason}`,
      "",
      "The harness is closing this northstar-smoke issue automatically so failed live attempts do not remain open.",
    ].join("\n");

    try {
      await this.github.addIssueComment(issueNumber, body);
    } catch (commentError) {
      this.traces.push(`cleanup_comment_failed_issue_${issueNumber}=${redactSecrets(commentError instanceof Error ? commentError.message : String(commentError))}`);
    }
    try {
      await this.github.closeIssue(issueNumber);
    } catch (closeError) {
      this.traces.push(`cleanup_close_failed_issue_${issueNumber}=${redactSecrets(closeError instanceof Error ? closeError.message : String(closeError))}`);
    }
  }
}

export function buildSequentialMetrics(results: [IssueMetricInput, IssueMetricInput], durationSeconds: number): FullLiveMetrics {
  const metrics = emptyFullLiveMetrics();
  metrics.full_live_sequential_issues_created = results.length;
  metrics.full_live_sequential_completed = results.filter((result) => result.completed).length;
  metrics.full_live_sequential_prs_created = results.length;
  metrics.full_live_sequential_prs_merged = results.filter((result) => result.merged).length;
  metrics.full_live_sequential_ordering_violations = results[0].completed_at <= results[1].started_at ? 0 : 1;
  metrics.full_live_sequential_max_active_issue_workers = 1;
  metrics.full_live_sequential_fixture_files_created = distinctFixtureCount(results);
  metrics.full_live_sequential_cross_issue_contamination = distinctFixtureCount(results) === results.length ? 0 : 1;
  metrics.full_live_sequential_duration_seconds = durationSeconds;
  return metrics;
}

export function buildParallelMetrics(results: [IssueMetricInput, IssueMetricInput], durationSeconds: number): FullLiveMetrics {
  const metrics = emptyFullLiveMetrics();
  metrics.full_live_parallel_issues_created = results.length;
  metrics.full_live_parallel_completed = results.filter((result) => result.completed).length;
  metrics.full_live_parallel_prs_created = results.length;
  metrics.full_live_parallel_prs_merged = results.filter((result) => result.merged).length;
  metrics.full_live_parallel_overlap_seconds = overlapSeconds(results[0], results[1]);
  metrics.full_live_parallel_max_active_issue_workers = metrics.full_live_parallel_overlap_seconds > 0 ? 2 : 1;
  metrics.full_live_parallel_fixture_files_created = distinctFixtureCount(results);
  metrics.full_live_parallel_cross_issue_contamination = distinctFixtureCount(results) === results.length ? 0 : 1;
  metrics.full_live_parallel_merge_conflicts = results.every((result) => result.merged) ? 0 : 1;
  metrics.full_live_parallel_duration_seconds = durationSeconds;
  return metrics;
}

export function assertFixtureGate(input: {
  files: Array<{ filename: string }>;
  expected_path: string;
  expected_content: string;
  actual_content: string;
}): void {
  if (!input.files.some((file) => file.filename === input.expected_path)) {
    throw new Error(`missing expected fixture path ${input.expected_path}`);
  }
  if (input.actual_content !== input.expected_content) {
    throw new Error(`fixture content mismatch for ${input.expected_path}`);
  }
}

function smokeRunId(): string {
  return `northstar-smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureWorkerReturned(role: "implementation" | "verification", finalResponse: string): void {
  if (finalResponse.trim().length === 0) {
    throw new Error(`Codex ${role} child returned an empty response`);
  }
  if (hasFullLiveSecretLeak(finalResponse)) {
    throw new Error(`Codex ${role} child response contained a secret-shaped value`);
  }
}

function distinctFixtureCount(results: IssueMetricInput[]): number {
  return new Set(results.map((result) => result.fixture_path)).size;
}

function overlapSeconds(first: IssueMetricInput, second: IssueMetricInput): number {
  const overlapMs = Math.max(0, Math.min(first.completed_at, second.completed_at) - Math.max(first.started_at, second.started_at));
  return Math.ceil(overlapMs / 1000);
}
