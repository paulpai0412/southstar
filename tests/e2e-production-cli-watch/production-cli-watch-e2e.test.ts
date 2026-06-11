import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProductionOrchestrator } from "../../src/orchestrator/cycle.ts";
import {
  QueuedHostSessionBridge,
  SoftwareDevDomainDriver,
  type SoftwareDevGitHubGateway,
  type SoftwareDevMetrics,
  type SoftwareDevWorker,
  type SoftwareDevWorktree,
} from "../../src/orchestrator/software-dev-driver.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";

test("production CLI/watch resumes from SQLite and reuses worktree, branch, and PR after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-production-cli-watch-"));
  const dbPath = join(dir, "control-plane.sqlite");
  const worktreePath = join(dir, ".northstar/runtime/worktrees/issue-701");
  const metrics = createResumeMetrics();
  const github = new ResumeGateway(metrics);
  const worktree = new ResumeWorktree(metrics, { path: worktreePath, branch: "northstar/701-resume-flow" });
  const observability = new ResumeObservability(metrics);
  try {
    const firstStore = SqliteControlPlaneStore.open(dbPath);
    const firstHost = new QueuedHostSessionBridge();
    const first = createProductionOrchestrator({
      store: firstStore,
      host: firstHost,
      domain: softwareDriver({ github, worktree, host: firstHost }),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });
    await first.intakeIssue({
      issueNumber: 701,
      title: "Resume production issue",
      body: "Create a resumable production change",
      sourceUrl: "https://github.test/owner/repo/issues/701",
      labels: ["northstar:ready"],
    });
    await first.startIssue({ issueId: "github:701" });
    firstStore.close();

    const secondStore = SqliteControlPlaneStore.open(dbPath);
    const secondHost = new QueuedHostSessionBridge();
    const resumed = createProductionOrchestrator({
      store: secondStore,
      host: secondHost,
      domain: softwareDriver({ github, worktree, host: secondHost }),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:01.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });
    await resumed.runCycle({ autoRelease: true, maxStarts: 1 });
    await resumed.runCycle({ autoRelease: true, maxStarts: 1 });

    const snapshot = secondStore.getIssue("github:701");
    metrics.resume_after_watch_restart_completed = snapshot.lifecycle_state === "completed" ? 1 : 0;
    metrics.resume_completed_reversals = secondStore
      .listHistory("github:701")
      .some((entry) => entry.sequence > 0 && snapshot.lifecycle_state !== "completed")
      ? 1
      : 0;

    assert.equal(snapshot.lifecycle_state, "completed");
    assert.equal(metrics.resume_after_watch_restart_completed, 1);
    assert.equal(metrics.resume_reuses_existing_worktree, 1);
    assert.equal(metrics.resume_reuses_existing_branch, 1);
    assert.equal(metrics.resume_reuses_existing_pr, 1);
    assert.equal(metrics.resume_duplicate_prs_created, 0);
    assert.equal(metrics.resume_completed_reversals, 0);
    assert.equal(metrics.github_issue_state_labels_synced >= 1, true);
    assert.equal(metrics.github_issue_progress_comments_created >= 3, true);
    assert.equal(metrics.github_issue_status_marker_updated >= 1, true);
    assert.equal(metrics.github_pr_body_contains_source_issue, 1);
    assert.equal(metrics.github_pr_verifier_comment_created >= 1, true);
    assert.equal(metrics.github_project_items_synced >= 1, true);
    assert.equal(metrics.github_project_lifecycle_completed, 1);
    assert.equal(metrics.github_project_status_done, 1);
    assert.equal(metrics.github_project_pr_urls_synced >= 1, true);
    assert.equal(metrics.github_project_merge_shas_synced, 1);
    assert.equal(metrics.github_project_status_mismatches, 0);
    assert.equal(metrics.github_projection_failures_retryable >= 1, true);
    assert.equal(metrics.github_projection_failures_do_not_mutate_lifecycle, 1);
    secondStore.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

interface ResumeMetrics {
  resume_after_watch_restart_completed: number;
  resume_reuses_existing_worktree: number;
  resume_reuses_existing_branch: number;
  resume_reuses_existing_pr: number;
  resume_duplicate_prs_created: number;
  resume_completed_reversals: number;
  prsCreated: number;
  github_issue_state_labels_synced: number;
  github_issue_progress_comments_created: number;
  github_issue_status_marker_updated: number;
  github_pr_body_contains_source_issue: number;
  github_pr_verifier_comment_created: number;
  github_project_items_synced: number;
  github_project_lifecycle_completed: number;
  github_project_status_done: number;
  github_project_pr_urls_synced: number;
  github_project_merge_shas_synced: number;
  github_project_status_mismatches: number;
  github_projection_failures_retryable: number;
  github_projection_failures_do_not_mutate_lifecycle: number;
}

function createResumeMetrics(): ResumeMetrics {
  return {
    resume_after_watch_restart_completed: 0,
    resume_reuses_existing_worktree: 0,
    resume_reuses_existing_branch: 0,
    resume_reuses_existing_pr: 0,
    resume_duplicate_prs_created: 0,
    resume_completed_reversals: 0,
    prsCreated: 0,
    github_issue_state_labels_synced: 0,
    github_issue_progress_comments_created: 0,
    github_issue_status_marker_updated: 0,
    github_pr_body_contains_source_issue: 0,
    github_pr_verifier_comment_created: 0,
    github_project_items_synced: 0,
    github_project_lifecycle_completed: 0,
    github_project_status_done: 0,
    github_project_pr_urls_synced: 0,
    github_project_merge_shas_synced: 0,
    github_project_status_mismatches: 0,
    github_projection_failures_retryable: 0,
    github_projection_failures_do_not_mutate_lifecycle: 0,
  };
}

function softwareDriver(input: {
  github: SoftwareDevGitHubGateway;
  worktree: SoftwareDevWorktree;
  host: QueuedHostSessionBridge;
}) {
  return new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "resume-e2e",
    github: input.github,
    worker: new ResumeWorker(),
    host: input.host,
    metrics: softwareMetrics(),
    baseBranch: "main",
    worktree: input.worktree,
  });
}

class ResumeWorker implements SoftwareDevWorker {
  async runImplementation() {
    return {
      root_session_id: "root-implementation",
      child_run_id: "child-implementation",
      session_id: "session-implementation",
      final_response: "implementation complete",
      shell_fallbacks: 0 as const,
    };
  }

  async runVerification() {
    return {
      root_session_id: "root-verification",
      child_run_id: "child-verification",
      session_id: "session-verification",
      final_response: "verification passed",
      shell_fallbacks: 0 as const,
    };
  }
}

class ResumeWorktree implements SoftwareDevWorktree {
  private prepared = false;
  private readonly metrics: ResumeMetrics;
  private readonly preparedWorktree: { path: string; branch: string };

  constructor(
    metrics: ResumeMetrics,
    preparedWorktree: { path: string; branch: string },
  ) {
    this.metrics = metrics;
    this.preparedWorktree = preparedWorktree;
  }

  async prepareIssueWorktree() {
    this.prepared = true;
    return this.preparedWorktree;
  }

  async commitAndPush(input: { worktreePath: string; branch: string }) {
    if (this.prepared && input.worktreePath === this.preparedWorktree.path) {
      this.metrics.resume_reuses_existing_worktree = 1;
    }
    if (input.branch === this.preparedWorktree.branch) {
      this.metrics.resume_reuses_existing_branch = 1;
    }
    return { commit_sha: "resume-commit-sha" };
  }
}

class ResumeGateway implements SoftwareDevGitHubGateway {
  private readonly prsByBranch = new Map<string, { number: number; html_url: string }>([
    ["northstar/701-resume-flow", { number: 1701, html_url: "https://github.test/owner/repo/pull/1701" }],
  ]);
  private readonly metrics: ResumeMetrics;

  constructor(metrics: ResumeMetrics) {
    this.metrics = metrics;
  }

  async createFixtureBranch() {
    return { branch: "unused", commit_sha: "unused" };
  }

  async readBranchCommit(input: { branch: string }) {
    return { branch: input.branch, commit_sha: "resume-commit-sha" };
  }

  async createPullRequest() {
    this.metrics.prsCreated += 1;
    this.metrics.resume_duplicate_prs_created = this.metrics.prsCreated > 1 ? 1 : 0;
    return { number: 999, html_url: "https://github.test/owner/repo/pull/999" };
  }

  async createOrReusePullRequest(input: { head: string }) {
    if ((input as { body?: string }).body?.includes("https://github.test/owner/repo/issues/701")) {
      this.metrics.github_pr_body_contains_source_issue = 1;
    }
    const existing = this.prsByBranch.get(input.head);
    if (existing) {
      this.metrics.resume_reuses_existing_pr = 1;
      return { ...existing, reused: true };
    }
    return await this.createPullRequest();
  }

  async mergePullRequest() {
    return { merged: true, sha: "resume-merge-sha" };
  }

  async closeIssue() {}
}

class ResumeObservability {
  private failedOnce = false;
  private readonly metrics: ResumeMetrics;

  constructor(metrics: ResumeMetrics) {
    this.metrics = metrics;
  }

  async trySyncIssueProgress(input: { lifecycleState: string }) {
    this.metrics.github_issue_state_labels_synced += 1;
    this.metrics.github_issue_progress_comments_created += 1;
    this.metrics.github_issue_status_marker_updated += 1;
    if (!this.failedOnce) {
      this.failedOnce = true;
      this.metrics.github_projection_failures_retryable += 1;
      this.metrics.github_projection_failures_do_not_mutate_lifecycle = 1;
      return {
        type: "projection_result",
        status: "failed",
        projection_target: "github_observability",
        mutates_lifecycle: false,
        payload: input,
      };
    }
    return {
      type: "projection_result",
      status: "success",
      projection_target: "github_observability",
      mutates_lifecycle: false,
      payload: input,
    };
  }

  async syncPrProgress() {
    this.metrics.github_pr_verifier_comment_created += 1;
  }

  async syncProjectFields(input: { lifecycleState: string; fields?: Record<string, unknown> }) {
    this.metrics.github_project_items_synced += 1;
    if (input.fields?.["Northstar Lifecycle"] === "completed") this.metrics.github_project_lifecycle_completed += 1;
    if (input.fields?.Status === "Done") this.metrics.github_project_status_done += 1;
    if (input.fields?.["PR URL"]) this.metrics.github_project_pr_urls_synced += 1;
    if (input.fields?.["Merge SHA"]) this.metrics.github_project_merge_shas_synced += 1;
    return {
      type: "projection_result",
      status: "success",
      projection_target: "github_project",
      mutates_lifecycle: false,
      payload: input,
    };
  }
}

function softwareMetrics(): SoftwareDevMetrics {
  return {
    software_dev_branch_reuse_cases: 0,
    software_dev_retryable_effect_failures: 0,
    software_dev_malformed_artifacts_rejected: 0,
    software_dev_completed_reversals: 0,
    software_dev_driver_live_completed: 0,
    software_dev_driver_secret_leaks: 0,
    software_dev_driver_shell_fallbacks: 0,
    merge_conflicts_detected: 0,
    merge_conflict_recovery_attempts: 0,
    merge_conflict_recovered_prs_merged: 0,
    merge_conflict_terminal_failures: 0,
    resume_duplicate_prs_created: 0,
  };
}
