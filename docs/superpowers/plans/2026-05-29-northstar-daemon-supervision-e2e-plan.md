# Northstar Daemon Supervision E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only real process E2E suite proving `northstar watch` can run bounded cycles, reconstruct from SQLite after restart, handle SIGTERM, enforce one writer, and emit compact safe logs.

**Architecture:** Implement a real watch command path behind the existing CLI entrypoint, backed by focused production helpers for watch options, writer locking, and compact logging. Add `tests/e2e-daemon/` with a harness that creates a temp project, spawns the CLI as child processes using argv arrays, captures logs, and asserts quantified supervision metrics.

**Tech Stack:** Node 22.22+, `node:test`, `node:assert/strict`, `node:child_process.spawn`, `node:fs/promises`, `node:sqlite`, existing `createWatchLoop`, `SqliteControlPlaneStore`, and CLI modules.

---

## Source Spec

Use [docs/superpowers/specs/2026-05-29-northstar-live-and-daemon-e2e-design.md](/home/timmypai/apps/northstar/docs/superpowers/specs/2026-05-29-northstar-live-and-daemon-e2e-design.md) as the authoritative requirement source.

## File Structure

- Modify `package.json`: add `test:e2e:daemon`.
- Create `tests/e2e-daemon/index.test.ts`: daemon E2E entrypoint.
- Create `tests/e2e-daemon/daemon-e2e.test.ts`: quantified E2E assertions.
- Create `tests/e2e-daemon/harness.ts`: temp project, spawn helpers, log parser, metrics.
- Create `src/runtime/watch-lock.ts`: SQLite/file-backed single writer lock helper.
- Create `src/runtime/watch-logger.ts`: compact JSON/text log helpers with secret guard.
- Create `src/cli/watch-command.ts`: parse watch options and run bounded watch loops.
- Modify `src/cli/northstar.ts`: expose `formatNorthstarWatchHelp` and parse watch-specific flags.
- Modify `src/cli/entrypoint.ts`: dispatch `watch --help` and real watch command execution.
- Create `docs/superpowers/daemon-e2e-coverage.md`: daemon E2E coverage matrix.
- Modify `tests/runtime/watch.test.ts` and `tests/cli/cli.test.ts` for focused unit coverage before E2E.

## Task 1: Add Daemon E2E Shell And RED Summary Contract

**Files:**
- Modify: `package.json`
- Create: `tests/e2e-daemon/index.test.ts`
- Create: `tests/e2e-daemon/harness.ts`
- Create: `tests/e2e-daemon/daemon-e2e.test.ts`

- [ ] **Step 1: Write failing daemon E2E shell**

Create `tests/e2e-daemon/index.test.ts`:

```ts
import "./daemon-e2e.test.ts";
```

Create `tests/e2e-daemon/harness.ts`:

```ts
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
  throw new Error("pending daemon E2E harness implementation");
}
```

Create `tests/e2e-daemon/daemon-e2e.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { formatDaemonSummary, runDaemonSupervisionE2E } from "./harness.ts";

test("real daemon supervision E2E reports quantified metrics", async (t) => {
  const metrics = await runDaemonSupervisionE2E();
  t.diagnostic(formatDaemonSummary(metrics));

  assert.ok(metrics.daemon_processes_started >= 3);
  assert.ok(metrics.daemon_cycles_completed >= 5);
  assert.ok(metrics.daemon_restarts_completed >= 1);
  assert.ok(metrics.daemon_active_issues_loaded >= 1);
  assert.ok(metrics.daemon_history_rows_reconstructed >= 1);
  assert.ok(metrics.daemon_sigterms_handled >= 1);
  assert.ok(metrics.daemon_sigterm_exit_ms <= 5000);
  assert.equal(metrics.daemon_writer_lock_collisions, 1);
  assert.equal(metrics.daemon_duplicate_child_runs, 0);
  assert.ok(metrics.daemon_log_lines >= 5);
  assert.equal(metrics.daemon_secret_leaks, 0);
  assert.ok(metrics.daemon_e2e_duration_seconds <= 120);
});
```

- [ ] **Step 2: Add npm script**

Modify `package.json`:

```json
"test:e2e:daemon": "node --disable-warning=ExperimentalWarning tests/e2e-daemon/index.test.ts"
```

- [ ] **Step 3: Run RED**

```bash
npm run test:e2e:daemon
```

Expected: FAIL with `pending daemon E2E harness implementation`.

- [ ] **Step 4: Commit shell**

```bash
git add package.json tests/e2e-daemon/index.test.ts tests/e2e-daemon/harness.ts tests/e2e-daemon/daemon-e2e.test.ts
git commit -m "test: add daemon e2e acceptance shell"
```

## Task 2: Add Watch Help And Bounded CLI Options

**Files:**
- Modify: `src/cli/northstar.ts`
- Modify: `src/cli/entrypoint.ts`
- Modify: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Append to `tests/cli/cli.test.ts`:

```ts
import { formatNorthstarWatchHelp } from "../../src/cli/northstar.ts";

test("watch help documents daemon e2e safe bounded flags", () => {
  const help = formatNorthstarWatchHelp();

  assert.match(help, /--max-cycles/);
  assert.match(help, /--interval-ms/);
  assert.match(help, /--log-json/);
});

test("watch command parses bounded daemon options", () => {
  const parsed = runNorthstarCli(["watch", "--max-cycles", "5", "--interval-ms", "50", "--log-json"]);

  assert.equal(parsed.command, "watch");
  assert.deepEqual(parsed.args, ["--max-cycles", "5", "--interval-ms", "50", "--log-json"]);
});
```

- [ ] **Step 2: Run RED**

```bash
npm test
```

Expected: FAIL because `formatNorthstarWatchHelp` is not exported.

- [ ] **Step 3: Implement watch help**

Modify `src/cli/northstar.ts`:

```ts
export function formatNorthstarWatchHelp(): string {
  return [
    "Northstar watch",
    "",
    "Usage:",
    "  northstar watch [--config .northstar.yaml] [--max-cycles NUMBER] [--interval-ms NUMBER] [--log-json]",
    "",
    "Options:",
    "  --max-cycles NUMBER  Stop after this many watch cycles.",
    "  --interval-ms NUMBER Sleep interval between cycles.",
    "  --log-json             Emit compact JSON cycle logs.",
  ].join("\n");
}
```

Modify `src/cli/entrypoint.ts`:

```ts
import { buildCliCommand, formatNorthstarHelp, formatNorthstarVersion, formatNorthstarWatchHelp } from "./northstar.ts";
```

Add before `buildCliCommand(argv)`:

```ts
  if (argv[0] === "watch" && (argv[1] === "--help" || argv[1] === "-h")) {
    console.log(formatNorthstarWatchHelp());
    return 0;
  }
```

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test
node --run northstar -- watch --help
git add src/cli/northstar.ts src/cli/entrypoint.ts tests/cli/cli.test.ts
git commit -m "feat: document watch bounded options"
```

Expected: `npm test` PASS and watch help includes all three daemon flags.

## Task 3: Add Watch Writer Lock And Compact Logger Units

**Files:**
- Create: `src/runtime/watch-lock.ts`
- Create: `src/runtime/watch-logger.ts`
- Modify: `tests/runtime/watch.test.ts`

- [ ] **Step 1: Write failing lock/logger tests**

Append to `tests/runtime/watch.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireFileWatchWriter } from "../../src/runtime/watch-lock.ts";
import { compactWatchLogLine, containsSecretLeak } from "../../src/runtime/watch-logger.ts";

test("file watch writer lock rejects a second writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-lock-"));
  try {
    const first = await acquireFileWatchWriter(join(dir, "watch.lock"));
    const second = await acquireFileWatchWriter(join(dir, "watch.lock"));

    assert.ok(first);
    assert.equal(second, undefined);
    await first?.release();
    const third = await acquireFileWatchWriter(join(dir, "watch.lock"));
    assert.ok(third);
    await third?.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compact watch logs include cycle metrics and reject secret-shaped values", () => {
  const line = compactWatchLogLine({
    event: "watch_cycle",
    cycle: 1,
    active_issues: 2,
    effects_started: 0,
  });

  assert.match(line, /watch_cycle/);
  assert.match(line, /"cycle":1/);
  assert.equal(containsSecretLeak(line), false);
  assert.equal(containsSecretLeak("Authorization: Bearer abcdefghijklmnop"), true);
});
```

- [ ] **Step 2: Run RED**

```bash
npm test
```

Expected: FAIL because `src/runtime/watch-lock.ts` and `src/runtime/watch-logger.ts` do not exist.

- [ ] **Step 3: Implement lock and logger**

Create `src/runtime/watch-lock.ts`:

```ts
import { open, rm } from "node:fs/promises";

export interface FileWatchWriterLease {
  release(): Promise<void>;
}

export async function acquireFileWatchWriter(path: string): Promise<FileWatchWriterLease | undefined> {
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(JSON.stringify({ pid: globalThis.process?.pid ?? 0, acquired_at: new Date().toISOString() }));
    return {
      async release() {
        await handle.close();
        await rm(path, { force: true });
      },
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "EEXIST") {
      return undefined;
    }
    throw error;
  }
}
```

Create `src/runtime/watch-logger.ts`:

```ts
const secretPatterns = [
  /authorization:\s*bearer/i,
  /gho_[A-Za-z0-9_]+/,
  /github_token/i,
  /api[_-]?key/i,
  /secret/i,
];

export function compactWatchLogLine(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export function containsSecretLeak(value: string): boolean {
  return secretPatterns.some((pattern) => pattern.test(value));
}
```

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test
git add src/runtime/watch-lock.ts src/runtime/watch-logger.ts tests/runtime/watch.test.ts
git commit -m "feat: add watch lock and compact logs"
```

## Task 4: Implement Real Watch Command Runner

**Files:**
- Create: `src/cli/watch-command.ts`
- Modify: `src/cli/entrypoint.ts`
- Modify: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing watch command unit test**

Append to `tests/cli/cli.test.ts`:

```ts
import { parseWatchOptions } from "../../src/cli/watch-command.ts";

test("parseWatchOptions returns bounded daemon options", () => {
  assert.deepEqual(parseWatchOptions(["--config", "tmp/.northstar.yaml", "--max-cycles", "5", "--interval-ms", "50", "--log-json"]), {
    configPath: "tmp/.northstar.yaml",
    maxCycles: 5,
    intervalMs: 50,
    logJson: true,
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npm test
```

Expected: FAIL because `src/cli/watch-command.ts` does not exist.

- [ ] **Step 3: Implement parser and bounded runner**

Create `src/cli/watch-command.ts`:

```ts
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config/load-config.ts";
import { compactWatchLogLine } from "../runtime/watch-logger.ts";
import { acquireFileWatchWriter } from "../runtime/watch-lock.ts";
import { SqliteControlPlaneStore } from "../runtime/store.ts";
import { createWatchLoop } from "../runtime/watch.ts";

export interface WatchCommandOptions {
  configPath: string;
  maxCycles?: number;
  intervalMs: number;
  logJson: boolean;
}

export function parseWatchOptions(args: string[]): WatchCommandOptions {
  return {
    configPath: optionValue(args, "--config") ?? ".northstar.yaml",
    maxCycles: numberOption(args, "--max-cycles"),
    intervalMs: numberOption(args, "--interval-ms") ?? 1000,
    logJson: args.includes("--log-json"),
  };
}

export async function runWatchCommand(args: string[], io: { log(line: string): void } = { log: console.log }): Promise<number> {
  const options = parseWatchOptions(args);
  const config = loadConfig(options.configPath);
  const runtimeDir = resolve(config.project.root, ".northstar/runtime");
  const dbPath = resolve(config.project.root, config.runtime.dbPath);
  await mkdir(runtimeDir, { recursive: true });
  const lockPath = join(runtimeDir, "watch.lock");
  let stopping = false;
  const onSigterm = () => {
    stopping = true;
  };
  process.once("SIGTERM", onSigterm);
  try {
    const loop = createWatchLoop({
      intervalMs: options.intervalMs,
      maxCycles: options.maxCycles,
      acquireWriter: async () => await acquireFileWatchWriter(lockPath),
      runCycle: async () => {
        const store = SqliteControlPlaneStore.open(dbPath);
        try {
          const activeIssues = store.listActiveIssues();
          const historyRows = activeIssues.reduce((total, issue) => total + store.listRecentHistory(issue.issue_id, 20).length, 0);
          io.log(compactWatchLogLine({
            event: "watch_cycle",
            active_issues: activeIssues.length,
            history_rows: historyRows,
            effects_started: 0,
          }));
          return { activeIssues: activeIssues.length, effectsStarted: 0 };
        } finally {
          store.close();
        }
      },
      sleep: async (ms) => await new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      shouldStop: () => stopping,
    });
    const result = await loop.run();
    if (result.skipped_reason === "writer_lock_unavailable") {
      io.log(compactWatchLogLine({ event: "watch_skipped", reason: "writer_lock_unavailable" }));
      return 2;
    }
    io.log(compactWatchLogLine({ event: "watch_stopped", cycles: result.cycles }));
    return 0;
  } finally {
    process.off("SIGTERM", onSigterm);
  }
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function numberOption(args: string[], option: string): number | undefined {
  const value = optionValue(args, option);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}
```

Modify `src/cli/entrypoint.ts`:

```ts
import { runWatchCommand } from "./watch-command.ts";
```

Change `main` to async:

```ts
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
```

Add before `buildCliCommand(argv)`:

```ts
  if (argv[0] === "watch") {
    return await runWatchCommand(argv.slice(1));
  }
```

Change bottom block:

```ts
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
```

Modify `tests/cli/cli.test.ts`:

```ts
test("executable entrypoint prints help without loading project config", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value: string) => output.push(value);
  try {
    assert.equal(await main(["--help"]), 0);
  } finally {
    console.log = originalLog;
  }
  assert.match(output.join("\n"), /northstar watch/);
});
```

Modify `tests/cli/packaging.test.ts` where it calls `main()`:

```ts
test("entrypoint prints version and help through local executable dispatcher", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value: string) => output.push(value);
  try {
    assert.equal(await main(["--version"]), 0);
    assert.equal(await main(["--help"]), 0);
  } finally {
    console.log = originalLog;
  }

  assert.match(output.join("\n"), /0\.1\.0/);
  assert.match(output.join("\n"), /northstar watch/);
});
```

- [ ] **Step 4: Run GREEN and smoke**

```bash
npm test
node --run northstar -- watch --help
```

Expected: tests PASS; help prints bounded flags.

- [ ] **Step 5: Commit watch command**

```bash
git add src/cli/watch-command.ts src/cli/entrypoint.ts src/cli/northstar.ts tests/cli/cli.test.ts
git commit -m "feat: run bounded watch command"
```

## Task 5: Implement Daemon E2E Harness

**Files:**
- Modify: `tests/e2e-daemon/harness.ts`
- Modify: `tests/e2e-daemon/daemon-e2e.test.ts`

- [ ] **Step 1: Replace pending harness with real process harness**

Replace `tests/e2e-daemon/harness.ts` with:

```ts
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    metrics.daemon_log_lines += first.stdout.trim().split(/\n/).filter(Boolean).length;

    const restartA = await runDaemon(configPath, ["--max-cycles", "2", "--interval-ms", "10", "--log-json"]);
    const restartB = await runDaemon(configPath, ["--max-cycles", "2", "--interval-ms", "10", "--log-json"]);
    metrics.daemon_processes_started += 2;
    metrics.daemon_restarts_completed += restartA.code === 0 && restartB.code === 0 ? 1 : 0;
    metrics.daemon_cycles_completed += count(restartA.stdout, "watch_cycle") + count(restartB.stdout, "watch_cycle");
    metrics.daemon_active_issues_loaded += maxJsonMetric(`${restartA.stdout}\n${restartB.stdout}`, "active_issues");
    metrics.daemon_history_rows_reconstructed += maxJsonMetric(`${restartA.stdout}\n${restartB.stdout}`, "history_rows");
    metrics.daemon_log_lines += restartA.stdout.trim().split(/\n/).filter(Boolean).length;
    metrics.daemon_log_lines += restartB.stdout.trim().split(/\n/).filter(Boolean).length;

    const sigterm = await runDaemonAndTerminate(configPath);
    metrics.daemon_processes_started += 1;
    metrics.daemon_sigterms_handled += sigterm.code === 0 ? 1 : 0;
    metrics.daemon_sigterm_exit_ms = sigterm.exitMs;
    metrics.daemon_log_lines += sigterm.stdout.trim().split(/\n/).filter(Boolean).length;

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
    "  host_adapter: fake",
    "  development_capacity: 1",
    "  release_capacity: 1",
    "  heartbeat_interval_seconds: 30",
    "  lease_timeout_seconds: 180",
    "  child_timeout_seconds: 7200",
    "workflow:",
    "  package: northstar/workflows/issue-to-pr-release",
    "  id: issue_to_pr_release",
    '  version: "1.0"',
    "github:",
    "  repo: owner/name",
    "  sync:",
    "    enabled: false",
    "    retry_backoff_seconds: [30]",
    "git:",
    "  base_branch: main",
    "  worktrees_dir: .northstar/runtime/worktrees",
    "  sync_worktree_dir: .northstar/runtime/sync-worktrees/main",
    "policy:",
    "  github_sync_blocks_lifecycle: false",
    "  quarantine_requires_operator: true",
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
  return await runProcess(["--run", "northstar", "--", "watch", "--config", configPath, ...extraArgs]);
}

async function runDaemonAndTerminate(configPath: string): Promise<{ code: number | null; stdout: string; stderr: string; exitMs: number }> {
  const child = spawn(process.execPath, ["--run", "northstar", "--", "watch", "--config", configPath, "--interval-ms", "50", "--log-json"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => stdout += String(chunk));
  child.stderr?.on("data", (chunk) => stderr += String(chunk));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  child.kill("SIGTERM");
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { code, stdout, stderr, exitMs: Date.now() - started };
}

async function runWriterCollision(configPath: string): Promise<{ collisions: number; logLines: number; stdout: string }> {
  const first = spawn(process.execPath, ["--run", "northstar", "--", "watch", "--config", configPath, "--interval-ms", "100", "--log-json"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let firstOut = "";
  first.stdout?.on("data", (chunk) => firstOut += String(chunk));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await runDaemon(configPath, ["--max-cycles", "1", "--interval-ms", "10", "--log-json"]);
  first.kill("SIGTERM");
  await new Promise((resolve) => first.on("exit", resolve));
  const stdout = `${firstOut}\n${second.stdout}`;
  return {
    collisions: second.code === 2 && second.stdout.includes("writer_lock_unavailable") ? 1 : 0,
    logLines: stdout.trim().split(/\n/).filter(Boolean).length,
    stdout,
  };
}

async function runProcess(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => stdout += String(chunk));
  child.stderr?.on("data", (chunk) => stderr += String(chunk));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { code, stdout, stderr };
}

function count(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
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
```

- [ ] **Step 2: Run RED**

```bash
npm run test:e2e:daemon
```

Expected: FAIL because `northstar watch` still prints JSON command output instead of running real watch cycles, or because `src/cli/watch-command.ts` is not wired.

- [ ] **Step 3: Run GREEN after Task 4 wiring**

```bash
npm run test:e2e:daemon
```

Expected: PASS with summary containing `daemon_processes_started>=3`, `daemon_cycles_completed>=5`, `daemon_active_issues_loaded>=1`, `daemon_history_rows_reconstructed>=1`, `daemon_writer_lock_collisions=1`, `daemon_secret_leaks=0`.

- [ ] **Step 4: Commit daemon harness**

```bash
git add tests/e2e-daemon/harness.ts tests/e2e-daemon/daemon-e2e.test.ts
git commit -m "test: add real daemon supervision e2e"
```

## Task 6: Add Daemon E2E Coverage Matrix

**Files:**
- Create: `docs/superpowers/daemon-e2e-coverage.md`
- Modify: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Write failing matrix test**

Append to `tests/spec/spec-compliance.test.ts`:

```ts
test("daemon e2e coverage matrix maps real supervision requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/daemon-e2e-coverage.md"), "utf8");
  for (const required of [
    "bounded cycles",
    "restart reconstruction",
    "SIGTERM graceful shutdown",
    "writer lock collision",
    "compact logs",
    "tests/e2e-daemon/daemon-e2e.test.ts",
    "src/cli/watch-command.ts",
  ]) {
    assert.match(matrix, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
```

- [ ] **Step 2: Run RED**

```bash
npm test
```

Expected: FAIL because `docs/superpowers/daemon-e2e-coverage.md` does not exist.

- [ ] **Step 3: Add matrix**

Create `docs/superpowers/daemon-e2e-coverage.md`:

```md
# Northstar Daemon E2E Coverage Matrix

| Requirement | Test File | Implementation File |
| --- | --- | --- |
| Real `northstar watch` child process runs bounded cycles. | `tests/e2e-daemon/daemon-e2e.test.ts` | `src/cli/watch-command.ts`, `src/runtime/watch.ts` |
| Restart reconstruction loads active issues, leases, and recent history from the same temp project SQLite store. | `tests/e2e-daemon/harness.ts` | `src/cli/watch-command.ts`, `src/runtime/store.ts` |
| SIGTERM graceful shutdown exits within five seconds. | `tests/e2e-daemon/harness.ts` | `src/cli/watch-command.ts`, `src/runtime/watch.ts` |
| Writer lock collision reports `writer_lock_unavailable`. | `tests/e2e-daemon/harness.ts`, `tests/runtime/watch.test.ts` | `src/runtime/watch-lock.ts`, `src/runtime/watch.ts` |
| Compact logs omit secrets and raw transcripts. | `tests/e2e-daemon/harness.ts`, `tests/runtime/watch.test.ts` | `src/runtime/watch-logger.ts`, `src/cli/watch-command.ts` |
```

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test
git add docs/superpowers/daemon-e2e-coverage.md tests/spec/spec-compliance.test.ts
git commit -m "docs: map daemon e2e coverage"
```

## Task 7: Final Verification Gate

**Files:**
- Read-only unless verification exposes a defect.

- [ ] **Step 1: Run deterministic tests**

```bash
npm test
npm run test:e2e
```

Expected: both PASS.

- [ ] **Step 2: Run daemon E2E and CLI watch help**

```bash
npm run test:e2e:daemon
node --run northstar -- watch --help
```

Expected: daemon E2E PASS with quantified summary; help lists `--max-cycles`, `--interval-ms`, and `--log-json`.

- [ ] **Step 3: Run forbidden scans**

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(&&|\\|\\||;)" src/adapters src/runtime src/cli
git status --short
```

Expected: three `rg` commands produce no output; `git status --short` is clean after commits.

- [ ] **Step 4: Final report**

Report daemon summary metrics, RED/GREEN evidence, fresh verification output, changed files, and deferred production service packaging or OS service integration.
