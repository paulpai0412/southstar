import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubSandboxClient } from "../e2e-full-live/github-sandbox.ts";
import { CodexFullLiveWorker } from "../e2e-full-live/codex-worker.ts";
import { OpenCodeFullLiveWorker } from "../e2e-full-live-opencode/opencode-worker.ts";
import { PiSdkSoftwareDevWorker } from "../../src/adapters/host/pi-worker.ts";
import { loadConfig } from "../../src/config/load-config.ts";
import { createDefaultDomainDriverRegistry } from "../../src/orchestrator/domain-registry.ts";
import { createProductionOrchestratorFromFactory } from "../../src/orchestrator/production-factory.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { redactSecrets } from "../../src/runtime/redaction.ts";
import {
  QueuedHostSessionBridge,
  SoftwareDevDomainDriver,
  type SoftwareDevGitHubGateway,
  type SoftwareDevMetrics,
  type SoftwareDevWorker,
  type SoftwareDevWorkerResult,
} from "../../src/orchestrator/software-dev-driver.ts";

const defaultSandboxRepo = "paulpai0412/northstar-live-sandbox";

interface ProductionLiveMetrics {
  production_live_issues_created: number;
  production_live_opencode_runs_completed: number;
  production_live_codex_runs_completed: number;
  production_live_pi_runs_completed: number;
  production_live_prs_created: number;
  production_live_prs_merged: number;
  production_live_completed: number;
  production_live_confirmed_merge_facts: number;
  production_live_github_issues_closed: number;
  production_live_secret_leaks: number;
  production_live_shell_fallbacks: number;
  production_live_runs_against_configured_repo: number;
}

test("production live E2E clear-skips without live flag", (t) => {
  if (process.env.NORTHSTAR_PRODUCTION_LIVE !== "1") {
    t.skip("Set NORTHSTAR_PRODUCTION_LIVE=1 to run production live E2E.");
    return;
  }

  assert.ok(process.env.GITHUB_TOKEN, "GITHUB_TOKEN is required");
  assert.equal(resolveProductionLiveRepo(process.env), process.env.NORTHSTAR_LIVE_GITHUB_REPO ?? defaultSandboxRepo);
});

test("production live harness resolves the configured GitHub repo", () => {
  assert.equal(resolveProductionLiveRepo({}), defaultSandboxRepo);
  assert.equal(resolveProductionLiveRepo({ NORTHSTAR_LIVE_GITHUB_REPO: "owner/custom-consumer" }), "owner/custom-consumer");
});

test("production live E2E requires real GitHub and SDK-backed production path", async (t) => {
  if (process.env.NORTHSTAR_PRODUCTION_LIVE !== "1") {
    t.skip("Set NORTHSTAR_PRODUCTION_LIVE=1 to run production live E2E.");
    return;
  }

  const missing = ["GITHUB_TOKEN", "NORTHSTAR_LIVE_GITHUB_REPO"].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing production live E2E configuration: ${missing.join(", ")}`);
  }
  const configuredRepo = resolveProductionLiveRepo(process.env);

  const metrics = emptyProductionLiveMetrics();
  const github = new GitHubSandboxClient({
    repo: configuredRepo,
    token: process.env.GITHUB_TOKEN!,
  });

  await runProductionLiveFlow({ kind: "opencode", github, repo: configuredRepo, metrics });
  await runProductionLiveFlow({ kind: "codex", github, repo: configuredRepo, metrics });
  await runProductionLiveFlow({ kind: "pi", github, repo: configuredRepo, metrics });
  metrics.production_live_runs_against_configured_repo = configuredRepo === process.env.NORTHSTAR_LIVE_GITHUB_REPO ? 1 : 0;
  t.diagnostic(formatProductionLiveSummary(metrics));

  assert.equal(metrics.production_live_issues_created, 3);
  assert.equal(metrics.production_live_opencode_runs_completed, 1);
  assert.equal(metrics.production_live_codex_runs_completed, 1);
  assert.equal(metrics.production_live_pi_runs_completed, 1);
  assert.equal(metrics.production_live_prs_created, 3);
  assert.equal(metrics.production_live_prs_merged, 3);
  assert.equal(metrics.production_live_completed, 3);
  assert.equal(metrics.production_live_confirmed_merge_facts, 3);
  assert.equal(metrics.production_live_github_issues_closed, 3);
  assert.equal(metrics.production_live_secret_leaks, 0);
  assert.equal(metrics.production_live_shell_fallbacks, 0);
  assert.equal(metrics.production_live_runs_against_configured_repo, 1);
});

function formatProductionLiveSummary(metrics: ProductionLiveMetrics): string {
  return Object.entries(metrics).map(([key, value]) => `${key}=${value}`).join(" ");
}

function emptyProductionLiveMetrics(): ProductionLiveMetrics {
  return {
    production_live_issues_created: 0,
    production_live_opencode_runs_completed: 0,
    production_live_codex_runs_completed: 0,
    production_live_pi_runs_completed: 0,
    production_live_prs_created: 0,
    production_live_prs_merged: 0,
    production_live_completed: 0,
    production_live_confirmed_merge_facts: 0,
    production_live_github_issues_closed: 0,
    production_live_secret_leaks: 0,
    production_live_shell_fallbacks: 0,
    production_live_runs_against_configured_repo: 0,
  };
}

function resolveProductionLiveRepo(env: Record<string, string | undefined>): string {
  return env.NORTHSTAR_LIVE_GITHUB_REPO ?? defaultSandboxRepo;
}

async function runProductionLiveFlow(input: {
  kind: "opencode" | "codex" | "pi";
  github: GitHubSandboxClient;
  repo: string;
  metrics: ProductionLiveMetrics;
}): Promise<void> {
  const runId = `northstar-production-live-${input.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const issue = await input.github.createIssue({
    title: `${runId} production orchestrator`,
    body: `Production orchestrator live E2E for ${input.kind}: ${runId}`,
  });
  input.metrics.production_live_issues_created += 1;

  const dir = await mkdtemp(join(tmpdir(), `northstar-production-live-${input.kind}-`));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const host = new QueuedHostSessionBridge();
  const worker = input.kind === "opencode"
    ? new OpenCodeFullLiveWorker()
    : input.kind === "codex"
      ? new CodexFullLiveWorker()
      : new ProductionLivePiWorker({ workingDirectory: dir });
  const softwareMetrics = emptySoftwareDevMetrics();
  const domain = new SoftwareDevDomainDriver({
    kind: input.kind,
    runId,
    repo: input.repo,
    github: new ProductionLiveGitHubGateway(input.github, input.metrics),
    host,
    worker: worker as SoftwareDevWorker,
    metrics: softwareMetrics,
  });
  let issueClosed = false;

  try {
    const registry = createDefaultDomainDriverRegistry({
      softwareDevelopmentFactory: () => domain,
    });
    const config = loadConfig("tests/fixtures/.northstar.yaml");
    const orchestrator = createProductionOrchestratorFromFactory({
      config: {
        ...config,
        project: { ...config.project, root: dir },
        github: { ...config.github, repo: input.repo },
      },
      store,
      host,
      registry,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => new Date().toISOString(),
      usage: "cli",
    }).orchestrator;

    await orchestrator.intakeIssue({
      issueNumber: issue.number,
      title: `${runId} production orchestrator`,
      body: `Production orchestrator live E2E for ${input.kind}: ${runId}`,
      sourceUrl: issue.html_url,
      labels: ["northstar:production-live"],
    });
    await orchestrator.startIssue({ issueId: `github:${issue.number}` });
    await orchestrator.reconcileIssue({ issueId: `github:${issue.number}` });
    await orchestrator.releaseIssue({ issueId: `github:${issue.number}`, autoRelease: true });
    const inspect = orchestrator.inspectIssue({ issueId: `github:${issue.number}` });

    if (inspect.lifecycle_state !== "completed") {
      throw new Error(`expected completed lifecycle for ${input.kind}, got ${inspect.lifecycle_state}`);
    }
    if (input.kind === "opencode") input.metrics.production_live_opencode_runs_completed += 1;
    if (input.kind === "codex") input.metrics.production_live_codex_runs_completed += 1;
    if (input.kind === "pi") input.metrics.production_live_pi_runs_completed += 1;
    input.metrics.production_live_completed += 1;
    input.metrics.production_live_confirmed_merge_facts += 1;
    input.metrics.production_live_secret_leaks += softwareMetrics.software_dev_driver_secret_leaks;
    input.metrics.production_live_shell_fallbacks += softwareMetrics.software_dev_driver_shell_fallbacks;
    issueClosed = true;
  } catch (error) {
    if (!issueClosed) {
      await cleanupIssue(input.github, issue.number, error);
    }
    throw error;
  } finally {
    store.close();
    await worker.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
}

class ProductionLivePiWorker implements SoftwareDevWorker {
  private readonly worker: PiSdkSoftwareDevWorker;
  private readonly workingDirectory: string;

  constructor(input: { workingDirectory: string }) {
    this.workingDirectory = input.workingDirectory;
    this.worker = new PiSdkSoftwareDevWorker({ workingDirectory: input.workingDirectory });
  }

  async runImplementation(input: Parameters<SoftwareDevWorker["runImplementation"]>[0]): Promise<SoftwareDevWorkerResult> {
    return await this.worker.runImplementation({ ...input, worktree_path: this.workingDirectory });
  }

  async runVerification(input: Parameters<SoftwareDevWorker["runVerification"]>[0]): Promise<SoftwareDevWorkerResult> {
    return await this.worker.runVerification(input);
  }
}

class ProductionLiveGitHubGateway implements SoftwareDevGitHubGateway {
  private readonly github: GitHubSandboxClient;
  private readonly metrics: ProductionLiveMetrics;

  constructor(github: GitHubSandboxClient, metrics: ProductionLiveMetrics) {
    this.github = github;
    this.metrics = metrics;
  }

  async createFixtureBranch(input: Parameters<SoftwareDevGitHubGateway["createFixtureBranch"]>[0]): Promise<{ branch: string; commit_sha: string }> {
    return await this.github.createFixtureBranch(input);
  }

  async readBranchCommit(input: Parameters<SoftwareDevGitHubGateway["readBranchCommit"]>[0]): Promise<{ branch: string; commit_sha: string }> {
    return await this.github.readBranchCommit(input);
  }

  async createPullRequest(input: Parameters<SoftwareDevGitHubGateway["createPullRequest"]>[0]): Promise<{ number: number; html_url: string }> {
    const pr = await this.github.createPullRequest(input);
    this.metrics.production_live_prs_created += 1;
    return pr;
  }

  async mergePullRequest(input: Parameters<SoftwareDevGitHubGateway["mergePullRequest"]>[0]): Promise<{ merged: boolean; sha: string }> {
    const merge = await this.github.mergePullRequest(input);
    this.metrics.production_live_prs_merged += merge.merged ? 1 : 0;
    return merge;
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.github.closeIssue(issueNumber);
    this.metrics.production_live_github_issues_closed += 1;
  }
}

function emptySoftwareDevMetrics(): SoftwareDevMetrics {
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

async function cleanupIssue(github: GitHubSandboxClient, issueNumber: number, error: unknown): Promise<void> {
  const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000);
  try {
    await github.addIssueComment(issueNumber, `Production live E2E failed and cleaned up this issue.\n\nReason: ${reason}`);
  } catch {
    // Best-effort cleanup only.
  }
  try {
    await github.closeIssue(issueNumber);
  } catch {
    // Best-effort cleanup only.
  }
}
