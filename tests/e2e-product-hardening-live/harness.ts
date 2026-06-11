import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProductHardeningLiveEnv } from "./env.ts";
import {
  emptyProductHardeningMetrics,
  finalizeProductHardeningMetrics,
  type ProductHardeningMetrics,
} from "./metrics.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { redactSecrets } from "../../src/runtime/redaction.ts";
import { GitHubSandboxClient, type SandboxIssue } from "../e2e-full-live/github-sandbox.ts";

export interface ProductHardeningLiveResult {
  metrics: ProductHardeningMetrics;
  issueUrls: string[];
  prUrls: string[];
  browserEvidencePath: string;
}

export interface SpecToIssuesLiveMetrics {
  spec_plan_inputs_validated: number;
  issues_generated_from_plan: number;
  dry_run_requires_no_github_mutation: number;
  apply_requires_confirmation: number;
  live_completed_issues: number;
  live_prs_merged: number;
  live_browser_tests_passed: number;
  secret_leaks_in_generated_issues: number;
}

export interface SpecToIssuesLiveResult {
  metrics: SpecToIssuesLiveMetrics;
  issueUrls: string[];
  prUrls: string[];
  browserEvidencePath: string;
}

interface SpecPlanIssueDraft {
  title: string;
  body: string;
}

interface SpecPlanGenerationResult {
  issueDrafts: SpecPlanIssueDraft[];
  metrics: {
    spec_plan_inputs_validated: number;
    issues_generated_from_plan: number;
    dry_run_requires_no_github_mutation: number;
  };
}

export interface ProductHardeningIssuePlanItem {
  key: "A" | "B" | "C" | "D" | "E";
  dependsOn: Array<"A" | "B" | "C" | "D" | "E">;
  consumerRunId: string;
  outputFile: string;
  expectedContent: string;
}

interface CreatedPlanIssue extends ProductHardeningIssuePlanItem {
  issueNumber: number;
  issueUrl: string;
}

interface CommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
}

interface WorkerWindow {
  issueNumber: number;
  startedAt: string;
  completedAt: string;
}

export interface BrowserEvidenceMetadata {
  source: "cdp";
  browser_name: string;
  browser_version: string;
  dom_assertion: {
    selector: string;
    expected_text: string;
    actual_text: string;
    passed: true;
  };
  screenshot: {
    path: string;
    width: number;
    height: number;
  };
}

export const productHardeningProjectReadBackFields = [
  "Northstar Lifecycle",
  "Status",
  "PR URL",
  "Merge SHA",
] as const;

const productHardeningProjectReadBackFieldAliases = [
  ["Northstar Lifecycle"],
  ["Status"],
  ["PR URL", "Northstar PR"],
  ["Merge SHA", "Northstar Merge SHA"],
] as const;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const productHardeningFailureCleanupLabel = "northstar:product-hardening-live-cleanup";
const defaultCdpCommandTimeoutMs = 10_000;

export function createProductHardeningIssuePlan(runId: string): ProductHardeningIssuePlanItem[] {
  return [
    planIssue("A", [], runId),
    planIssue("B", ["A"], runId),
    planIssue("C", ["A"], runId),
    planIssue("D", ["B", "C"], runId),
    planIssue("E", ["D"], runId),
  ];
}

export function productHardeningEvidenceRoot(consumerRoot: string): string {
  return join(consumerRoot, ".northstar/runtime/evidence/product-hardening-live");
}

export function productHardeningArtifactRoot(runId: string): string {
  return join(tmpdir(), "northstar-product-hardening-live-artifacts", runId);
}

export async function runProductHardeningLiveE2E(env: ProductHardeningLiveEnv): Promise<ProductHardeningLiveResult> {
  if (!env.sdkCredentialsAvailable) {
    throw new Error("SDK credentials are required for product hardening live E2E; configure Codex/OpenCode local auth or OPENAI_API_KEY/CODEX_API_KEY/OPENCODE_API_KEY.");
  }
  if (!env.repo || !env.projectId || !env.token) {
    throw new Error("Product hardening live E2E requires repo, projectId, and token.");
  }

  return await runRealProductHardeningLivePath(env);
}

export async function runSpecToIssuesLiveE2E(
  input: ProductHardeningLiveEnv & { confirmedApply: boolean },
): Promise<SpecToIssuesLiveResult> {
  if (input.confirmedApply !== true) {
    throw new Error("Spec-to-issues live E2E apply mode requires confirmedApply === true.");
  }
  if (!input.sdkCredentialsAvailable) {
    throw new Error("SDK credentials are required for spec-to-issues live E2E; configure Codex/OpenCode local auth or OPENAI_API_KEY/CODEX_API_KEY/OPENCODE_API_KEY.");
  }
  if (!input.repo || !input.projectId || !input.token) {
    throw new Error("Spec-to-issues live E2E requires repo, projectId, and token.");
  }

  return await runRealSpecToIssuesLivePath(input);
}

export async function writeProductHardeningConsumerConfig(input: {
  consumerRoot: string;
  repo: string;
  projectId: string;
}): Promise<void> {
  const workflowPath = join(input.consumerRoot, ".northstar/workflows/issue-to-pr-release.yaml");
  await mkdir(dirname(workflowPath), { recursive: true });
  await mkdir(join(input.consumerRoot, ".northstar/runtime"), { recursive: true });
  await writeFile(join(input.consumerRoot, ".northstar.yaml"), [
    'schema_version: "1.1"',
    "project:",
    "  name: product-hardening-live-consumer",
    `  root: "${input.consumerRoot}"`,
    "runtime:",
    "  db_path: .northstar/runtime/control-plane.sqlite3",
    "  host_adapter: codex",
    "  development_capacity: 2",
    "  release_capacity: 1",
    "  heartbeat_interval_seconds: 30",
    "  lease_timeout_seconds: 600",
    "  child_timeout_seconds: 900",
    "  watch_lock_stale_seconds: 120",
    "  max_recovery_attempts: 2",
    "  auto_release: true",
    "  session_scope: stage_root",
    "workflow:",
    "  package: builtin",
    "  id: issue_to_pr_release",
    '  version: "1.0"',
    "  domain: software_development",
    "  path: .northstar/workflows/issue-to-pr-release.yaml",
    "github:",
    `  repo: ${input.repo}`,
    "  intake:",
    "    enabled: true",
    "    label: northstar:ready",
    "  sync:",
    "    enabled: true",
    "    retry_backoff_seconds:",
    "      - 1",
    "      - 2",
    "  project:",
    "    enabled: true",
    `    project_id: ${input.projectId}`,
    "git:",
    "  base_branch: main",
    "  worktrees_dir: .northstar/runtime/worktrees",
    "  sync_worktree_dir: .northstar/runtime/sync-worktrees/main",
    "cleanup:",
    "  completed_worktrees: archive",
    "  keep_last: 5",
    "  failed_or_quarantined: keep",
    "policy:",
    "  github_sync_blocks_lifecycle: false",
    "  quarantine_requires_operator: true",
    "credentials:",
    "  github:",
    "    token_env: GITHUB_TOKEN",
    "    allow_gh_token_fallback: false",
    "  host_sdk:",
    "    codex:",
    "      mode: sdk_default",
    "    opencode:",
    "      mode: sdk_default",
  ].join("\n"));
  await writeFile(workflowPath, [
    "workflow:",
    "  id: issue_to_pr_release",
    '  version: "1.0"',
    "  domain: software_development",
    "  roles:",
    "    issue_worker:",
    "      run_mode: background_child",
    "      agent: build",
    "      model: gpt-5",
    "      load_skills:",
    "        - tdd",
    "      prompt_template: \"In {{worktree_path}}, implement the issue body exactly. Create or update only files requested by the issue body. Return {{expected_artifact_fields}}.\"",
    "      artifact: worker_result",
    "      timeout_seconds: 900",
    "      retry_policy:",
    "        max_attempts: 2",
    "        backoff_seconds:",
    "          - 1",
    "    pr_verifier:",
    "      run_mode: background_child",
    "      agent: review",
    "      model: gpt-5",
    "      load_skills:",
    "        - browser-qa",
    "      prompt_template: \"Verify the requested issue file exists in {{worktree_path}} and respond with PASS plus evidence. Return {{expected_artifact_fields}}.\"",
    "      artifact: evidence_packet",
    "      timeout_seconds: 900",
    "      retry_policy:",
    "        max_attempts: 2",
    "        backoff_seconds:",
    "          - 1",
    "    release_worker:",
    "      run_mode: background_child",
    "      agent: release",
    "      model: gpt-5",
    "      load_skills:",
    "        - git-master",
    "      artifact: release_result",
    "      timeout_seconds: 900",
    "  stages:",
    "    implementation:",
    "      lifecycle_state: running",
    "      role: issue_worker",
    "      on_success: verification",
    "      on_blocked: quarantined",
    "      on_failed_retryable: implementation",
    "      on_failed_terminal: failed",
    "    verification:",
    "      lifecycle_state: verifying",
    "      role: pr_verifier",
    "      on_pass: verified",
    "      on_success: verified",
    "      on_fail_retryable: implementation",
    "      on_fail_terminal: failed",
    "    release:",
    "      lifecycle_state: release_pending",
    "      role: release_worker",
    "      on_success: completed",
    "      on_blocked_transient: verified",
    "      on_failed_terminal: failed",
  ].join("\n"));
}

export async function writeBrowserEvidence(input: {
  consumerRoot: string;
  runId: string;
  issueUrls: string[];
  prUrls: string[];
  metrics: ProductHardeningMetrics;
  browserBin?: string;
}): Promise<string> {
  const evidenceRoot = productHardeningEvidenceRoot(input.consumerRoot);
  await mkdir(evidenceRoot, { recursive: true });
  const evidenceJsonPath = join(evidenceRoot, "browser-evidence.json");
  const evidenceHtmlPath = join(evidenceRoot, "browser-evidence.html");
  const screenshotPath = join(evidenceRoot, "browser-evidence.png");
  const baseEvidence = redactSecrets({
    kind: "northstar-product-hardening-live-browser-evidence",
    captured_at: new Date().toISOString(),
    issue_urls: input.issueUrls,
    pr_urls: input.prUrls,
    metrics: input.metrics,
  });

  await writeFile(evidenceHtmlPath, renderEvidenceHtml(baseEvidence));
  const browserEvidence = await runHeadlessBrowserEvidence({
    htmlPath: evidenceHtmlPath,
    screenshotPath,
    browserBin: input.browserBin,
  });
  assertBrowserEvidenceMetadata(browserEvidence);
  const redacted = redactSecrets({
    ...baseEvidence,
    browser_evidence: browserEvidence,
  });
  await writeFile(evidenceJsonPath, JSON.stringify(redacted, null, 2));
  return evidenceJsonPath;
}

export async function preserveBrowserEvidenceArtifact(input: {
  browserEvidencePath: string;
  runId: string;
  artifactRoot?: string;
}): Promise<string> {
  const sourceRoot = dirname(input.browserEvidencePath);
  const artifactRoot = input.artifactRoot ?? productHardeningArtifactRoot(input.runId);
  await rm(artifactRoot, { recursive: true, force: true });
  await mkdir(artifactRoot, { recursive: true });
  await cp(sourceRoot, artifactRoot, { recursive: true });

  const preservedEvidencePath = join(artifactRoot, "browser-evidence.json");
  const preservedScreenshotPath = join(artifactRoot, "browser-evidence.png");
  const evidence = JSON.parse(await readFile(preservedEvidencePath, "utf8")) as {
    browser_evidence?: {
      screenshot?: {
        path?: string;
      };
    };
  };
  if (evidence.browser_evidence?.screenshot) {
    evidence.browser_evidence.screenshot.path = preservedScreenshotPath;
    await writeFile(preservedEvidencePath, JSON.stringify(redactSecrets(evidence), null, 2));
  }

  return preservedEvidencePath;
}

async function runRealProductHardeningLivePath(env: ProductHardeningLiveEnv): Promise<ProductHardeningLiveResult> {
  const metrics = emptyProductHardeningMetrics();
  const runId = `northstar-product-hardening-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const github = new GitHubSandboxClient({ repo: env.repo, token: env.token });
  const tempRoot = await mkdtemp(join(tmpdir(), "northstar-product-hardening-live-"));
  const consumerRoot = join(tempRoot, "consumer");
  const askpassPath = join(tempRoot, "git-askpass.sh");
  const gitTracePath = join(tempRoot, "git-trace2.jsonl");
  const commandLog: CommandResult[] = [];
  const createdIssues: CreatedPlanIssue[] = [];

  try {
    await writeGitAskpass(askpassPath);
    const liveProcessEnv = liveEnv(env.token, askpassPath, gitTracePath);
    await runCommand("git", ["clone", `https://github.com/${env.repo}.git`, consumerRoot], {
      cwd: tempRoot,
      env: liveProcessEnv,
      commandLog,
      timeoutMs: 180_000,
    });
    await runCommand("git", ["-C", consumerRoot, "config", "user.name", "Northstar Product Hardening Live"], {
      cwd: tempRoot,
      env: liveProcessEnv,
      commandLog,
    });
    await runCommand("git", ["-C", consumerRoot, "config", "user.email", "northstar-product-hardening@example.invalid"], {
      cwd: tempRoot,
      env: liveProcessEnv,
      commandLog,
    });
    await writeProductHardeningConsumerConfig({ consumerRoot, repo: env.repo, projectId: env.projectId });

    createdIssues.push(...await createLinkedIssues({
      github,
      projectId: env.projectId,
      token: env.token,
      runId,
    }));
    metrics.live_issues_created = createdIssues.length;

    await runProductionWatchToCompletion({
      consumerRoot,
      configPath: join(consumerRoot, ".northstar.yaml"),
      env: liveProcessEnv,
      commandLog,
      issueNumbers: createdIssues.map((issue) => issue.issueNumber),
    });

    const runtime = readRuntimeAssertions({
      consumerRoot,
      issueNumbers: createdIssues.map((issue) => issue.issueNumber),
      plan: createdIssues,
    });
    Object.assign(metrics, runtime.metrics);
    metrics.live_issues_created = createdIssues.length;
    metrics.live_secret_leaks += countSecretLeaks(JSON.stringify(runtime.redactionText));
    metrics.live_secret_leaks += countSecretLeaks(commandLog.map((entry) => `${entry.stdout}\n${entry.stderr}`).join("\n"));
    metrics.fake_production_path_used = 0;

    const projectReadBack = await readBackProjectAssertions({
      repo: env.repo,
      projectId: env.projectId,
      token: env.token,
      issues: runtime.issueResults,
    });
    metrics.live_project_lifecycle_completed = projectReadBack.lifecycleCompleted;
    metrics.live_project_status_done = projectReadBack.statusDone;
    metrics.github_project_status_mismatches = projectReadBack.mismatches;

    const browserEvidencePath = await writeBrowserEvidence({
      consumerRoot,
      runId,
      issueUrls: createdIssues.map((issue) => issue.issueUrl),
      prUrls: runtime.issueResults.map((issue) => issue.prUrl),
      metrics,
      browserBin: env.browserBin,
    });
    metrics.live_browser_tests_passed = 1;
    metrics.live_secret_leaks += countSecretLeaks(await readFile(browserEvidencePath, "utf8"));
    finalizeProductHardeningMetrics(metrics, {
      runtimeFlowComplete: metrics.live_completed_issues >= 5 && metrics.live_prs_merged >= 5,
      projectReadBackComplete: projectReadBack.checkedIssues >= 5,
      browserEvidenceComplete: metrics.live_browser_tests_passed >= 1,
      runtimeHistoryMetricsComplete: metrics.live_parallel_active_issue_workers >= 2 && metrics.dependency_order_violations === 0,
    });
    const preservedBrowserEvidencePath = await preserveBrowserEvidenceArtifact({
      browserEvidencePath,
      runId,
    });

    return {
      metrics,
      issueUrls: createdIssues.map((issue) => issue.issueUrl),
      prUrls: runtime.issueResults.map((issue) => issue.prUrl),
      browserEvidencePath: preservedBrowserEvidencePath,
    };
  } catch (error) {
    await cleanupProductHardeningFailureArtifacts({
      github,
      issues: createdIssues,
      error,
      repo: env.repo,
      token: env.token,
      runId,
    });
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    throw new Error(`Product hardening live E2E failed on the real production path: ${message}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runRealSpecToIssuesLivePath(
  env: ProductHardeningLiveEnv & { confirmedApply: true },
): Promise<SpecToIssuesLiveResult> {
  const runId = `northstar-spec-to-issues-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const github = new GitHubSandboxClient({ repo: env.repo, token: env.token });
  const tempRoot = await mkdtemp(join(tmpdir(), "northstar-spec-to-issues-live-"));
  const consumerRoot = join(tempRoot, "consumer");
  const askpassPath = join(tempRoot, "git-askpass.sh");
  const gitTracePath = join(tempRoot, "git-trace2.jsonl");
  const commandLog: CommandResult[] = [];
  const createdIssues: CreatedPlanIssue[] = [];

  try {
    await writeGitAskpass(askpassPath);
    const liveProcessEnv = liveEnv(env.token, askpassPath, gitTracePath);
    await runCommand("git", ["clone", `https://github.com/${env.repo}.git`, consumerRoot], {
      cwd: tempRoot,
      env: liveProcessEnv,
      commandLog,
      timeoutMs: 180_000,
    });
    await runCommand("git", ["-C", consumerRoot, "config", "user.name", "Northstar Spec To Issues Live"], {
      cwd: tempRoot,
      env: liveProcessEnv,
      commandLog,
    });
    await runCommand("git", ["-C", consumerRoot, "config", "user.email", "northstar-spec-to-issues@example.invalid"], {
      cwd: tempRoot,
      env: liveProcessEnv,
      commandLog,
    });
    await writeProductHardeningConsumerConfig({ consumerRoot, repo: env.repo, projectId: env.projectId });

    const specPlan = await writeSpecToIssuesSourceDocuments({ consumerRoot, runId });
    const intake = await generateSpecToIssuesDrafts({
      ...specPlan,
      repo: env.repo,
      projectId: env.projectId,
      confirmedApply: env.confirmedApply,
    });
    createdIssues.push(...await createSpecToIssuesIssues({
      github,
      projectId: env.projectId,
      token: env.token,
      runId,
      drafts: intake.apply.issueDrafts,
    }));

    await runProductionWatchToCompletion({
      consumerRoot,
      configPath: join(consumerRoot, ".northstar.yaml"),
      env: liveProcessEnv,
      commandLog,
      issueNumbers: createdIssues.map((issue) => issue.issueNumber),
    });

    const runtime = readRuntimeAssertions({
      consumerRoot,
      issueNumbers: createdIssues.map((issue) => issue.issueNumber),
      plan: createdIssues,
    });
    const productMetrics = emptyProductHardeningMetrics();
    Object.assign(productMetrics, runtime.metrics);
    productMetrics.live_issues_created = createdIssues.length;
    productMetrics.fake_production_path_used = 0;
    productMetrics.live_secret_leaks += countSecretLeaks(JSON.stringify(runtime.redactionText));
    productMetrics.live_secret_leaks += countSecretLeaks(commandLog.map((entry) => `${entry.stdout}\n${entry.stderr}`).join("\n"));

    const projectReadBack = await readBackProjectAssertions({
      repo: env.repo,
      projectId: env.projectId,
      token: env.token,
      issues: runtime.issueResults,
    });
    productMetrics.live_project_lifecycle_completed = projectReadBack.lifecycleCompleted;
    productMetrics.live_project_status_done = projectReadBack.statusDone;
    productMetrics.github_project_status_mismatches = projectReadBack.mismatches;

    const browserEvidencePath = await writeBrowserEvidence({
      consumerRoot,
      runId,
      issueUrls: createdIssues.map((issue) => issue.issueUrl),
      prUrls: runtime.issueResults.map((issue) => issue.prUrl),
      metrics: productMetrics,
      browserBin: env.browserBin,
    });
    productMetrics.live_browser_tests_passed = 1;
    productMetrics.live_secret_leaks += countSecretLeaks(await readFile(browserEvidencePath, "utf8"));
    const preservedBrowserEvidencePath = await preserveBrowserEvidenceArtifact({
      browserEvidencePath,
      runId,
    });

    return {
      metrics: {
        spec_plan_inputs_validated: intake.apply.metrics.spec_plan_inputs_validated,
        issues_generated_from_plan: intake.apply.metrics.issues_generated_from_plan,
        dry_run_requires_no_github_mutation: intake.githubMutationsDuringDryRun === 0 && intake.dryRun.metrics.dry_run_requires_no_github_mutation === 1 ? 1 : 0,
        apply_requires_confirmation: intake.applyRequiresConfirmation,
        live_completed_issues: productMetrics.live_completed_issues,
        live_prs_merged: productMetrics.live_prs_merged,
        live_browser_tests_passed: productMetrics.live_browser_tests_passed,
        secret_leaks_in_generated_issues: countSecretLeaks(intake.apply.issueDrafts.map((draft) => `${draft.title}\n${draft.body}`).join("\n")),
      },
      issueUrls: createdIssues.map((issue) => issue.issueUrl),
      prUrls: runtime.issueResults.map((issue) => issue.prUrl),
      browserEvidencePath: preservedBrowserEvidencePath,
    };
  } catch (error) {
    await cleanupProductHardeningFailureArtifacts({
      github,
      issues: createdIssues,
      error,
      repo: env.repo,
      token: env.token,
      runId,
    });
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    throw new Error(`Spec-to-issues live E2E failed on the real production path: ${message}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function createLinkedIssues(input: {
  github: GitHubSandboxClient;
  projectId: string;
  token: string;
  runId: string;
}): Promise<CreatedPlanIssue[]> {
  const issueNumbers = new Map<string, number>();
  const created: CreatedPlanIssue[] = [];

  for (const item of createProductHardeningIssuePlan(input.runId)) {
    const issue = await input.github.createIssue({
      title: `${input.runId} issue ${item.key}`,
      body: renderIssueBody(item, issueNumbers),
    });
    issueNumbers.set(item.key, issue.number);
    await input.github.addLabels(issue.number, ["northstar:ready"]);
    await addIssueToProject({
      github: input.github,
      projectId: input.projectId,
      token: input.token,
      issueNumber: issue.number,
    });
    created.push({ ...item, issueNumber: issue.number, issueUrl: issue.html_url });
  }

  return created;
}

async function writeSpecToIssuesSourceDocuments(input: {
  consumerRoot: string;
  runId: string;
}): Promise<{ specText: string; planText: string; specPath: string; planPath: string }> {
  const specPath = "docs/specs/spec-to-issues-live.md";
  const planPath = "docs/plans/spec-to-issues-live.md";
  const issues = createSpecToIssuesPlan(input.runId);
  const specText = [
    "# Spec-To-Issues Live Spec",
    "",
    "## Objective",
    "Prove that a small operator-authored spec and plan become real Northstar issues that complete through the production GitHub, watch, PR, merge, Project, and browser evidence path.",
    "",
    "## Scope",
    "- Generate issue drafts from a design spec and implementation plan.",
    "- Apply only after explicit test-controlled confirmation.",
    "- Complete the generated work through Northstar automation.",
    "",
    "## Acceptance Criteria",
    "- Drafts include source document sections and dependency markers.",
    "- Live apply creates labeled issues and preserves dependency order.",
    "- Generated work merges and records browser evidence.",
    "",
    "## Quantitative Metrics",
    "- issues_generated_from_plan >= 3",
    "- live_completed_issues >= 3",
    "- live_prs_merged >= 3",
    "",
    "## Required Tests",
    "- node --disable-warning=ExperimentalWarning tests/e2e-product-hardening-live/spec-to-issues-live.test.ts",
    "",
  ].join("\n");
  const planText = issues.map((issue, index) => [
    index === 0 ? "# Spec-To-Issues Live Plan\n" : "",
    `## Task ${index + 1}: Write Live Artifact ${issue.key}`,
    issue.dependsOn.length > 0 ? `Depends-On: ${issue.dependsOn.map((key) => `Task ${issues.findIndex((candidate) => candidate.key === key) + 1}`).join(", ")}` : "",
    "",
    "Objective:",
    `Create the live artifact for issue ${issue.key}.`,
    "",
    "Scope:",
    `- Create or update ${issue.outputFile}.`,
    `- The file must contain exactly: ${issue.expectedContent}`,
    "",
    "Acceptance Criteria:",
    `- ${issue.outputFile} exists with the exact expected content.`,
    "- No files outside the requested path are edited.",
    "",
    "Quantitative Metrics:",
    `- spec_to_issues_live_${issue.key.toLowerCase()}_ready = 1`,
    "",
    "Required Tests:",
    "- node --disable-warning=ExperimentalWarning tests/e2e-product-hardening-live/spec-to-issues-live.test.ts",
    "",
  ].filter((line) => line !== "").join("\n")).join("\n");

  await mkdir(join(input.consumerRoot, "docs/specs"), { recursive: true });
  await mkdir(join(input.consumerRoot, "docs/plans"), { recursive: true });
  await writeFile(join(input.consumerRoot, specPath), specText);
  await writeFile(join(input.consumerRoot, planPath), planText);

  return { specText, planText, specPath, planPath };
}

async function generateSpecToIssuesDrafts(input: {
  specText: string;
  planText: string;
  specPath: string;
  planPath: string;
  repo: string;
  projectId: string;
  confirmedApply: true;
}): Promise<{
  dryRun: SpecPlanGenerationResult;
  apply: SpecPlanGenerationResult;
  githubMutationsDuringDryRun: number;
  applyRequiresConfirmation: 1;
}> {
  const { generateIssueDraftsFromSpecPlan } = await import("../../skills/northstar/scripts/lib/spec-plan-intake.mjs");
  const githubMutationsDuringDryRun = 0;
  const dryRun = generateIssueDraftsFromSpecPlan({
    specText: input.specText,
    planText: input.planText,
    specPath: input.specPath,
    planPath: input.planPath,
    repo: input.repo,
    projectId: input.projectId,
    mode: "dry-run",
  }) as SpecPlanGenerationResult;

  let applyRequiresConfirmation: 1 | 0 = 0;
  try {
    generateIssueDraftsFromSpecPlan({
      specText: input.specText,
      planText: input.planText,
      specPath: input.specPath,
      planPath: input.planPath,
      repo: input.repo,
      projectId: input.projectId,
      mode: "apply",
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "NORTHSTAR_SPEC_PLAN_APPLY_REQUIRES_CONFIRMATION") {
      throw error;
    }
    applyRequiresConfirmation = 1;
  }
  if (applyRequiresConfirmation !== 1) {
    throw new Error("Spec-to-issues apply mode did not require confirmation before mutation.");
  }

  const apply = generateIssueDraftsFromSpecPlan({
    specText: input.specText,
    planText: input.planText,
    specPath: input.specPath,
    planPath: input.planPath,
    repo: input.repo,
    projectId: input.projectId,
    mode: "apply",
    confirmed: input.confirmedApply,
  }) as SpecPlanGenerationResult;
  if (apply.issueDrafts.length < 3) {
    throw new Error(`Spec-to-issues live E2E requires at least 3 generated issue drafts; got ${apply.issueDrafts.length}`);
  }
  if (!apply.issueDrafts.some((draft) => /Depends-On: #\d+/.test(draft.body))) {
    throw new Error("Spec-to-issues live E2E requires generated dependency markers.");
  }

  return { dryRun, apply, githubMutationsDuringDryRun, applyRequiresConfirmation };
}

async function createSpecToIssuesIssues(input: {
  github: GitHubSandboxClient;
  projectId: string;
  token: string;
  runId: string;
  drafts: SpecPlanIssueDraft[];
}): Promise<CreatedPlanIssue[]> {
  const issueNumbers = new Map<string, number>();
  const created: CreatedPlanIssue[] = [];
  const plan = createSpecToIssuesPlan(input.runId);

  for (const [index, item] of plan.entries()) {
    const draft = input.drafts[index];
    if (!draft) {
      throw new Error(`Missing generated issue draft for spec-to-issues plan item ${item.key}`);
    }
    const issue = await input.github.createIssue({
      title: `${input.runId} ${draft.title}`,
      body: renderSpecToIssuesIssueBody({ draft, item, issueNumbers }),
    });
    issueNumbers.set(item.key, issue.number);
    await input.github.addLabels(issue.number, ["northstar:ready"]);
    await addIssueToProject({
      github: input.github,
      projectId: input.projectId,
      token: input.token,
      issueNumber: issue.number,
    });
    created.push({ ...item, issueNumber: issue.number, issueUrl: issue.html_url });
  }

  return created;
}

function createSpecToIssuesPlan(runId: string): ProductHardeningIssuePlanItem[] {
  return [
    planIssue("A", [], runId),
    planIssue("B", ["A"], runId),
    planIssue("C", ["B"], runId),
  ];
}

function renderSpecToIssuesIssueBody(input: {
  draft: SpecPlanIssueDraft;
  item: ProductHardeningIssuePlanItem;
  issueNumbers: Map<string, number>;
}): string {
  return [
    rewriteGeneratedDependencyMarkers(input.draft.body, input.issueNumbers),
    "",
    "## Live Implementation Contract",
    renderIssueBody(input.item, input.issueNumbers),
  ].join("\n");
}

function rewriteGeneratedDependencyMarkers(body: string, issueNumbers: Map<string, number>): string {
  const createdIssueNumbers = [...issueNumbers.values()];
  return body.replace(/^Depends-On: #(\d+)$/gm, (_match, placeholder: string) => {
    const issueNumber = createdIssueNumbers[Number(placeholder) - 1];
    if (!issueNumber) {
      throw new Error(`Generated dependency marker #${placeholder} did not map to an already-created live issue`);
    }
    return `Depends-On: #${issueNumber}`;
  });
}

async function runProductionWatchToCompletion(input: {
  consumerRoot: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
  commandLog: CommandResult[];
  issueNumbers: number[];
}): Promise<void> {
  const northstar = async () => await runCommand(process.execPath, [
    join(repoRoot, "src/cli/entrypoint.ts"),
    "watch",
    "--config",
    input.configPath,
    "--max-cycles",
    "1",
    "--interval-ms",
    "10",
    "--log-json",
  ], {
    cwd: input.consumerRoot,
    env: input.env,
    commandLog: input.commandLog,
    timeoutMs: 1_200_000,
  });

  for (let cycle = 0; cycle < 24; cycle += 1) {
    await northstar();
    if (allIssuesCompleted(input.consumerRoot, input.issueNumbers)) {
      return;
    }
  }

  throw new Error("Product hardening live watch did not complete all five dependency-linked issues within 24 cycles");
}

function allIssuesCompleted(consumerRoot: string, issueNumbers: number[]): boolean {
  const store = openConsumerStore(consumerRoot);
  try {
    return issueNumbers.every((issueNumber) => {
      try {
        return store.getIssue(`github:${issueNumber}`).lifecycle_state === "completed";
      } catch {
        return false;
      }
    });
  } finally {
    store.close();
  }
}

function readRuntimeAssertions(input: {
  consumerRoot: string;
  issueNumbers: number[];
  plan: CreatedPlanIssue[];
}): {
  metrics: Partial<ProductHardeningMetrics>;
  issueResults: Array<{ issueNumber: number; prUrl: string; mergeSha: string }>;
  redactionText: unknown;
} {
  const store = openConsumerStore(input.consumerRoot);
  try {
    const issueResults = input.issueNumbers.map((issueNumber) => {
      const snapshot = store.getIssue(`github:${issueNumber}`);
      const pr = snapshot.runtime_context_json.pr as { prUrl?: string } | undefined;
      const release = snapshot.runtime_context_json.release as { merge_sha?: string } | undefined;
      return {
        issueNumber,
        prUrl: String(pr?.prUrl ?? ""),
        mergeSha: String(release?.merge_sha ?? ""),
      };
    });
    const windows = input.issueNumbers.flatMap((issueNumber) => issueWorkerWindows(store, issueNumber));
    const metrics: Partial<ProductHardeningMetrics> = {
      live_completed_issues: input.issueNumbers.filter((issueNumber) => store.getIssue(`github:${issueNumber}`).lifecycle_state === "completed").length,
      live_prs_merged: issueResults.filter((issue) => issue.mergeSha.length > 0).length,
      dependency_order_violations: dependencyOrderViolations(store, input.plan),
      parallel_overlap_seconds: maxParallelOverlapSeconds(windows),
      live_parallel_active_issue_workers: maxActiveWorkers(windows),
    };
    return {
      metrics,
      issueResults,
      redactionText: {
        issues: input.issueNumbers.map((issueNumber) => store.getIssue(`github:${issueNumber}`)),
        history: input.issueNumbers.map((issueNumber) => store.listHistory(`github:${issueNumber}`)),
      },
    };
  } finally {
    store.close();
  }
}

async function readBackProjectAssertions(input: {
  repo: string;
  projectId: string;
  token: string;
  issues: Array<{ issueNumber: number; prUrl: string; mergeSha: string }>;
}): Promise<{
  checkedIssues: number;
  lifecycleCompleted: number;
  statusDone: number;
  mismatches: number;
}> {
  let checkedIssues = 0;
  let lifecycleCompleted = 0;
  let statusDone = 0;
  let mismatches = 0;

  for (const issue of input.issues) {
    const fields = await readProjectFieldsForIssue({
      repo: input.repo,
      projectId: input.projectId,
      token: input.token,
      issueNumber: issue.issueNumber,
    });
    const lifecycle = projectFieldValue(fields, "Northstar Lifecycle");
    const status = projectFieldValue(fields, "Status");
    const prUrl = projectFieldValue(fields, "PR URL", "Northstar PR");
    const mergeSha = projectFieldValue(fields, "Merge SHA", "Northstar Merge SHA");

    checkedIssues += 1;
    lifecycleCompleted += lifecycle === "completed" ? 1 : 0;
    statusDone += status === "Done" ? 1 : 0;
    for (const aliases of productHardeningProjectReadBackFieldAliases) {
      if (!projectFieldValue(fields, ...aliases)) {
        mismatches += 1;
      }
    }
    if (lifecycle !== "completed") mismatches += 1;
    if (status !== "Done") mismatches += 1;
    if (prUrl !== issue.prUrl) mismatches += 1;
    if (mergeSha !== issue.mergeSha) mismatches += 1;
  }

  return { checkedIssues, lifecycleCompleted, statusDone, mismatches };
}

function projectFieldValue(fields: Record<string, string>, ...aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const value = fields[alias];
    if (value) {
      return value;
    }
  }
  return undefined;
}

async function readProjectFieldsForIssue(input: {
  repo: string;
  projectId: string;
  token: string;
  issueNumber: number;
}): Promise<Record<string, string>> {
  const [owner, name] = input.repo.split("/");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${input.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      query: `
        query ProductHardeningProjectReadBack($owner: String!, $name: String!, $issueNumber: Int!) {
          repository(owner: $owner, name: $name) {
            issue(number: $issueNumber) {
              projectItems(first: 20) {
                nodes {
                  project { id }
                  fieldValues(first: 100) {
                    nodes {
                      ... on ProjectV2ItemFieldTextValue {
                        text
                        field { ... on ProjectV2Field { name } ... on ProjectV2SingleSelectField { name } }
                      }
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field { ... on ProjectV2Field { name } ... on ProjectV2SingleSelectField { name } }
                      }
                      ... on ProjectV2ItemFieldNumberValue {
                        number
                        field { ... on ProjectV2Field { name } ... on ProjectV2SingleSelectField { name } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: { owner, name, issueNumber: input.issueNumber },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub Project read-back failed with ${response.status}: ${redactSecrets(text)}`);
  }
  const payload = JSON.parse(text) as {
    data?: {
      repository?: {
        issue?: {
          projectItems?: {
            nodes?: Array<{
              project?: { id?: string } | null;
              fieldValues?: { nodes?: ProjectFieldValueNode[] };
            } | null>;
          };
        } | null;
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(`GitHub Project read-back failed: ${redactSecrets(JSON.stringify(payload.errors))}`);
  }
  const item = payload.data?.repository?.issue?.projectItems?.nodes?.find((node) => node?.project?.id === input.projectId);
  if (!item) {
    throw new Error(`GitHub Project read-back could not find issue #${input.issueNumber} in configured Project`);
  }

  const fields: Record<string, string> = {};
  for (const node of item.fieldValues?.nodes ?? []) {
    const fieldName = node?.field?.name;
    if (!fieldName) continue;
    if (typeof node.text === "string") fields[fieldName] = node.text;
    if (typeof node.name === "string") fields[fieldName] = node.name;
    if (typeof node.number === "number") fields[fieldName] = String(node.number);
  }
  return fields;
}

type ProjectFieldValueNode = {
  text?: string;
  name?: string;
  number?: number;
  field?: { name?: string } | null;
} | null;

function issueWorkerWindows(store: SqliteControlPlaneStore, issueNumber: number): WorkerWindow[] {
  const history = store.listHistory(`github:${issueNumber}`);
  const starts = history.filter((entry) =>
    entry.event_type === "child_run_started" &&
    entry.payload.role === "issue_worker" &&
    typeof entry.payload.child_run_id === "string"
  );
  return starts.flatMap((start) => {
    const completed = history.find((entry) =>
      entry.sequence > start.sequence &&
      entry.event_type === "child_artifact_received" &&
      entry.payload.child_run_id === start.payload.child_run_id
    );
    if (!completed) return [];
    return [{
      issueNumber,
      startedAt: start.created_at,
      completedAt: completed.created_at,
    }];
  });
}

function dependencyOrderViolations(store: SqliteControlPlaneStore, plan: CreatedPlanIssue[]): number {
  const byKey = new Map(plan.map((issue) => [issue.key, issue]));
  let violations = 0;
  for (const issue of plan) {
    const starts = issueWorkerWindows(store, issue.issueNumber);
    const startMs = starts.length > 0 ? Date.parse(starts[0].startedAt) : Number.NaN;
    for (const dependencyKey of issue.dependsOn) {
      const dependency = byKey.get(dependencyKey);
      if (!dependency) {
        violations += 1;
        continue;
      }
      const releaseCompleted = store
        .listHistory(`github:${dependency.issueNumber}`)
        .find((entry) => entry.event_type === "release_completed");
      const completedMs = releaseCompleted ? Date.parse(releaseCompleted.created_at) : Number.NaN;
      if (!Number.isFinite(startMs) || !Number.isFinite(completedMs) || startMs < completedMs) {
        violations += 1;
      }
    }
  }
  return violations;
}

function maxParallelOverlapSeconds(windows: WorkerWindow[]): number {
  let maxOverlapMs = 0;
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const first = windows[i];
      const second = windows[j];
      const overlapMs = Math.max(
        0,
        Math.min(Date.parse(first.completedAt), Date.parse(second.completedAt)) -
          Math.max(Date.parse(first.startedAt), Date.parse(second.startedAt)),
      );
      maxOverlapMs = Math.max(maxOverlapMs, overlapMs);
    }
  }
  return maxOverlapMs > 0 ? Math.max(1, Math.ceil(maxOverlapMs / 1000)) : 0;
}

function maxActiveWorkers(windows: WorkerWindow[]): number {
  const events = windows.flatMap((window) => [
    { at: Date.parse(window.startedAt), delta: 1 },
    { at: Date.parse(window.completedAt), delta: -1 },
  ]).sort((left, right) => left.at - right.at || right.delta - left.delta);
  let active = 0;
  let max = 0;
  for (const event of events) {
    active += event.delta;
    max = Math.max(max, active);
  }
  return max;
}

async function addIssueToProject(input: {
  github: GitHubSandboxClient;
  projectId: string;
  token: string;
  issueNumber: number;
}): Promise<void> {
  const issue = await input.github.readIssue(input.issueNumber) as SandboxIssue;
  const nodeId = issue.node_id;
  if (!nodeId) {
    throw new Error(`GitHub issue #${input.issueNumber} did not include a node id for Project insertion`);
  }

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${input.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      query: `
        mutation AddProductHardeningIssueToProject($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
            item { id }
          }
        }
      `,
      variables: { projectId: input.projectId, contentId: nodeId },
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub Project insertion failed with ${response.status}: ${redactSecrets(await response.text())}`);
  }
  const data = await response.json() as { errors?: Array<{ message?: string }> };
  if (data.errors?.length) {
    const alreadyAdded = data.errors.some((error) => /already exists/i.test(error.message ?? ""));
    if (!alreadyAdded) {
      throw new Error(`GitHub Project insertion failed: ${redactSecrets(JSON.stringify(data.errors))}`);
    }
  }
}

async function runHeadlessBrowserEvidence(input: {
  htmlPath: string;
  screenshotPath: string;
  browserBin?: string;
}): Promise<BrowserEvidenceMetadata> {
  const browser = await runBrowserAutomationEvidence(input);
  assertBrowserEvidenceMetadata(browser);
  return browser;
}

async function runBrowserAutomationEvidence(input: {
  htmlPath: string;
  screenshotPath: string;
  browserBin?: string;
}): Promise<BrowserEvidenceMetadata> {
  const candidates = await browserAutomationCandidates(input.browserBin);
  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      return await runChromiumCdpEvidence({
        ...input,
        browserBin: candidate,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (input.browserBin) {
        throw new Error(`Headless browser evidence requires browser automation evidence; ${candidate} ${message}`);
      }
      errors.push(`${candidate}: ${message}`);
    }
  }

  throw new Error([
    "Headless browser evidence requires browser automation evidence from Chrome, Chromium, Google Chrome, or Microsoft Edge.",
    "Set NORTHSTAR_BROWSER_BIN to a supported browser executable.",
    errors.length > 0 ? `Attempts: ${redactSecrets(errors.join(" | "))}` : "",
  ].filter(Boolean).join(" "));
}

async function runChromiumCdpEvidence(input: {
  htmlPath: string;
  screenshotPath: string;
  browserBin: string;
}): Promise<BrowserEvidenceMetadata> {
  await assertExecutablePathIfExplicit(input.browserBin);
  const url = pathToFileURL(input.htmlPath).href;
  const port = await reserveTcpPort();
  const userDataDir = await mkdtemp(join(tmpdir(), "northstar-product-hardening-browser-profile-"));
  const child = spawn(input.browserBin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1280,800",
    "about:blank",
  ], {
    cwd: dirname(input.htmlPath),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectChildOutput(child);

  try {
    const version = await waitForDevToolsVersion(port, child, output);
    const target = await ensureCdpPageTarget(port);
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send("Page.navigate", { url });
      await waitForBrowserReady(cdp, url);

      const selector = "[data-testid='product-hardening-live-browser-pass']";
      const expectedText = "product-hardening-live-browser-pass";
      const actualText = await evaluateString(cdp, [
        "(() => {",
        `  const element = document.querySelector(${JSON.stringify(selector)});`,
        "  return element?.textContent?.trim() ?? '';",
        "})()",
      ].join("\n"));
      if (!actualText.includes(expectedText)) {
        throw new Error("CDP browser evidence DOM assertion did not include the pass marker");
      }

      const screenshotResult = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      }) as { data?: string };
      if (!screenshotResult.data) {
        throw new Error("CDP browser evidence did not return screenshot data");
      }
      const screenshot = Buffer.from(screenshotResult.data, "base64");
      await writeFile(input.screenshotPath, screenshot);
      const dimensions = parsePngDimensions(screenshot);
      if (!dimensions) {
        throw new Error("CDP browser evidence screenshot was not a valid PNG with IHDR dimensions");
      }

      return {
        source: "cdp",
        ...parseAutomationBrowserVersion(version.Browser),
        dom_assertion: {
          selector,
          expected_text: expectedText,
          actual_text: actualText,
          passed: true,
        },
        screenshot: {
          path: input.screenshotPath,
          width: dimensions.width,
          height: dimensions.height,
        },
      };
    } finally {
      cdp.close();
    }
  } finally {
    await stopBrowserProcess(child);
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function browserAutomationCandidates(preferred?: string): Promise<string[]> {
  const configured = preferred ?? process.env.NORTHSTAR_BROWSER_BIN;
  if (configured) {
    await assertExecutablePathIfExplicit(configured);
    return [configured];
  }

  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
    "microsoft-edge",
  ];
}

async function assertExecutablePathIfExplicit(candidate: string): Promise<void> {
  if (!candidate.includes("/")) return;
  await access(candidate, constants.X_OK);
}

async function reserveTcpPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local DevTools port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

function collectChildOutput(child: ChildProcessWithoutNullStreams): {
  stdout: string;
  stderr: string;
  error?: Error;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
} {
  const output: {
    stdout: string;
    stderr: string;
    error?: Error;
    exit?: { code: number | null; signal: NodeJS.Signals | null };
  } = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  child.once("error", (error) => {
    output.error = error;
  });
  child.once("exit", (code, signal) => {
    output.exit = { code, signal };
  });
  return output;
}

async function waitForDevToolsVersion(
  port: number,
  child: ChildProcessWithoutNullStreams,
  output: ReturnType<typeof collectChildOutput>,
): Promise<CdpVersionResponse> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (output.error) throw output.error;
    if (output.exit) {
      throw new Error(`exited before automation could connect: ${formatBrowserOutput(output)}`);
    }
    try {
      return await fetchJson<CdpVersionResponse>(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await delay(100);
    }
  }

  if (child.exitCode !== null) {
    throw new Error(`exited before automation could connect: ${formatBrowserOutput(output)}`);
  }
  throw new Error(`did not expose a DevTools endpoint on 127.0.0.1:${port}: ${formatBrowserOutput(output)}`);
}

async function ensureCdpPageTarget(port: number): Promise<CdpTarget> {
  const existing = await listCdpTargets(port);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) return page;

  const created = await fetchJson<CdpTarget>(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!created.webSocketDebuggerUrl) {
    throw new Error("DevTools page target did not include a websocket debugger URL");
  }
  return created;
}

async function listCdpTargets(port: number): Promise<CdpTarget[]> {
  return await fetchJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`DevTools request failed with ${response.status}`);
  }
  return await response.json() as T;
}

async function connectCdp(webSocketDebuggerUrl: string): Promise<CdpConnection> {
  return await createCdpConnection(webSocketDebuggerUrl, {
    WebSocketCtor: WebSocket,
    commandTimeoutMs: defaultCdpCommandTimeoutMs,
  });
}

export async function connectCdpForTest(
  webSocketDebuggerUrl: string,
  options: {
    WebSocketCtor: CdpWebSocketConstructor;
    commandTimeoutMs?: number;
  },
): Promise<CdpConnection> {
  return await createCdpConnection(webSocketDebuggerUrl, {
    WebSocketCtor: options.WebSocketCtor,
    commandTimeoutMs: options.commandTimeoutMs ?? defaultCdpCommandTimeoutMs,
  });
}

async function createCdpConnection(
  webSocketDebuggerUrl: string,
  options: {
    WebSocketCtor: CdpWebSocketConstructor;
    commandTimeoutMs: number;
  },
): Promise<CdpConnection> {
  const socket = new options.WebSocketCtor(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("Could not open DevTools websocket")), { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) {
      waiter.reject(new Error(message.error.message ?? "DevTools command failed"));
      return;
    }
    waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("DevTools websocket closed"));
    }
    pending.clear();
  });

  return {
    send(method: string, params?: Record<string, unknown>) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveSend, rejectSend) => {
        const timeout = setTimeout(() => {
          const waiter = pending.get(id);
          if (!waiter) return;
          pending.delete(id);
          rejectSend(new Error(`DevTools command ${method} timed out after ${options.commandTimeoutMs}ms`));
        }, options.commandTimeoutMs);
        pending.set(id, { resolve: resolveSend, reject: rejectSend, timeout });
        socket.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function waitForBrowserReady(cdp: CdpConnection, expectedUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pageState = await evaluateString(cdp, "`${location.href}\\n${document.readyState}`");
    if (pageState === `${expectedUrl}\ncomplete`) return;
    await delay(100);
  }
  throw new Error("CDP browser evidence page did not finish loading");
}

async function evaluateString(cdp: CdpConnection, expression: string): Promise<string> {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  }) as {
    result?: {
      value?: unknown;
    };
    exceptionDetails?: unknown;
  };
  if (result.exceptionDetails) {
    throw new Error("CDP browser evidence DOM evaluation threw an exception");
  }
  return typeof result.result?.value === "string" ? result.result.value : String(result.result?.value ?? "");
}

async function stopBrowserProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      resolveStop();
    }, 2_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolveStop();
    });
  });
}

function parseAutomationBrowserVersion(value: string): Pick<BrowserEvidenceMetadata, "browser_name" | "browser_version"> {
  const [name = "", version = ""] = value.split("/", 2);
  if (!name || !version) {
    throw new Error("DevTools browser version did not include a browser name and version");
  }
  return {
    browser_name: name,
    browser_version: version,
  };
}

function formatBrowserOutput(output: { stdout: string; stderr: string }): string {
  return redactSecrets([output.stdout, output.stderr].join("\n").trim()).slice(0, 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function parsePngDimensions(content: Uint8Array): { width: number; height: number } | null {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (content.length < 33 || !pngSignature.every((byte, index) => content[index] === byte)) return null;
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const ihdrLength = view.getUint32(8);
  const ihdrType = String.fromCharCode(content[12], content[13], content[14], content[15]);
  if (ihdrLength !== 13 || ihdrType !== "IHDR") return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

export function assertBrowserEvidenceMetadata(value: unknown): asserts value is BrowserEvidenceMetadata {
  const metadata = value as Partial<BrowserEvidenceMetadata> | undefined;
  if (!metadata || metadata.source !== "cdp") {
    throw new Error("Browser evidence metadata requires an automation source");
  }
  if (!metadata.browser_name || !metadata.browser_version) {
    throw new Error("Browser evidence metadata requires browser name and version from automation");
  }
  if (!metadata.dom_assertion?.passed || !metadata.dom_assertion.actual_text?.includes(metadata.dom_assertion.expected_text ?? "")) {
    throw new Error("Browser evidence metadata requires a passing DOM assertion");
  }
  const width = metadata.screenshot?.width ?? 0;
  const height = metadata.screenshot?.height ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Browser evidence metadata requires screenshot dimensions");
  }
}

interface CdpVersionResponse {
  Browser: string;
}

interface CdpTarget {
  type?: string;
  webSocketDebuggerUrl: string;
}

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface CdpWebSocketLike extends EventTarget {
  send(message: string): void;
  close(): void;
}

interface CdpWebSocketConstructor {
  new(url: string): CdpWebSocketLike;
}

function planIssue(
  key: ProductHardeningIssuePlanItem["key"],
  dependsOn: ProductHardeningIssuePlanItem["dependsOn"],
  runId: string,
): ProductHardeningIssuePlanItem {
  return {
    key,
    dependsOn,
    consumerRunId: runId,
    outputFile: `product-hardening-live/${runId}/${key}.txt`,
    expectedContent: `${runId}:${key}`,
  };
}

function renderIssueBody(
  item: ProductHardeningIssuePlanItem,
  issueNumbers: Map<string, number>,
): string {
  const dependencies = item.dependsOn.map((key) => {
    const issueNumber = issueNumbers.get(key);
    if (!issueNumber) throw new Error(`Cannot render issue ${item.key}; dependency ${key} has not been created`);
    return `Depends-On: #${issueNumber}`;
  });
  return [
    `Product hardening live issue ${item.key}.`,
    "",
    ...dependencies,
    "",
    `Create or update ${item.outputFile}.`,
    `The file must contain exactly: ${item.expectedContent}`,
    "Do not edit files outside the requested path.",
  ].join("\n");
}

function renderEvidenceHtml(value: unknown): string {
  const json = escapeHtml(JSON.stringify(value, null, 2));
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Northstar Product Hardening Live Evidence</title>",
    "<style>body{font-family:system-ui,sans-serif;margin:32px;line-height:1.4}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px;border:1px solid #ddd}</style>",
    "</head>",
    "<body>",
    '<main data-testid="product-hardening-live-browser-pass">',
    "<h1>product-hardening-live-browser-pass</h1>",
    `<pre>${json}</pre>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeGitAskpass(path: string): Promise<void> {
  await writeFile(path, [
    "#!/usr/bin/env sh",
    "case \"$1\" in",
    "  *Username*) printf '%s\\n' x-access-token ;;",
    "  *) printf '%s\\n' \"$GITHUB_TOKEN\" ;;",
    "esac",
  ].join("\n"));
  await chmod(path, 0o700);
}

function liveEnv(token: string, askpassPath: string, gitTracePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GITHUB_TOKEN: token,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_TRACE2_EVENT: gitTracePath,
  };
}

function runCommand(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  commandLog: CommandResult[];
  timeoutMs?: number;
}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const result = { command, args, stdout, stderr };
      options.commandLog.push(result);
      if (error) {
        reject(new Error(redactSecrets([
          `Command failed: ${command} ${args.join(" ")}`,
          stdout,
          stderr,
          error.message,
        ].join("\n"))));
        return;
      }
      resolveResult(result);
    });
    child.stdin?.end();
  });
}

function openConsumerStore(consumerRoot: string): SqliteControlPlaneStore {
  return SqliteControlPlaneStore.open(join(consumerRoot, ".northstar/runtime/control-plane.sqlite3"));
}

function countSecretLeaks(text: string): number {
  return /gh[opsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+/i.test(text) ? 1 : 0;
}

export async function cleanupProductHardeningFailureArtifacts(input: {
  github: Pick<GitHubSandboxClient, "addLabels" | "addIssueComment" | "closeIssue">;
  issues: CreatedPlanIssue[];
  error: unknown;
  repo: string;
  token: string;
  runId: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const reason = redactSecrets(input.error instanceof Error ? input.error.message : String(input.error)).slice(0, 1000);
  for (const issue of input.issues) {
    try {
      await input.github.addLabels(issue.issueNumber, [productHardeningFailureCleanupLabel]);
    } catch {
      // Best-effort cleanup only.
    }
    try {
      await input.github.addIssueComment(issue.issueNumber, `Product hardening live E2E failed and cleaned up this issue.\n\nCleanup label: ${productHardeningFailureCleanupLabel}\nReason: ${reason}`);
    } catch {
      // Best-effort cleanup only.
    }
    try {
      await input.github.closeIssue(issue.issueNumber);
    } catch {
      // Best-effort cleanup only.
    }
  }

  const pullRequests = await discoverProductHardeningCleanupPullRequests(input).catch(() => []);
  for (const pullRequest of pullRequests) {
    try {
      await addGitHubIssueComment({
        repo: input.repo,
        token: input.token,
        number: pullRequest.number,
        body: `Product hardening live E2E failed and cleaned up this pull request.\n\nAssociated run: ${input.runId}\nReason: ${reason}`,
        fetch: input.fetch,
      });
    } catch {
      // Best-effort cleanup only.
    }
    try {
      await closeGitHubPullRequest({
        repo: input.repo,
        token: input.token,
        number: pullRequest.number,
        fetch: input.fetch,
      });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

async function discoverProductHardeningCleanupPullRequests(input: {
  repo: string;
  token: string;
  runId: string;
  issues: CreatedPlanIssue[];
  fetch?: typeof fetch;
}): Promise<Array<{ number: number; html_url?: string }>> {
  const fetchImpl = input.fetch ?? fetch;
  const queries = [
    `${input.runId} repo:${input.repo} is:pr is:open`,
    ...input.issues.map((issue) => `#${issue.issueNumber} repo:${input.repo} is:pr is:open`),
  ];
  const byNumber = new Map<number, { number: number; html_url?: string }>();

  for (const query of queries) {
    const response = await fetchImpl(`https://api.github.com/search/issues?q=${encodeURIComponent(query)}`, {
      method: "GET",
      headers: githubHeaders(input.token),
    });
    if (!response.ok) {
      throw new Error(`GitHub cleanup PR discovery failed with ${response.status}: ${redactSecrets(await response.text())}`);
    }
    const payload = await response.json() as {
      items?: Array<{ number?: number; html_url?: string }>;
    };
    for (const item of payload.items ?? []) {
      if (typeof item.number === "number") {
        byNumber.set(item.number, { number: item.number, html_url: item.html_url });
      }
    }
  }

  return [...byNumber.values()];
}

async function addGitHubIssueComment(input: {
  repo: string;
  token: string;
  number: number;
  body: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetch ?? fetch;
  const response = await fetchImpl(`https://api.github.com/repos/${input.repo}/issues/${input.number}/comments`, {
    method: "POST",
    headers: githubHeaders(input.token),
    body: JSON.stringify({ body: input.body }),
  });
  if (!response.ok) {
    throw new Error(`GitHub cleanup PR comment failed with ${response.status}: ${redactSecrets(await response.text())}`);
  }
}

async function closeGitHubPullRequest(input: {
  repo: string;
  token: string;
  number: number;
  fetch?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetch ?? fetch;
  const response = await fetchImpl(`https://api.github.com/repos/${input.repo}/pulls/${input.number}`, {
    method: "PATCH",
    headers: githubHeaders(input.token),
    body: JSON.stringify({ state: "closed" }),
  });
  if (!response.ok) {
    throw new Error(`GitHub cleanup PR close failed with ${response.status}: ${redactSecrets(await response.text())}`);
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    "accept": "application/vnd.github+json",
    "authorization": `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}
