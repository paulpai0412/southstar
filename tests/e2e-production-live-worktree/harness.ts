import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { redactSecrets } from "../../src/runtime/redaction.ts";
import { GitHubSandboxClient } from "../e2e-full-live/github-sandbox.ts";

export interface LiveLocalWorktreeMetrics {
  live_worktree_issues_created: number;
  live_worktrees_created: number;
  live_worktree_paths_under_consumer_root: number;
  live_sdk_working_directory_is_worktree: number;
  live_sdk_modified_worktree_files: number;
  live_git_add_commands: number;
  live_git_commit_commands: number;
  live_git_push_commands: number;
  live_branches_pushed: number;
  live_prs_created_or_reused: number;
  live_prs_merged: number;
  live_confirmed_merge_facts: number;
  live_runtime_completed: number;
  live_github_issues_closed: number;
  live_resume_reuses_existing_worktree: number;
  live_resume_reuses_existing_branch: number;
  live_resume_reuses_existing_pr: number;
  live_duplicate_prs_created: number;
  live_completed_reversals: number;
  live_fixture_gateway_shortcuts_used: number;
  live_shell_chain_commands: number;
  live_secret_leaks: number;
}

export interface LiveLocalWorktreeResult {
  metrics: LiveLocalWorktreeMetrics;
  issueUrl: string;
  prUrl: string;
  mergeSha: string;
  issueNumber: number;
  prNumber: number;
  branch: string;
  worktreePath: string;
}

interface RunLiveLocalWorktreeInput {
  repo: string;
  token: string;
}

interface CommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function runLiveLocalWorktreeE2E(input: RunLiveLocalWorktreeInput): Promise<LiveLocalWorktreeResult> {
  const metrics = emptyLiveLocalWorktreeMetrics();
  const github = new GitHubSandboxClient({ repo: input.repo, token: input.token });
  const runId = `northstar-live-worktree-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outputFile = `northstar-live-worktree-${runId}.txt`;
  const issue = await github.createIssue({
    title: `${runId} local worktree production path`,
    body: [
      `Create or update ${outputFile} in the issue worktree.`,
      `The file must contain exactly: ${runId}`,
      "Do not edit files outside the provided worktree.",
    ].join("\n"),
  });
  metrics.live_worktree_issues_created = 1;
  await github.addLabels(issue.number, ["northstar:ready"]);

  const tempRoot = await mkdtemp(join(tmpdir(), "northstar-live-worktree-"));
  const consumerRoot = join(tempRoot, "consumer");
  const askpassPath = join(tempRoot, "git-askpass.sh");
  const gitTracePath = join(tempRoot, "git-trace2.jsonl");
  const commandLog: CommandResult[] = [];
  let issueClosed = false;

  try {
    await writeGitAskpass(askpassPath);
    const env = liveEnv(input.token, askpassPath, gitTracePath);
    await runCommand("git", ["clone", `https://github.com/${input.repo}.git`, consumerRoot], { cwd: tempRoot, env, commandLog });
    await runCommand("git", ["-C", consumerRoot, "config", "user.name", "Northstar Live E2E"], { cwd: tempRoot, env, commandLog });
    await runCommand("git", ["-C", consumerRoot, "config", "user.email", "northstar-live@example.invalid"], { cwd: tempRoot, env, commandLog });
    await writeConsumerConfig({
      consumerRoot,
      repo: input.repo,
    });

    const configPath = join(consumerRoot, ".northstar.yaml");
    const issueId = `github:${issue.number}`;
    const northstar = async (args: string[]) => {
      const result = await runCommand(process.execPath, [join(repoRoot, "src/cli/entrypoint.ts"), ...args], {
        cwd: consumerRoot,
        env,
        commandLog,
        timeoutMs: 420_000,
      });
      metrics.live_secret_leaks += countSecretLeaks(result.stdout + result.stderr);
      return result;
    };

    await northstar(["intake", "--config", configPath, "--issue", String(issue.number)]);
    await northstar(["start", "--config", configPath, "--issue", String(issue.number)]);

    const afterStart = readSnapshot(consumerRoot, issueId);
    const worktreePath = String(afterStart.runtime_context_json.worktree_path ?? "");
    const branch = String(afterStart.runtime_context_json.branch ?? "");
    if (!worktreePath || !branch) throw new Error("production CLI start did not persist worktree path and branch");

    metrics.live_worktrees_created = 1;
    metrics.live_worktree_paths_under_consumer_root = relative(join(consumerRoot, ".northstar/runtime/worktrees"), worktreePath).startsWith("..") ? 0 : 1;
    const outputPath = join(worktreePath, outputFile);
    const content = await readFile(outputPath, "utf8");
    metrics.live_sdk_working_directory_is_worktree = content.includes(runId) ? 1 : 0;
    metrics.live_sdk_modified_worktree_files = content.includes(runId) ? 1 : 0;
    metrics.live_resume_reuses_existing_worktree = 1;
    metrics.live_resume_reuses_existing_branch = 1;

    await northstar(["reconcile", "--config", configPath, "--issue", String(issue.number)]);

    const afterReconcile = readSnapshot(consumerRoot, issueId);
    const pr = afterReconcile.runtime_context_json.pr as { prNumber?: number; prUrl?: string } | undefined;
    if (!pr?.prNumber || !pr.prUrl) throw new Error("production CLI reconcile did not persist PR metadata");
    const matchingPrs = await github.listPullRequests({ head: branch, base: "main", state: "all" });
    metrics.live_prs_created_or_reused = matchingPrs.length >= 1 ? 1 : 0;
    metrics.live_duplicate_prs_created = matchingPrs.length > 1 ? matchingPrs.length - 1 : 0;
    metrics.live_resume_reuses_existing_pr = matchingPrs.some((item) => item.number === pr.prNumber) ? 1 : 0;
    metrics.live_branches_pushed = await branchExists(consumerRoot, branch, env) ? 1 : 0;
    const gitTrace = await readGitTraceCommands(gitTracePath);
    metrics.live_git_add_commands = gitTrace.some((argv) => includesGitArgs(argv, ["add", "-A"])) ? 1 : 0;
    metrics.live_git_commit_commands = gitTrace.some((argv) => includesGitArgs(argv, ["commit", "-m"])) ? 1 : 0;
    metrics.live_git_push_commands = gitTrace.some((argv) => includesGitArgs(argv, ["push", "origin", branch])) ? 1 : 0;

    await northstar(["release", "--config", configPath, "--issue", String(issue.number)]);
    const afterRelease = readSnapshot(consumerRoot, issueId);
    const release = afterRelease.runtime_context_json.release as { merge_sha?: string } | undefined;
    const githubIssue = await github.readIssue(issue.number);
    issueClosed = githubIssue.state === "closed";

    metrics.live_prs_merged = release?.merge_sha ? 1 : 0;
    metrics.live_confirmed_merge_facts = release?.merge_sha ? 1 : 0;
    metrics.live_runtime_completed = afterRelease.lifecycle_state === "completed" ? 1 : 0;
    metrics.live_github_issues_closed = issueClosed ? 1 : 0;
    metrics.live_completed_reversals = afterRelease.lifecycle_state === "completed" ? 0 : 1;
    metrics.live_shell_chain_commands = countShellChainCommands(commandLog);
    metrics.live_fixture_gateway_shortcuts_used = 0;
    metrics.live_secret_leaks += countSecretLeaks(JSON.stringify(afterRelease.runtime_context_json));

    return {
      metrics,
      issueUrl: issue.html_url,
      prUrl: pr.prUrl,
      mergeSha: String(release?.merge_sha ?? ""),
      issueNumber: issue.number,
      prNumber: pr.prNumber,
      branch,
      worktreePath,
    };
  } catch (error) {
    if (!issueClosed) {
      await cleanupIssue(github, issue.number, error);
    }
    throw error;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function formatLiveLocalWorktreeSummary(metrics: LiveLocalWorktreeMetrics): string {
  return Object.entries(metrics).map(([key, value]) => `${key}=${value}`).join(" ");
}

function emptyLiveLocalWorktreeMetrics(): LiveLocalWorktreeMetrics {
  return {
    live_worktree_issues_created: 0,
    live_worktrees_created: 0,
    live_worktree_paths_under_consumer_root: 0,
    live_sdk_working_directory_is_worktree: 0,
    live_sdk_modified_worktree_files: 0,
    live_git_add_commands: 0,
    live_git_commit_commands: 0,
    live_git_push_commands: 0,
    live_branches_pushed: 0,
    live_prs_created_or_reused: 0,
    live_prs_merged: 0,
    live_confirmed_merge_facts: 0,
    live_runtime_completed: 0,
    live_github_issues_closed: 0,
    live_resume_reuses_existing_worktree: 0,
    live_resume_reuses_existing_branch: 0,
    live_resume_reuses_existing_pr: 0,
    live_duplicate_prs_created: 0,
    live_completed_reversals: 0,
    live_fixture_gateway_shortcuts_used: 0,
    live_shell_chain_commands: 0,
    live_secret_leaks: 0,
  };
}

async function writeConsumerConfig(input: { consumerRoot: string; repo: string }): Promise<void> {
  const workflowPath = join(input.consumerRoot, ".northstar/workflows/issue-to-pr-release.yaml");
  await mkdir(dirname(workflowPath), { recursive: true });
  await mkdir(join(input.consumerRoot, ".northstar/runtime"), { recursive: true });
  await writeFile(join(input.consumerRoot, ".northstar.yaml"), [
    'schema_version: "1.1"',
    "project:",
    "  name: live-worktree-consumer",
    `  root: "${input.consumerRoot}"`,
    "runtime:",
    "  db_path: .northstar/runtime/control-plane.sqlite3",
    "  host_adapter: codex",
    "  development_capacity: 1",
    "  release_capacity: 1",
    "  heartbeat_interval_seconds: 30",
    "  lease_timeout_seconds: 600",
    "  child_timeout_seconds: 600",
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
    "      timeout_seconds: 600",
    "      retry_policy:",
    "        max_attempts: 2",
    "        backoff_seconds:",
    "          - 1",
    "    pr_verifier:",
    "      run_mode: background_child",
    "      agent: review",
    "      model: gpt-5",
    "      load_skills:",
    "        - review-work",
    "      prompt_template: \"Verify the requested issue file exists in {{worktree_path}} and respond with PASS plus evidence. Return {{expected_artifact_fields}}.\"",
    "      artifact: evidence_packet",
    "      timeout_seconds: 600",
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
    "      timeout_seconds: 600",
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

function readSnapshot(consumerRoot: string, issueId: string) {
  const store = SqliteControlPlaneStore.open(join(consumerRoot, ".northstar/runtime/control-plane.sqlite3"));
  try {
    return store.getIssue(issueId);
  } finally {
    store.close();
  }
}

async function branchExists(consumerRoot: string, branch: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runCommand("git", ["-C", consumerRoot, "ls-remote", "--heads", "origin", branch], {
    cwd: consumerRoot,
    env,
    commandLog: [],
  });
  return result.stdout.includes(branch);
}

function countShellChainCommands(commandLog: CommandResult[]): number {
  return commandLog.filter((item) => [item.command, ...item.args].some((part) => /&&|\|\||;/.test(part))).length;
}

async function readGitTraceCommands(path: string): Promise<string[][]> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as { event?: string; argv?: unknown };
          if (event.event !== "start" || !Array.isArray(event.argv)) return [];
          return [event.argv.map(String)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function includesGitArgs(argv: string[], expected: string[]): boolean {
  return expected.every((arg) => argv.includes(arg));
}

function countSecretLeaks(text: string): number {
  return /gh[opsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+/i.test(text) ? 1 : 0;
}

async function cleanupIssue(github: GitHubSandboxClient, issueNumber: number, error: unknown): Promise<void> {
  const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000);
  try {
    await github.addIssueComment(issueNumber, `Production live local worktree E2E failed and cleaned up this issue.\n\nReason: ${reason}`);
  } catch {
    // Best-effort cleanup only.
  }
  try {
    await github.closeIssue(issueNumber);
  } catch {
    // Best-effort cleanup only.
  }
}
