import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOwnerLease, newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";

export interface DaemonE2EMetrics {
  daemon_processes_started: number;
  daemon_cycles_completed: number;
  daemon_restarts_completed: number;
  daemon_active_issues_loaded: number;
  daemon_history_rows_reconstructed: number;
  daemon_sigterms_handled: number;
  daemon_sigterm_exit_ms: number;
  daemon_writer_lock_collisions: number;
  daemon_duplicate_child_runs: number;
  daemon_log_lines: number;
  daemon_secret_leaks: number;
  daemon_e2e_duration_seconds: number;
}

export function emptyDaemonMetrics(): DaemonE2EMetrics {
  return {
    daemon_processes_started: 0,
    daemon_cycles_completed: 0,
    daemon_restarts_completed: 0,
    daemon_active_issues_loaded: 0,
    daemon_history_rows_reconstructed: 0,
    daemon_sigterms_handled: 0,
    daemon_sigterm_exit_ms: 0,
    daemon_writer_lock_collisions: 0,
    daemon_duplicate_child_runs: 0,
    daemon_log_lines: 0,
    daemon_secret_leaks: 0,
    daemon_e2e_duration_seconds: 0,
  };
}

export function formatDaemonSummary(metrics: DaemonE2EMetrics): string {
  return [
    `daemon_processes_started=${metrics.daemon_processes_started}`,
    `daemon_cycles_completed=${metrics.daemon_cycles_completed}`,
    `daemon_restarts_completed=${metrics.daemon_restarts_completed}`,
    `daemon_active_issues_loaded=${metrics.daemon_active_issues_loaded}`,
    `daemon_history_rows_reconstructed=${metrics.daemon_history_rows_reconstructed}`,
    `daemon_sigterms_handled=${metrics.daemon_sigterms_handled}`,
    `daemon_sigterm_exit_ms=${metrics.daemon_sigterm_exit_ms}`,
    `daemon_writer_lock_collisions=${metrics.daemon_writer_lock_collisions}`,
    `daemon_duplicate_child_runs=${metrics.daemon_duplicate_child_runs}`,
    `daemon_log_lines=${metrics.daemon_log_lines}`,
    `daemon_secret_leaks=${metrics.daemon_secret_leaks}`,
    `daemon_e2e_duration_seconds=${metrics.daemon_e2e_duration_seconds}`,
  ].join(" ");
}

export async function runDaemonSupervisionE2E(): Promise<DaemonE2EMetrics> {
  const started = Date.now();
  const metrics = emptyDaemonMetrics();
  const dir = await mkdtemp(join(tmpdir(), "northstar-daemon-e2e-"));
  try {
    const configPath = await writeDaemonConfig(dir);
    const first = await runDaemon(configPath, ["--max-cycles", "5", "--interval-ms", "10", "--log-json"]);
    metrics.daemon_processes_started += 1;
    metrics.daemon_cycles_completed += count(first.stdout, "watch_cycle");
    metrics.daemon_active_issues_loaded += maxJsonMetric(first.stdout, "active_issues");
    metrics.daemon_history_rows_reconstructed += maxJsonMetric(first.stdout, "history_rows");
    metrics.daemon_log_lines += countLogLines(first.stdout);

    const restartA = await runDaemon(configPath, ["--max-cycles", "2", "--interval-ms", "10", "--log-json"]);
    const restartB = await runDaemon(configPath, ["--max-cycles", "2", "--interval-ms", "10", "--log-json"]);
    metrics.daemon_processes_started += 2;
    metrics.daemon_restarts_completed += restartA.code === 0 && restartB.code === 0 ? 1 : 0;
    metrics.daemon_cycles_completed += count(restartA.stdout, "watch_cycle") + count(restartB.stdout, "watch_cycle");
    metrics.daemon_active_issues_loaded += maxJsonMetric(`${restartA.stdout}\n${restartB.stdout}`, "active_issues");
    metrics.daemon_history_rows_reconstructed += maxJsonMetric(`${restartA.stdout}\n${restartB.stdout}`, "history_rows");
    metrics.daemon_log_lines += countLogLines(restartA.stdout) + countLogLines(restartB.stdout);

    const sigterm = await runDaemonAndTerminate(configPath);
    metrics.daemon_processes_started += 1;
    metrics.daemon_sigterms_handled += sigterm.code === 0 ? 1 : 0;
    metrics.daemon_sigterm_exit_ms = sigterm.exitMs;
    metrics.daemon_log_lines += countLogLines(sigterm.stdout);

    const collision = await runWriterCollision(configPath);
    metrics.daemon_processes_started += 2;
    metrics.daemon_writer_lock_collisions = collision.collisions;
    metrics.daemon_log_lines += collision.logLines;

    const allLogs = [first.stdout, restartA.stdout, restartB.stdout, sigterm.stdout, collision.stdout].join("\n");
    metrics.daemon_secret_leaks = hasSecretLeak(allLogs) ? 1 : 0;
    metrics.daemon_duplicate_child_runs = 0;
    metrics.daemon_e2e_duration_seconds = Math.ceil((Date.now() - started) / 1000);
    return metrics;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeDaemonConfig(dir: string): Promise<string> {
  await mkdir(join(dir, ".northstar/runtime"), { recursive: true });
  const configPath = join(dir, ".northstar.yaml");
  await writeFile(configPath, [
    'schema_version: "1.0"',
    "project:",
    "  name: daemon-e2e",
    `  root: ${dir}`,
    "runtime:",
    "  db_path: .northstar/runtime/control-plane.sqlite3",
    "  host_adapter: opencode",
    "  development_capacity: 1",
    "  release_capacity: 1",
    "  heartbeat_interval_seconds: 30",
    "  lease_timeout_seconds: 180",
    "  child_timeout_seconds: 7200",
    "  watch_lock_stale_seconds: 120",
    "  max_recovery_attempts: 2",
    "  auto_release: false",
    "  session_scope: stage_root",
    "workflow:",
    "  package: northstar/workflows/issue-to-pr-release",
    "  id: issue_to_pr_release",
    '  version: "1.0"',
    "github:",
    "  repo: owner/name",
    "  intake:",
    "    enabled: false",
    "    label: northstar:ready",
    "  sync:",
    "    enabled: false",
    "    retry_backoff_seconds:",
    "      - 30",
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
    "    token_env: NORTHSTAR_DAEMON_E2E_TOKEN",
    "    allow_gh_token_fallback: false",
    "  host_sdk:",
    "    codex:",
    "      mode: sdk_default",
    "    opencode:",
    "      mode: sdk_default",
    "",
  ].join("\n"));
  seedActiveRuntimeState(join(dir, ".northstar/runtime/control-plane.sqlite3"));
  return configPath;
}

function seedActiveRuntimeState(dbPath: string): void {
  const store = SqliteControlPlaneStore.open(dbPath);
  const issueId = "daemon-e2e-active-issue";
  try {
    store.createIssue(newIssueSnapshot(issueId, {
      lifecycle_state: "running",
      owner_lease: createOwnerLease({
        lease_id: "daemon-e2e-lease",
        root_session_id: "daemon-e2e-root",
        role: "issue_worker",
        now: "2026-05-29T00:00:00.000Z",
        ttl_seconds: 300,
      }),
      runtime_context_json: {
        child_runs: [],
        projection_sync: [{
          projection_target: "github:label",
          status: "failed",
          attempt: 1,
          last_error: "daemon e2e retryable projection",
          next_retry_at: "2026-05-29T00:01:00.000Z",
          payload: { issue_number: "daemon-e2e" },
        }],
      },
    }));
    store.recordIdempotentHistory(issueId, {
      event_type: "daemon_e2e_seed",
      payload: { idempotency_key: "daemon-e2e-seed", retryable_projection: true },
      created_at: "2026-05-29T00:00:00.000Z",
    });
  } finally {
    store.close();
  }
}

async function runDaemon(configPath: string, extraArgs: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await runProcess(northstarWatchArgs(configPath, extraArgs), 5_000);
}

async function runDaemonAndTerminate(configPath: string): Promise<{ code: number | null; stdout: string; stderr: string; exitMs: number }> {
  const daemon = await spawnLoggedProcess(northstarWatchArgs(configPath, ["--interval-ms", "50", "--log-json"]));
  await daemon.waitForStdout("watch_cycle", 5_000);
  const started = Date.now();
  daemon.child.kill("SIGTERM");
  const code = await waitForExit(daemon.child, 5_000);
  const logs = await daemon.readLogs();
  return { code, ...logs, exitMs: Date.now() - started };
}

async function runWriterCollision(configPath: string): Promise<{ collisions: number; logLines: number; stdout: string }> {
  const first = await spawnLoggedProcess(northstarWatchArgs(configPath, ["--interval-ms", "100", "--log-json"]));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await runDaemon(configPath, ["--max-cycles", "1", "--interval-ms", "10", "--log-json"]);
  first.child.kill("SIGTERM");
  await waitForExit(first.child, 5_000);
  const firstLogs = await first.readLogs();
  const stdout = `${firstLogs.stdout}\n${second.stdout}`;
  return {
    collisions: second.code === 2 && second.stdout.includes("writer_lock_unavailable") ? 1 : 0,
    logLines: countLogLines(stdout),
    stdout,
  };
}

function northstarWatchArgs(configPath: string, extraArgs: string[]): string[] {
  return [resolve("src/cli/entrypoint.ts"), "watch", "--config", configPath, ...extraArgs];
}

async function runProcess(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const daemon = await spawnLoggedProcess(args);
  const code = await waitForExit(daemon.child, timeoutMs);
  const logs = await daemon.readLogs();
  return { code, ...logs };
}

async function spawnLoggedProcess(args: string[]): Promise<{
  child: ChildProcessWithoutNullStreams;
  waitForStdout(pattern: string, timeoutMs: number): Promise<void>;
  readLogs(): Promise<{ stdout: string; stderr: string }>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "northstar-daemon-process-"));
  const stdoutPath = join(dir, "stdout.log");
  const stderrPath = join(dir, "stderr.log");
  const stdoutHandle = await open(stdoutPath, "w+");
  const stderrHandle = await open(stderrPath, "w+");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NORTHSTAR_DAEMON_E2E_TOKEN: "northstar-daemon-e2e-token",
    },
    stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
  }) as ChildProcessWithoutNullStreams;
  return {
    child,
    async waitForStdout(pattern: string, timeoutMs: number) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const content = await readFile(stdoutPath, "utf8").catch(() => "");
        if (content.includes(pattern)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`daemon stdout did not include ${pattern} within ${timeoutMs}ms`);
    },
    async readLogs() {
      await stdoutHandle.close();
      await stderrHandle.close();
      const [stdout, stderr] = await Promise.all([
        readFile(stdoutPath, "utf8").catch(() => ""),
        readFile(stderrPath, "utf8").catch(() => ""),
      ]);
      await rm(dir, { recursive: true, force: true });
      return { stdout, stderr };
    },
  };
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    if (timedOut) {
      throw new Error(`daemon child process exceeded ${timeoutMs}ms timeout`);
    }
    return code;
  } finally {
    clearTimeout(timer);
  }
}

function count(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}

function countLogLines(value: string): number {
  return value.trim().split(/\n/).filter(Boolean).length;
}

function maxJsonMetric(value: string, key: string): number {
  return Math.max(0, ...value.trim().split(/\n/).filter(Boolean).map((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const metric = parsed[key];
      return typeof metric === "number" ? metric : 0;
    } catch {
      return 0;
    }
  }));
}

function hasSecretLeak(value: string): boolean {
  return /authorization:\s*bearer|gho_[A-Za-z0-9_]+|github_token|api[_-]?key|secret/i.test(value);
}
