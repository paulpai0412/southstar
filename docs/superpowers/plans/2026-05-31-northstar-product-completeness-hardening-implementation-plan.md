# Northstar Product Completeness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Northstar from the Vocabulary UAT findings into a production-usable automation system with stale lock recovery, merge-conflict recovery, completed worktree cleanup, real Project viewer sync, real parallel live validation, and spec-to-issues operator flow.

**Architecture:** Implement V1 reliability and Project observability first, then V2 product UX and structured evidence. Keep `src/runtime/state-machine.ts` pure; put filesystem, GitHub, Git, SDK, and browser work behind adapters, orchestrator, CLI, skill scripts, and live E2E harnesses. Live tests remain separate from `npm test`, and production live tests must use real GitHub, real Project v2 fields, real SDK workers, real local worktrees, real PRs, real merges, and real browser evidence.

**Tech Stack:** TypeScript on Node 22, `node:test`, SQLite runtime store, GitHub REST and GraphQL Project v2 APIs, argv-array Git/process adapters, Codex/OpenCode SDK workers, Northstar local skill scripts, Playwright/browser E2E evidence, c8 coverage gates.

---

## File Structure

### V1 Reliability And Project Observability

- Modify `src/config/schema.ts`: add runtime lock/recovery settings and completed worktree cleanup policy.
- Modify `skills/northstar/templates/northstar.yaml`: render the new runtime and cleanup settings for consumer repos.
- Modify `src/runtime/watch-lock.ts`: structured lock JSON, heartbeat update, stale detection, safe reclaim, fresh-writer rejection, mismatch rejection.
- Modify `src/runtime/watch.ts`: call lease heartbeat once per completed cycle and return structured skip/reclaim metadata.
- Modify `src/cli/watch-command.ts`: pass project root, config path, stale threshold, and admin event writer into lock acquisition.
- Modify `src/runtime/store.ts`: expose compact admin history append for lock recovery and cleanup events when the caller has a store.
- Create `src/adapters/github/project-v2.ts`: GitHub Project v2 GraphQL field discovery and issue item field updates.
- Modify `src/adapters/github/observability.ts`: replace Project sync stub with real Project v2 sync and retryable projection failure events.
- Modify `src/orchestrator/cycle.ts`: sync `Northstar Lifecycle`, viewer-friendly `Status`, `PR URL`, `Merge SHA`, `Current Stage`, `Last Error`, `Retry Count`, and `Blocked By` at lifecycle transitions.
- Modify `src/adapters/github/software-dev-gateway.ts`: surface stable merge error codes from GitHub merge responses.
- Modify `src/orchestrator/software-dev-driver.ts`: convert merge conflict release failures into capped retryable recovery context, branch/PR reuse, verifier rerun, and quarantine after cap.
- Modify `src/adapters/git/software-dev-worktree.ts`: add safe completed-worktree archive/delete operations constrained to managed paths.
- Create `src/orchestrator/worktree-cleanup.ts`: post-completion cleanup effect planning, retryable cleanup failure history, and completed-state protection.
- Modify `tests/runtime/watch.test.ts` and create `tests/runtime/watch-lock.test.ts`: stale/fresh/mismatch lock coverage.
- Create `tests/adapters/github-project-v2.test.ts`: fake-fetch GraphQL Project v2 discovery/update coverage.
- Modify `tests/adapters/github-observability.test.ts`: real Project sync success/failure behavior with fake fetch.
- Modify `tests/orchestrator/error-recovery.test.ts`: merge conflict retry and cap coverage.
- Create `tests/orchestrator/worktree-cleanup.test.ts`: cleanup policy and completed-state protection.
- Create `tests/e2e-product-hardening-live/`: real V1 live gate for five issues, sequential/parallel execution, Project viewer sync, and browser evidence.
- Modify `package.json`: add `test:e2e:product-hardening-live`.

### V2 Product UX, Spec-To-Issues, Structured Evidence

- Create `skills/northstar/scripts/lib/spec-plan-intake.mjs`: parse Superpowers design specs and implementation plans into issue drafts, dependency graph, dry-run/apply plans.
- Create `skills/northstar/scripts/lib/setup-flow.mjs`: setup/preflight flow for `.northstar.yaml`, labels, Project fields, workflow, credentials, and browser/build command discovery.
- Modify `skills/northstar/scripts/lib/project-viewer.mjs`: include both exact lifecycle and viewer-friendly status fields/views; expose field creation plans that require confirmation.
- Modify `skills/northstar/scripts/lib/operator-commands.mjs`: add skill intents `setup`, `plan issues`, `run`, `status`, and `recover`.
- Modify `skills/northstar/SKILL.md`: document the new operator flow, confirmation gates, and recovery rules.
- Modify `src/runtime/artifacts.ts`: enforce the structured worker/verifier/release artifact contract, secret redaction, browser evidence requirement, and compact persisted summaries.
- Modify `src/intake/github.ts` and `src/orchestrator/dependencies.ts`: merge marker dependencies with native GitHub issue/tasklist/cross-reference dependencies and record retryable intake warnings.
- Modify `src/orchestrator/inspect.ts` and `src/runtime/inspect.ts`: include Project status, PR URL, merge SHA, current stage, heartbeat, leases, root sessions, child runs, retryable failures, cleanup backlog, and recovery suggestion.
- Create `tests/skills/northstar-spec-plan-intake.test.ts`: generated issues, dry-run/apply confirmation, graph cycles, Project preflight, secret checks.
- Create `tests/skills/northstar-setup-flow.test.ts`: setup/status/recover operator flow coverage.
- Modify `tests/runtime/artifacts.test.ts`: strict structured artifact contract and browser evidence coverage.
- Modify `tests/orchestrator/dependencies.test.ts`: native/marker merge, dedupe, and retryable API failure coverage.
- Modify `tests/orchestrator/inspect.test.ts`: inspect shape and field-count coverage.
- Create `tests/e2e-product-hardening-live/spec-to-issues-live.test.ts`: V2 live gate that creates issue drafts from a small spec/plan and applies after test-controlled confirmation.

## Guardrails For Every Task

- Do not modify `src/runtime/state-machine.ts` except for test-only imports that prove it remains pure; if behavior seems to require state-machine edits, stop and add a failing pure-state-machine test first.
- Do not add network, credentials, SDK, host CLI, or browser dependency to `npm test`.
- Do not hardcode `paulpai0412/northstar-live-sandbox`, Project #28, field ids, option ids, local usernames, or `/home/timmypai` in `src`.
- Do not persist secrets to repo files, generated issue bodies, GitHub Project fields, issue comments, PR comments, logs, worker prompts, or SQLite history.
- All external commands must be argv arrays through existing process/Git adapters.
- Live E2E must clear-skip without required live flags, and must fail with actionable missing-env output when the live flag is set but credentials/config are absent.

---

## V1 Tasks

### Task 1: Runtime Config For Lock Recovery And Cleanup Policy

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `skills/northstar/templates/northstar.yaml`
- Test: `tests/config/load-config.test.ts`
- Test: `tests/skills/northstar-config-renderer.test.ts`

- [ ] **Step 1: Write failing config tests**

Add these cases to `tests/config/load-config.test.ts`:

```ts
test("runtime config accepts watch lock recovery and cleanup policy", () => {
  const config = validateRuntimeConfig({
    schema_version: "1",
    project: { name: "demo", root: "/tmp/demo" },
    runtime: {
      db_path: ".northstar/runtime/northstar.sqlite",
      host_adapter: "codex",
      development_capacity: 2,
      release_capacity: 1,
      heartbeat_interval_seconds: 30,
      lease_timeout_seconds: 300,
      child_timeout_seconds: 900,
      watch_lock_stale_seconds: 120,
      max_recovery_attempts: 2,
      auto_release: true,
      session_scope: "stage_root",
    },
    workflow: { package: "builtin", id: "issue_to_pr_release", version: "1" },
    github: {
      repo: "owner/repo",
      intake: { enabled: true, label: "northstar:ready" },
      sync: { enabled: true, retry_backoff_seconds: [60, 300] },
    },
    git: {
      base_branch: "main",
      worktrees_dir: ".northstar/runtime/worktrees",
      sync_worktree_dir: ".northstar/runtime/sync-worktrees/main",
    },
    cleanup: {
      completed_worktrees: "archive",
      keep_last: 5,
      failed_or_quarantined: "keep",
    },
    policy: {
      github_sync_blocks_lifecycle: false,
      quarantine_requires_operator: true,
    },
  });

  assert.equal(config.runtime.watchLockStaleSeconds, 120);
  assert.equal(config.runtime.maxRecoveryAttempts, 2);
  assert.equal(config.cleanup.completedWorktrees, "archive");
  assert.equal(config.cleanup.keepLast, 5);
  assert.equal(config.cleanup.failedOrQuarantined, "keep");
});

test("cleanup policy rejects unsafe values", () => {
  assert.throws(() => validateRuntimeConfig(baseConfig({
    cleanup: { completed_worktrees: "wipe", keep_last: 5, failed_or_quarantined: "keep" },
  })), /cleanup.completed_worktrees must be archive, delete, or keep/);

  assert.throws(() => validateRuntimeConfig(baseConfig({
    cleanup: { completed_worktrees: "archive", keep_last: -1, failed_or_quarantined: "keep" },
  })), /cleanup.keep_last must be a non-negative integer/);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `node --disable-warning=ExperimentalWarning tests/config/load-config.test.ts`

Expected: FAIL with missing `watchLockStaleSeconds`, `maxRecoveryAttempts`, or `cleanup`.

- [ ] **Step 3: Implement config parsing**

In `src/config/schema.ts`:

```ts
export interface RuntimeConfig {
  runtime: {
    dbPath: string;
    hostAdapter: HostAdapterName;
    developmentCapacity: number;
    releaseCapacity: number;
    heartbeatIntervalSeconds: number;
    leaseTimeoutSeconds: number;
    childTimeoutSeconds: number;
    watchLockStaleSeconds: number;
    maxRecoveryAttempts: number;
    autoRelease: boolean;
    sessionScope: "stage_root";
  };
  cleanup: {
    completedWorktrees: "archive" | "delete" | "keep";
    keepLast: number;
    failedOrQuarantined: "keep" | "archive";
  };
}
```

Add required fields:

```ts
"runtime.watch_lock_stale_seconds",
"runtime.max_recovery_attempts",
"cleanup.completed_worktrees",
"cleanup.keep_last",
"cleanup.failed_or_quarantined",
```

Add parsing helpers:

```ts
function nonNegativeIntegerField(value: unknown, field: string): number {
  const fieldValue = getConfigValue(value, field);
  if (!Number.isInteger(fieldValue) || (fieldValue as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return fieldValue as number;
}

function enumField<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const fieldValue = stringField(value, field);
  if (!(allowed as readonly string[]).includes(fieldValue)) {
    throw new Error(`${field} must be ${allowed.slice(0, -1).join(", ")}, or ${allowed.at(-1)}`);
  }
  return fieldValue as T;
}
```

Populate returned config:

```ts
watchLockStaleSeconds: nonNegativeIntegerField(value, "runtime.watch_lock_stale_seconds"),
maxRecoveryAttempts: nonNegativeIntegerField(value, "runtime.max_recovery_attempts"),
cleanup: {
  completedWorktrees: enumField(value, "cleanup.completed_worktrees", ["archive", "delete", "keep"] as const),
  keepLast: nonNegativeIntegerField(value, "cleanup.keep_last"),
  failedOrQuarantined: enumField(value, "cleanup.failed_or_quarantined", ["keep", "archive"] as const),
},
```

- [ ] **Step 4: Update skill config template**

Add to `skills/northstar/templates/northstar.yaml`:

```yaml
runtime:
  watch_lock_stale_seconds: 120
  max_recovery_attempts: 2

cleanup:
  completed_worktrees: archive
  keep_last: 5
  failed_or_quarantined: keep
```

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/config/load-config.test.ts
node --disable-warning=ExperimentalWarning tests/skills/northstar-config-renderer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/config/schema.ts skills/northstar/templates/northstar.yaml tests/config/load-config.test.ts tests/skills/northstar-config-renderer.test.ts
git commit -m "feat: add runtime hardening config"
```

### Task 2: Structured Watch Lock With Heartbeat And Stale Reclaim

**Files:**
- Modify: `src/runtime/watch-lock.ts`
- Modify: `src/runtime/watch.ts`
- Modify: `src/cli/watch-command.ts`
- Modify: `src/runtime/store.ts`
- Create: `tests/runtime/watch-lock.test.ts`
- Modify: `tests/runtime/watch.test.ts`

- [ ] **Step 1: Write failing lock tests**

Create `tests/runtime/watch-lock.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { acquireFileWatchWriter } from "../../src/runtime/watch-lock.ts";

async function tmpRoot(name: string) {
  const root = join(tmpdir(), `northstar-lock-${name}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  return root;
}

test("structured watch lock writes heartbeat and releases lock", async () => {
  const root = await tmpRoot("structured");
  const lockPath = join(root, "watch.lock");
  const lease = await acquireFileWatchWriter({
    path: lockPath,
    projectRoot: root,
    configPath: join(root, ".northstar.yaml"),
    staleAfterSeconds: 120,
    now: () => "2026-05-31T01:00:00.000Z",
    isPidAlive: () => true,
  });
  assert.equal(lease.acquired, true);

  await lease.lease!.heartbeat("2026-05-31T01:00:30.000Z");
  const record = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(record.project_root, root);
  assert.equal(record.heartbeat_at, "2026-05-31T01:00:30.000Z");

  await lease.lease!.release();
  await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
  await rm(root, { recursive: true, force: true });
});

test("stale lock with dead pid is reclaimed and reports recovery metadata", async () => {
  const root = await tmpRoot("dead-pid");
  const lockPath = join(root, "watch.lock");
  await writeFile(lockPath, JSON.stringify({
    pid: 99999,
    started_at: "2026-05-31T00:00:00.000Z",
    heartbeat_at: "2026-05-31T00:00:00.000Z",
    project_root: root,
    config_path: join(root, ".northstar.yaml"),
    host: "test-host",
  }));

  const result = await acquireFileWatchWriter({
    path: lockPath,
    projectRoot: root,
    configPath: join(root, ".northstar.yaml"),
    staleAfterSeconds: 120,
    now: () => "2026-05-31T01:00:00.000Z",
    isPidAlive: () => false,
  });

  assert.equal(result.acquired, true);
  assert.equal(result.reclaimed, true);
  assert.equal(result.reason, "pid_not_running");
  await result.lease!.release();
  await rm(root, { recursive: true, force: true });
});

test("fresh lock is rejected without creating duplicate writer", async () => {
  const root = await tmpRoot("fresh");
  const lockPath = join(root, "watch.lock");
  await writeFile(lockPath, JSON.stringify({
    pid: 111,
    started_at: "2026-05-31T01:00:00.000Z",
    heartbeat_at: "2026-05-31T01:00:30.000Z",
    project_root: root,
    config_path: join(root, ".northstar.yaml"),
    host: "test-host",
  }));

  const result = await acquireFileWatchWriter({
    path: lockPath,
    projectRoot: root,
    configPath: join(root, ".northstar.yaml"),
    staleAfterSeconds: 120,
    now: () => "2026-05-31T01:01:00.000Z",
    isPidAlive: () => true,
  });

  assert.equal(result.acquired, false);
  assert.equal(result.reason, "fresh_writer_exists");
  await rm(root, { recursive: true, force: true });
});

test("project root mismatch rejects stale-looking lock", async () => {
  const root = await tmpRoot("mismatch");
  const lockPath = join(root, "watch.lock");
  await writeFile(lockPath, JSON.stringify({
    pid: 111,
    started_at: "2026-05-31T00:00:00.000Z",
    heartbeat_at: "2026-05-31T00:00:00.000Z",
    project_root: "/other/repo",
    config_path: "/other/repo/.northstar.yaml",
    host: "test-host",
  }));

  const result = await acquireFileWatchWriter({
    path: lockPath,
    projectRoot: root,
    configPath: join(root, ".northstar.yaml"),
    staleAfterSeconds: 120,
    now: () => "2026-05-31T01:00:00.000Z",
    isPidAlive: () => false,
  });

  assert.equal(result.acquired, false);
  assert.equal(result.reason, "project_mismatch");
  await rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Write failing watch heartbeat test**

Add to `tests/runtime/watch.test.ts`:

```ts
test("watch loop heartbeats writer lease after each completed cycle", async () => {
  const heartbeats: string[] = [];
  let tick = 0;
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 2,
    acquireWriter: async () => ({
      heartbeat: async (now) => heartbeats.push(now),
      release: async () => {},
    }),
    runCycle: async () => ({ activeIssues: 1, effectsStarted: 0 }),
    sleep: async () => {},
    shouldStop: () => false,
    now: () => `2026-05-31T01:00:0${tick++}.000Z`,
  });

  const result = await loop.run();

  assert.equal(result.cycles, 2);
  assert.deepEqual(heartbeats, [
    "2026-05-31T01:00:00.000Z",
    "2026-05-31T01:00:01.000Z",
  ]);
});
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/watch-lock.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/watch.test.ts
```

Expected: FAIL with signature mismatch on `acquireFileWatchWriter` and missing `heartbeat` support.

- [ ] **Step 4: Implement structured lock result**

Replace `src/runtime/watch-lock.ts` with an implementation that exports:

```ts
export interface WatchLockRecord {
  pid: number;
  started_at: string;
  heartbeat_at: string;
  project_root: string;
  config_path: string;
  host: string;
}

export type WatchLockAcquireReason =
  | "new_lock"
  | "pid_not_running"
  | "heartbeat_stale"
  | "fresh_writer_exists"
  | "project_mismatch"
  | "invalid_lock_reclaimed";

export interface FileWatchWriterLease {
  heartbeat(now?: string): Promise<void>;
  release(): Promise<void>;
}

export interface WatchLockAcquireResult {
  acquired: boolean;
  reclaimed: boolean;
  reason: WatchLockAcquireReason;
  previous?: WatchLockRecord;
  lease?: FileWatchWriterLease;
}
```

`acquireFileWatchWriter(input)` must:

- use `open(path, "wx")` for the first acquisition;
- parse existing JSON when `EEXIST`;
- reject root/config mismatches with `project_mismatch`;
- reclaim when `isPidAlive(pid)` is false;
- reclaim when `now - heartbeat_at > staleAfterSeconds`;
- reject fresh writers;
- write a new record atomically after reclaim;
- expose `heartbeat()` that rewrites the record with a new `heartbeat_at`;
- expose `release()` that closes the handle and removes the lock file.

- [ ] **Step 5: Update watch loop and command**

In `src/runtime/watch.ts`, add:

```ts
export interface WatchWriterLease {
  heartbeat?(now?: string): Promise<void>;
  release(): Promise<void>;
}

export interface WatchLoopOptions {
  now?: () => string;
}
```

After each successful `runCycle()`:

```ts
await writer.heartbeat?.((options.now ?? (() => new Date().toISOString()))());
```

In `src/cli/watch-command.ts`, call:

```ts
acquireFileWatchWriter({
  path: lockPath,
  projectRoot: config.project.root,
  configPath: resolve(options.configPath),
  staleAfterSeconds: config.runtime.watchLockStaleSeconds,
})
```

When `result.reclaimed === true`, write an admin history row through the runtime store with event type `admin_watch_lock_reclaimed` and compact fields `reason`, `old_pid`, `old_heartbeat_at`, and `new_pid`.

- [ ] **Step 6: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/watch-lock.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/watch.test.ts
node --disable-warning=ExperimentalWarning tests/cli/cli.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/runtime/watch-lock.ts src/runtime/watch.ts src/cli/watch-command.ts src/runtime/store.ts tests/runtime/watch-lock.test.ts tests/runtime/watch.test.ts tests/cli/cli.test.ts
git commit -m "feat: recover stale watch locks"
```

### Task 3: Real GitHub Project V2 Field Sync

**Files:**
- Create: `src/adapters/github/project-v2.ts`
- Modify: `src/adapters/github/observability.ts`
- Create: `tests/adapters/github-project-v2.test.ts`
- Modify: `tests/adapters/github-observability.test.ts`

- [ ] **Step 1: Write failing Project v2 tests**

Create `tests/adapters/github-project-v2.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubProjectV2Client, projectStatusForLifecycle } from "../../src/adapters/github/project-v2.ts";

test("maps runtime lifecycle to exact lifecycle and viewer status", () => {
  assert.deepEqual(projectStatusForLifecycle("ready"), {
    lifecycle: "ready",
    status: "Todo",
  });
  assert.deepEqual(projectStatusForLifecycle("running"), {
    lifecycle: "running",
    status: "In Progress",
  });
  assert.deepEqual(projectStatusForLifecycle("verifying"), {
    lifecycle: "verifying",
    status: "In Review",
  });
  assert.deepEqual(projectStatusForLifecycle("verified"), {
    lifecycle: "verified",
    status: "Ready to Release",
  });
  assert.deepEqual(projectStatusForLifecycle("release_pending"), {
    lifecycle: "release_pending",
    status: "Releasing",
  });
  assert.deepEqual(projectStatusForLifecycle("completed"), {
    lifecycle: "completed",
    status: "Done",
  });
  assert.deepEqual(projectStatusForLifecycle("failed"), {
    lifecycle: "failed",
    status: "Failed",
  });
  assert.deepEqual(projectStatusForLifecycle("quarantined"), {
    lifecycle: "quarantined",
    status: "Blocked",
  });
});

test("syncIssueFields discovers item, fields, options, and writes GraphQL mutations", async () => {
  const operations: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    operations.push(body);
    if (body.query.includes("ProjectIssueItem")) {
      return response({
        data: {
          repository: {
            issue: {
              id: "ISSUE_ID",
              projectItems: { nodes: [{ id: "ITEM_ID", project: { id: "PROJECT_ID" } }] },
            },
          },
        },
      });
    }
    if (body.query.includes("ProjectFieldDiscovery")) {
      return response({
        data: {
          node: {
            fields: {
              nodes: [
                { id: "LIFECYCLE_FIELD", name: "Northstar Lifecycle", options: [{ id: "L_COMPLETED", name: "completed" }] },
                { id: "STATUS_FIELD", name: "Status", options: [{ id: "S_DONE", name: "Done" }] },
                { id: "PR_FIELD", name: "PR URL", dataType: "TEXT" },
                { id: "MERGE_FIELD", name: "Merge SHA", dataType: "TEXT" },
              ],
            },
          },
        },
      });
    }
    return response({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_ID" } } } });
  };

  const client = new GitHubProjectV2Client({
    repo: "owner/repo",
    token: "ghp_SECRET",
    fetch: fetchImpl,
  });

  const result = await client.syncIssueFields({
    projectId: "PROJECT_ID",
    issueNumber: 7,
    lifecycleState: "completed",
    fields: {
      "PR URL": "https://github.com/owner/repo/pull/8",
      "Merge SHA": "abc123",
    },
  });

  assert.equal(result.github_project_items_synced, 1);
  assert.equal(result.github_project_status_done, 1);
  assert.equal(result.github_project_lifecycle_completed, 1);
  assert.equal(operations.some((operation) => operation.query.includes("updateProjectV2ItemFieldValue")), true);
  assert.equal(JSON.stringify(operations).includes("ghp_SECRET"), false);
});

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 2: Run test to verify RED**

Run: `node --disable-warning=ExperimentalWarning tests/adapters/github-project-v2.test.ts`

Expected: FAIL because `src/adapters/github/project-v2.ts` does not exist.

- [ ] **Step 3: Implement Project v2 client**

Create `src/adapters/github/project-v2.ts` with:

```ts
export const projectLifecycleStatusMap = {
  ready: "Todo",
  claimed: "In Progress",
  running: "In Progress",
  verifying: "In Review",
  verified: "Ready to Release",
  release_pending: "Releasing",
  completed: "Done",
  failed: "Failed",
  quarantined: "Blocked",
} as const;

export function projectStatusForLifecycle(lifecycleState: string) {
  return {
    lifecycle: lifecycleState,
    status: projectLifecycleStatusMap[lifecycleState as keyof typeof projectLifecycleStatusMap] ?? "Blocked",
  };
}
```

Implement `GitHubProjectV2Client.syncIssueFields(input)` that:

- queries `ProjectIssueItem` for `repository(owner,name).issue(number).projectItems`;
- verifies an item belongs to `projectId`;
- queries `ProjectFieldDiscovery` for Project v2 fields;
- discovers single-select option ids by option name;
- updates `Northstar Lifecycle` and `Status` as single-select fields;
- updates text fields including `PR URL`, `Merge SHA`, `Current Stage`, `Last Error`, `Retry Count`, and `Blocked By`;
- caches field discovery per `projectId` in the client instance;
- returns numeric metrics for synced fields and detected status.

- [ ] **Step 4: Wire observability adapter**

Modify `src/adapters/github/observability.ts`:

```ts
import { GitHubProjectV2Client } from "./project-v2.ts";
```

In `syncProjectFields`, when `projectId` exists:

```ts
const client = new GitHubProjectV2Client({
  repo: this.repo,
  token: this.token,
  fetch: this.fetchImpl,
});
return {
  type: "projection_result",
  projection_target: "github_project",
  status: "success",
  mutates_lifecycle: false,
  payload: await client.syncIssueFields({
    projectId: input.projectId,
    issueNumber: input.issueNumber,
    lifecycleState: input.lifecycleState,
    fields: input.fields ?? {},
  }),
};
```

On errors, return `projectionFailureEvent("github_project", ...)` with `mutates_lifecycle: false`.

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/github-project-v2.test.ts
node --disable-warning=ExperimentalWarning tests/adapters/github-observability.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/adapters/github/project-v2.ts src/adapters/github/observability.ts tests/adapters/github-project-v2.test.ts tests/adapters/github-observability.test.ts
git commit -m "feat: sync github project viewer fields"
```

### Task 4: Orchestrator Project Projection At Every Lifecycle Transition

**Files:**
- Modify: `src/orchestrator/cycle.ts`
- Modify: `src/orchestrator/metrics.ts`
- Modify: `tests/orchestrator/watch-orchestrator.test.ts`
- Modify: `tests/e2e-production-cli-watch/production-cli-watch-e2e.test.ts`

- [ ] **Step 1: Write failing projection lifecycle test**

Add to `tests/orchestrator/watch-orchestrator.test.ts`:

```ts
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { FakeDomainDriver } from "../../src/orchestrator/domain-driver.ts";
import { createProductionOrchestratorFromConfig } from "../../src/orchestrator/cycle.ts";

test("orchestrator syncs project lifecycle and viewer status at each production transition", async () => {
  const synced: Array<{ issueNumber: number; lifecycleState: string; fields: Record<string, string> }> = [];
  const orchestrator = createTestProductionOrchestrator({
    githubProject: { enabled: true, projectId: "PROJECT_ID" },
    observability: {
      syncProjectFields: async (input) => {
        synced.push(input);
        return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false, payload: input };
      },
    },
  });

  await orchestrator.intakeIssue({
    issueNumber: 101,
    title: "Project status sync",
    body: "Implement status sync",
    sourceUrl: "https://github.com/owner/repo/issues/101",
    labels: ["northstar:ready"],
  });
  await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
  await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
  await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

  assert.equal(synced.some((item) => item.lifecycleState === "ready" && item.fields.Status === "Todo"), true);
  assert.equal(synced.some((item) => item.lifecycleState === "running" && item.fields.Status === "In Progress"), true);
  assert.equal(synced.some((item) => item.lifecycleState === "verifying" && item.fields.Status === "In Review"), true);
  assert.equal(synced.some((item) => item.lifecycleState === "release_pending" && item.fields.Status === "Releasing"), true);
  assert.equal(synced.some((item) => item.lifecycleState === "completed" && item.fields.Status === "Done" && item.fields["Merge SHA"]), true);
});

function createTestProductionOrchestrator(input: {
  githubProject: { enabled: boolean; projectId: string };
  observability: { syncProjectFields(input: { issueNumber: number; lifecycleState: string; fields: Record<string, string> }): Promise<unknown> };
}) {
  const syncedObservability = {
    trySyncIssueProgress: async () => ({ status: "success", mutates_lifecycle: false }),
    syncPrProgress: async () => undefined,
    syncProjectFields: async (projection: { issueNumber: number; fields?: Record<string, string> }) => {
      const lifecycleState = String(projection.fields?.["Northstar Lifecycle"] ?? projection.fields?.lifecycle ?? "");
      return await input.observability.syncProjectFields({
        issueNumber: projection.issueNumber,
        lifecycleState,
        fields: projection.fields ?? {},
      });
    },
  };
  return createProductionOrchestratorFromConfig({
    config: productionConfig({ github: { project: input.githubProject } }),
    store: SqliteControlPlaneStore.open(":memory:"),
    host: new FakeHostAdapter(),
    domain: new FakeDomainDriver(),
    workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
    now: fixedClock(),
    observability: syncedObservability,
  });
}

function productionConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.1",
    project: { name: "test", root: "/tmp/northstar-project-sync-test" },
    runtime: {
      dbPath: ":memory:",
      hostAdapter: "codex",
      developmentCapacity: 1,
      releaseCapacity: 1,
      heartbeatIntervalSeconds: 30,
      leaseTimeoutSeconds: 300,
      childTimeoutSeconds: 900,
      watchLockStaleSeconds: 120,
      maxRecoveryAttempts: 2,
      autoRelease: true,
      sessionScope: "stage_root",
    },
    workflow: { package: "builtin", id: "issue_to_pr_release", version: "1.0", domain: "software_development" },
    github: {
      repo: "owner/repo",
      intake: { enabled: true, label: "northstar:ready" },
      sync: { enabled: true, retryBackoffSeconds: [60] },
      project: { enabled: true, projectId: "PROJECT_ID" },
    },
    git: {
      baseBranch: "main",
      worktreesDir: ".northstar/runtime/worktrees",
      syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    },
    cleanup: { completedWorktrees: "archive", keepLast: 5, failedOrQuarantined: "keep" },
    policy: { githubSyncBlocksLifecycle: false, quarantineRequiresOperator: true },
    ...overrides,
  };
}

function fixedClock() {
  let index = 0;
  return () => `2026-05-31T01:00:${String(index++).padStart(2, "0")}.000Z`;
}
```

- [ ] **Step 2: Run test to verify RED**

Run: `node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts`

Expected: FAIL because Project sync is not called for each lifecycle state or does not include `Status`/`Merge SHA`.

- [ ] **Step 3: Implement projection helper**

In `src/orchestrator/cycle.ts`, add a helper:

```ts
function projectFieldsForSnapshot(snapshot: IssueSnapshot, history: HistoryEntry[]): Record<string, string> {
  const context = snapshot.runtime_context_json;
  const pr = context.pr as { number?: number; url?: string; merge_sha?: string } | undefined;
  return {
    "Northstar Lifecycle": snapshot.lifecycle_state,
    "Status": projectStatusForLifecycle(snapshot.lifecycle_state).status,
    "PR URL": pr?.url ?? "",
    "Merge SHA": pr?.merge_sha ?? "",
    "Current Stage": String(context.current_stage ?? ""),
    "Last Error": compactLastError(history),
    "Retry Count": String(countRetryableFailures(history)),
    "Blocked By": formatBlockedBy(context.dependencies),
  };
}
```

Call `observability.syncProjectFields` after persisted transitions for intake, start, verification, verified, release pending, completed, failed, and quarantined states. Record failures as retryable projection history and never mutate lifecycle because of projection failure.

- [ ] **Step 4: Update metrics**

In `src/orchestrator/metrics.ts`, add counters:

```ts
github_project_items_synced: 0,
github_project_lifecycle_completed: 0,
github_project_status_done: 0,
github_project_pr_urls_synced: 0,
github_project_merge_shas_synced: 0,
github_project_status_mismatches: 0,
github_projection_failures_retryable: 0,
github_projection_failures_do_not_mutate_lifecycle: 1,
```

Increment from projection result payloads.

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts
node --disable-warning=ExperimentalWarning tests/e2e-production-cli-watch/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/orchestrator/cycle.ts src/orchestrator/metrics.ts tests/orchestrator/watch-orchestrator.test.ts tests/e2e-production-cli-watch/production-cli-watch-e2e.test.ts
git commit -m "feat: project runtime progress during orchestration"
```

### Task 5: Merge Conflict Auto-Recovery

**Files:**
- Modify: `src/adapters/github/software-dev-gateway.ts`
- Modify: `src/orchestrator/software-dev-driver.ts`
- Modify: `tests/adapters/github-software-dev-gateway.test.ts`
- Modify: `tests/orchestrator/software-dev-driver.test.ts`

- [ ] **Step 1: Write failing merge error classification test**

Add to `tests/adapters/github-software-dev-gateway.test.ts`:

```ts
test("software dev gateway classifies merge conflict with stable code", async () => {
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "token",
    fetch: async () => new Response(JSON.stringify({ message: "Merge conflict" }), { status: 409 }),
  });

  await assert.rejects(
    () => gateway.mergePullRequest({ number: 12, commit_title: "merge" }),
    (error) => {
      assert.equal((error as { code?: string }).code, "PR_MERGE_CONFLICT");
      return true;
    },
  );
});
```

- [ ] **Step 2: Write failing recovery test**

Add to `tests/orchestrator/software-dev-driver.test.ts`:

```ts
test("software-dev release recovers merge conflict and reuses existing PR", async () => {
  const metrics = emptyMetrics();
  const github = new MergeConflictThenSuccessGitHub();
  const calls = github.calls;
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-conflict",
    github,
    worker: new RecordingWorker(calls),
    host: new QueuedHostSessionBridge(),
    metrics,
    worktree: {
      prepareIssueWorktree: async () => ({ path: "/repo/.northstar/runtime/worktrees/issue-7-template-issue", branch: "northstar/issue-7-template-issue" }),
      commitAndPush: async () => {
        calls.push("commit-push");
        return { commit_sha: "recovery-sha" };
      },
    },
  });

  const prep = await driver.prepareStage(domainContext({}));
  const pr = await driver.finalizeWorkerArtifact({ ...domainContext({}), branch: prep.branch, changedFiles: ["fixture.json"] });
  const release = await driver.releaseVerifiedItem({ ...domainContext({}), releaseMetadata: { prNumber: pr.prNumber } });

  assert.equal(release.confirmed, true);
  assert.equal(release.mergeSha, "merge-sha-after-recovery");
  assert.equal(metrics.merge_conflicts_detected, 1);
  assert.equal(metrics.merge_conflict_recovery_attempts, 1);
  assert.equal(metrics.merge_conflict_recovered_prs_merged, 1);
  assert.equal(github.createdPrCount, 1);
  assert.equal(calls.filter((call) => call === "createOrReusePullRequest").length, 1);
});

test("software-dev merge conflict cap returns quarantine recovery result", async () => {
  const metrics = emptyMetrics({ maxRecoveryAttempts: 1 });
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "northstar-conflict-cap",
    github: new AlwaysConflictGitHub(),
    worker: new RecordingWorker(),
    host: new QueuedHostSessionBridge(),
    metrics,
  });

  await driver.prepareStage(domainContext({}));
  const pr = await driver.finalizeWorkerArtifact({ ...domainContext({}), branch: "northstar-conflict-cap-issue-7", changedFiles: ["fixture.json"] });
  await assert.rejects(
    () => driver.releaseVerifiedItem({ ...domainContext({}), releaseMetadata: { prNumber: pr.prNumber } }),
    /merge conflict recovery cap exceeded/,
  );

  assert.equal(metrics.merge_conflict_recovery_attempts, 1);
});

class MergeConflictThenSuccessGitHub extends RecordingGitHub {
  private releaseAttempts = 0;

  async createOrReusePullRequest(input: { title: string; head: string; base: string; body: string }) {
    this.calls.push("createOrReusePullRequest");
    this.createdPrCount += this.createdPrCount === 0 ? 1 : 0;
    return { number: 17, html_url: "https://github.test/pull/17", reused: false };
  }

  async mergePullRequest() {
    this.releaseAttempts += 1;
    if (this.releaseAttempts === 1) {
      throw Object.assign(new Error("Merge conflict"), { code: "PR_MERGE_CONFLICT" });
    }
    return { merged: true, sha: "merge-sha-after-recovery" };
  }
}

class AlwaysConflictGitHub extends RecordingGitHub {
  async mergePullRequest() {
    throw Object.assign(new Error("Merge conflict"), { code: "PR_MERGE_CONFLICT" });
  }
}

// Replace the existing emptyMetrics helper in this test file with this version.
function emptyMetrics(overrides: Record<string, unknown> = {}) {
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
    maxRecoveryAttempts: 2,
    ...overrides,
  };
}
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/github-software-dev-gateway.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-driver.test.ts
```

Expected: FAIL because stable error codes and recovery harness behavior are absent.

- [ ] **Step 4: Implement stable merge errors**

In `src/adapters/github/software-dev-gateway.ts`, add:

```ts
export type PullRequestMergeErrorCode =
  | "PR_MERGE_CONFLICT"
  | "PR_NOT_MERGEABLE_YET"
  | "PR_MERGE_PERMISSION_DENIED"
  | "PR_MERGE_UNKNOWN_FAILURE";

export class PullRequestMergeError extends Error {
  constructor(readonly code: PullRequestMergeErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = "PullRequestMergeError";
  }
}
```

Map GitHub responses:

- HTTP 409 -> `PR_MERGE_CONFLICT`
- HTTP 405 with not mergeable text -> `PR_NOT_MERGEABLE_YET`
- HTTP 403 -> `PR_MERGE_PERMISSION_DENIED`
- any other non-2xx -> `PR_MERGE_UNKNOWN_FAILURE`

- [ ] **Step 5: Implement retryable recovery in software driver**

In `src/orchestrator/software-dev-driver.ts`:

- On `PR_MERGE_CONFLICT`, record retryable recovery history and increment `runtime_context_json.recovery_attempts.merge_conflict`.
- Fetch/reuse latest base through existing worktree preparation.
- Re-run implementation worker with prompt section:

```text
Recovery context:
- Previous PR had merge conflict.
- Rebase or update the existing issue branch against the latest base branch.
- Preserve the source issue acceptance criteria.
- Do not create a second PR.
```

- Commit/push to the same branch.
- Reuse the existing PR via `createOrReusePullRequest`.
- Re-run verifier before the next release attempt.
- If `attempt > config.runtime.maxRecoveryAttempts`, return a quarantine result with action text.

- [ ] **Step 6: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/github-software-dev-gateway.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-driver.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/adapters/github/software-dev-gateway.ts src/orchestrator/software-dev-driver.ts tests/adapters/github-software-dev-gateway.test.ts tests/orchestrator/software-dev-driver.test.ts
git commit -m "feat: recover merge conflicts without duplicate prs"
```

### Task 6: Completed Worktree Cleanup Policy

**Files:**
- Modify: `src/adapters/git/software-dev-worktree.ts`
- Create: `src/orchestrator/worktree-cleanup.ts`
- Create: `tests/orchestrator/worktree-cleanup.test.ts`
- Modify: `tests/adapters/git-software-dev-worktree.test.ts`

- [ ] **Step 1: Write failing cleanup tests**

Create `tests/orchestrator/worktree-cleanup.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { planCompletedWorktreeCleanup } from "../../src/orchestrator/worktree-cleanup.ts";

test("archives completed managed worktree without reversing completed lifecycle", () => {
  const result = planCompletedWorktreeCleanup({
    lifecycleState: "completed",
    issueId: "issue-10",
    worktreePath: "/repo/.northstar/runtime/worktrees/issue-10",
    managedWorktreesDir: "/repo/.northstar/runtime/worktrees",
    archiveDir: "/repo/.northstar/runtime/archive/worktrees",
    policy: { completedWorktrees: "archive", keepLast: 5, failedOrQuarantined: "keep" },
    now: "2026-05-31T01:00:00.000Z",
  });

  assert.equal(result.action, "archive");
  assert.match(result.destination, /issue-10-2026-05-31T01-00-00-000Z$/);
  assert.equal(result.lifecycle_state_after_cleanup, "completed");
});

test("cleanup rejects paths outside managed worktrees", () => {
  assert.throws(() => planCompletedWorktreeCleanup({
    lifecycleState: "completed",
    issueId: "issue-10",
    worktreePath: "/repo",
    managedWorktreesDir: "/repo/.northstar/runtime/worktrees",
    archiveDir: "/repo/.northstar/runtime/archive/worktrees",
    policy: { completedWorktrees: "delete", keepLast: 5, failedOrQuarantined: "keep" },
    now: "2026-05-31T01:00:00.000Z",
  }), /WORKTREE_CLEANUP_UNMANAGED_PATH/);
});

test("cleanup failure is retryable history and keeps completed lifecycle", () => {
  const failure = planCompletedWorktreeCleanup({
    lifecycleState: "completed",
    issueId: "issue-11",
    worktreePath: "/repo/.northstar/runtime/worktrees/issue-11",
    managedWorktreesDir: "/repo/.northstar/runtime/worktrees",
    archiveDir: "/repo/.northstar/runtime/archive/worktrees",
    policy: { completedWorktrees: "keep", keepLast: 5, failedOrQuarantined: "keep" },
    now: "2026-05-31T01:00:00.000Z",
  });

  assert.equal(failure.action, "keep");
  assert.equal(failure.history.event_type, "cleanup_skipped");
  assert.equal(failure.lifecycle_state_after_cleanup, "completed");
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `node --disable-warning=ExperimentalWarning tests/orchestrator/worktree-cleanup.test.ts`

Expected: FAIL because `worktree-cleanup.ts` does not exist.

- [ ] **Step 3: Implement cleanup planning**

Create `src/orchestrator/worktree-cleanup.ts`:

```ts
export class WorktreeCleanupError extends Error {
  constructor(readonly code: "WORKTREE_CLEANUP_UNMANAGED_PATH", message: string) {
    super(`${code}: ${message}`);
    this.name = "WorktreeCleanupError";
  }
}
```

Export `planCompletedWorktreeCleanup(input)` that:

- returns `keep` when policy is `keep`;
- rejects non-completed lifecycle states;
- verifies `worktreePath` is under `managedWorktreesDir`;
- plans archive destination under `.northstar/runtime/archive/worktrees/<issue-id>-<timestamp>`;
- returns compact history events `cleanup_planned`, `cleanup_skipped`, or `cleanup_failed_retryable`;
- always returns `lifecycle_state_after_cleanup: "completed"` for completed issues.

- [ ] **Step 4: Add adapter operation tests and implementation**

In `tests/adapters/git-software-dev-worktree.test.ts`, add tests proving:

```ts
assert.equal(metrics.completed_worktree_cleanup_attempts >= 1, true);
assert.equal(metrics.completed_worktrees_archived_or_deleted >= 1, true);
assert.equal(metrics.cleanup_failures_retryable >= 1, true);
assert.equal(metrics.cleanup_completed_reversals, 0);
```

Implement `archiveManagedWorktree` and `deleteManagedWorktree` in `src/adapters/git/software-dev-worktree.ts` using `rename` and `rm` only after managed path validation.

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/worktree-cleanup.test.ts
node --disable-warning=ExperimentalWarning tests/adapters/git-software-dev-worktree.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/orchestrator/worktree-cleanup.ts src/adapters/git/software-dev-worktree.ts tests/orchestrator/worktree-cleanup.test.ts tests/adapters/git-software-dev-worktree.test.ts
git commit -m "feat: cleanup completed worktrees safely"
```

### Task 7: V1 Live Product Hardening E2E Gate

**Files:**
- Create: `tests/e2e-product-hardening-live/index.test.ts`
- Create: `tests/e2e-product-hardening-live/env.ts`
- Create: `tests/e2e-product-hardening-live/harness.ts`
- Create: `tests/e2e-product-hardening-live/metrics.ts`
- Create: `tests/e2e-product-hardening-live/browser-evidence.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add package script**

In `package.json` scripts:

```json
"test:e2e:product-hardening-live": "node --disable-warning=ExperimentalWarning tests/e2e-product-hardening-live/index.test.ts"
```

- [ ] **Step 2: Write clear-skip env test**

Create `tests/e2e-product-hardening-live/index.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { runProductHardeningLiveE2E } from "./harness.ts";

test("product hardening live E2E clear-skips without live flag", (t) => {
  if (process.env.NORTHSTAR_PRODUCT_HARDENING_LIVE !== "1") {
    t.skip("Set NORTHSTAR_PRODUCT_HARDENING_LIVE=1 with GitHub repo, Project id, and SDK credentials to run product hardening live E2E.");
    return;
  }

  for (const key of ["GITHUB_TOKEN", "NORTHSTAR_LIVE_GITHUB_REPO", "NORTHSTAR_LIVE_GITHUB_PROJECT_ID"]) {
    assert.ok(process.env[key], `${key} is required`);
  }
});

test("product hardening live E2E verifies sequential, parallel, Project, and browser evidence", async (t) => {
  if (process.env.NORTHSTAR_PRODUCT_HARDENING_LIVE !== "1") {
    t.skip("Set NORTHSTAR_PRODUCT_HARDENING_LIVE=1 to run product hardening live E2E.");
    return;
  }

  const result = await runProductHardeningLiveE2E({
    repo: process.env.NORTHSTAR_LIVE_GITHUB_REPO!,
    projectId: process.env.NORTHSTAR_LIVE_GITHUB_PROJECT_ID!,
    token: process.env.GITHUB_TOKEN!,
  });

  t.diagnostic(JSON.stringify(result.metrics, null, 2));
  t.diagnostic(`issues=${result.issueUrls.join(",")}`);
  t.diagnostic(`prs=${result.prUrls.join(",")}`);
  t.diagnostic(`browser_evidence=${result.browserEvidencePath}`);

  assert.equal(result.metrics.live_issues_created >= 5, true);
  assert.equal(result.metrics.live_completed_issues >= 5, true);
  assert.equal(result.metrics.live_prs_merged >= 5, true);
  assert.equal(result.metrics.live_project_lifecycle_completed >= 5, true);
  assert.equal(result.metrics.live_project_status_done >= 5, true);
  assert.equal(result.metrics.live_parallel_active_issue_workers >= 2, true);
  assert.equal(result.metrics.parallel_overlap_seconds >= 1, true);
  assert.equal(result.metrics.dependency_order_violations, 0);
  assert.equal(result.metrics.github_project_status_mismatches, 0);
  assert.equal(result.metrics.live_browser_tests_passed >= 1, true);
  assert.equal(result.metrics.live_secret_leaks, 0);
  assert.equal(result.metrics.live_smoke_only, 0);
  assert.equal(result.metrics.fake_production_path_used, 0);
});
```

- [ ] **Step 3: Run clear-skip test**

Run: `npm run test:e2e:product-hardening-live`

Expected: PASS with skip diagnostics when `NORTHSTAR_PRODUCT_HARDENING_LIVE` is unset.

- [ ] **Step 4: Implement live harness**

Create `tests/e2e-product-hardening-live/harness.ts` that:

- creates five real GitHub issues in the configured repo;
- labels them `northstar:ready`;
- adds them to the configured Project;
- encodes dependency graph `A -> B`, `A -> C`, `B+C -> D`, `D -> E`;
- writes consumer `.northstar.yaml` with `runtime.development_capacity: 2`, Project sync enabled, and `cleanup.completed_worktrees: archive`;
- runs production `northstar watch --max-cycles` through the packaged CLI with `cwd` at the temporary consumer repo;
- verifies B and C overlap by at least one second using runtime history timestamps;
- verifies Project `Northstar Lifecycle` and `Status` fields via GraphQL;
- verifies PR URL and merge SHA fields via GraphQL;
- runs browser tests against the final consumer web app and writes screenshot/evidence under `.northstar/runtime/evidence/product-hardening-live`;
- closes or labels failed test issues in cleanup, preserving issue URLs for diagnostics.

- [ ] **Step 5: Run V1 live gate**

Run:

```bash
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_PRODUCT_HARDENING_LIVE=1 \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox \
NORTHSTAR_LIVE_GITHUB_PROJECT_ID="$NORTHSTAR_LIVE_GITHUB_PROJECT_ID" \
npm run test:e2e:product-hardening-live
```

Expected: PASS with metrics:

```text
live_issues_created >= 5
live_completed_issues >= 5
live_prs_merged >= 5
live_project_lifecycle_completed >= 5
live_project_status_done >= 5
live_parallel_active_issue_workers >= 2
github_project_status_mismatches = 0
live_browser_tests_passed >= 1
live_smoke_only = 0
fake_production_path_used = 0
```

- [ ] **Step 6: Commit**

Run:

```bash
git add package.json tests/e2e-product-hardening-live
git commit -m "test: add product hardening live e2e gate"
```

---

## V2 Tasks

### Task 8: Spec-To-Issues Skill Intake

**Files:**
- Create: `skills/northstar/scripts/lib/spec-plan-intake.mjs`
- Modify: `skills/northstar/SKILL.md`
- Create: `tests/skills/northstar-spec-plan-intake.test.ts`

- [ ] **Step 1: Write failing skill intake tests**

Create `tests/skills/northstar-spec-plan-intake.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const modulePath = "../../skills/northstar/scripts/lib/spec-plan-intake.mjs";

test("spec and plan generate executable issue drafts with metrics and dependencies", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(modulePath);
  const result = generateIssueDraftsFromSpecPlan({
    specText: "# Design\n\n## Goals\n- Build V1\n\n## Acceptance metrics\n- `live_completed_issues >= 5`",
    planText: "# Plan\n\n### Task 1: Foundation\n\n### Task 2: Parallel Feature\nDepends-On: #1\n\n### Task 3: Browser UAT\nDepends-On: #2",
    specPath: "docs/superpowers/specs/demo.md",
    planPath: "docs/superpowers/plans/demo.md",
    repo: "owner/repo",
    projectId: "PROJECT_ID",
    mode: "dry-run",
  });

  assert.equal(result.metrics.spec_plan_inputs_validated, 1);
  assert.equal(result.metrics.issues_generated_from_plan, 3);
  assert.equal(result.metrics.issue_acceptance_criteria_present, 1);
  assert.equal(result.metrics.issue_quantitative_metrics_present, 1);
  assert.equal(result.metrics.dependency_graph_edges >= 2, true);
  assert.equal(result.metrics.dependency_graph_cycles, 0);
  assert.equal(result.metrics.dry_run_requires_no_github_mutation, 1);
  assert.equal(result.metrics.secret_leaks_in_generated_issues, 0);
  assert.match(result.issues[0].body, /## Objective/);
  assert.match(result.issues[0].body, /## Quantitative Metrics/);
  assert.match(result.issues[1].body, /Depends-On:/);
});

test("apply mode requires explicit confirmation", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(modulePath);
  assert.throws(() => generateIssueDraftsFromSpecPlan({
    specText: "# Design",
    planText: "### Task 1: Apply",
    specPath: "spec.md",
    planPath: "plan.md",
    repo: "owner/repo",
    mode: "apply",
    confirmed: false,
  }), /NORTHSTAR_SPEC_PLAN_APPLY_REQUIRES_CONFIRMATION/);
});

test("dependency cycles are rejected before apply", async () => {
  const { generateIssueDraftsFromSpecPlan } = await import(modulePath);
  assert.throws(() => generateIssueDraftsFromSpecPlan({
    specText: "# Design",
    planText: "### Task 1: A\nDepends-On: #2\n\n### Task 2: B\nDepends-On: #1",
    specPath: "spec.md",
    planPath: "plan.md",
    repo: "owner/repo",
    mode: "dry-run",
  }), /NORTHSTAR_SPEC_PLAN_DEPENDENCY_CYCLE/);
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `node --disable-warning=ExperimentalWarning tests/skills/northstar-spec-plan-intake.test.ts`

Expected: FAIL because module is missing.

- [ ] **Step 3: Implement generator**

Create `skills/northstar/scripts/lib/spec-plan-intake.mjs` exporting:

```js
export function generateIssueDraftsFromSpecPlan(input) {
  validateInput(input);
  const tasks = parsePlanTasks(input.planText);
  const graph = buildDependencyGraph(tasks);
  assertAcyclic(graph);
  const issues = tasks.map((task, index) => issueDraftForTask({ task, index, input, graph }));
  const leaked = issues.some((issue) => containsSecret(issue.title) || containsSecret(issue.body));
  if (leaked) throw newSpecPlanError("NORTHSTAR_SPEC_PLAN_SECRET_LEAK");
  return {
    canMutate: input.mode === "apply" && input.confirmed === true,
    issues,
    graph,
    metrics: {
      spec_plan_inputs_validated: 1,
      issues_generated_from_plan: issues.length,
      issue_acceptance_criteria_present: Number(issues.every((issue) => issue.body.includes("## Acceptance Criteria"))),
      issue_quantitative_metrics_present: Number(issues.every((issue) => issue.body.includes("## Quantitative Metrics"))),
      dependency_graph_edges: graph.edges.length,
      dependency_graph_cycles: 0,
      dry_run_requires_no_github_mutation: input.mode === "dry-run" ? 1 : 0,
      apply_requires_confirmation: input.mode === "apply" ? 1 : 0,
      preflight_missing_project_fields_detected: input.projectId ? 0 : 1,
      secret_leaks_in_generated_issues: 0,
    },
  };
}
```

Use the issue body template from the design exactly:

```md
## Objective

## Source Documents
- Spec:
- Implementation Plan:

## Scope

## Acceptance Criteria

## Quantitative Metrics

## Required Tests

## Dependencies
Depends-On: #...

## Northstar Execution Notes
- domain: software_development
- expected driver: software-dev
- requires live GitHub: yes/no
- requires browser evidence: yes/no
```

- [ ] **Step 4: Document skill intent**

In `skills/northstar/SKILL.md`, add `plan issues` to natural language intents and state:

```md
When the user asks to turn a Superpowers design spec and writing-plans plan into GitHub issues, run `generateIssueDraftsFromSpecPlan` in dry-run mode first, show issue titles and dependency graph, and ask for confirmation before apply mode.
```

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/northstar-spec-plan-intake.test.ts
node --disable-warning=ExperimentalWarning tests/skills/northstar-skill-files.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add skills/northstar/scripts/lib/spec-plan-intake.mjs skills/northstar/SKILL.md tests/skills/northstar-spec-plan-intake.test.ts
git commit -m "feat: generate northstar issues from specs and plans"
```

### Task 9: Consumer Setup, Status, And Recovery Skill Flow

**Files:**
- Create: `skills/northstar/scripts/lib/setup-flow.mjs`
- Modify: `skills/northstar/scripts/lib/operator-commands.mjs`
- Modify: `skills/northstar/scripts/lib/project-viewer.mjs`
- Modify: `skills/northstar/SKILL.md`
- Create: `tests/skills/northstar-setup-flow.test.ts`
- Modify: `tests/skills/northstar-project-viewer.test.ts`
- Modify: `tests/skills/northstar-operator-commands.test.ts`

- [ ] **Step 1: Write failing setup flow tests**

Create `tests/skills/northstar-setup-flow.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const setupModule = "../../skills/northstar/scripts/lib/setup-flow.mjs";

test("setup flow creates config draft and requires project confirmation", async () => {
  const { setupPlan } = await import(setupModule);
  const result = setupPlan({
    gitRoot: "/consumer/app",
    githubRepo: "owner/app",
    defaultBranch: "main",
    projectMode: "create_new",
    confirmedProjectMutation: false,
  });

  assert.equal(result.metrics.skill_setup_creates_config, 1);
  assert.equal(result.metrics.skill_project_create_requires_confirmation, 1);
  assert.equal(result.canWriteConfig, false);
  assert.equal(result.canMutateProject, false);
  assert.match(result.configDraft, /github:\n  repo: owner\/app/);
});

test("status flow reads runtime and github summary fields", async () => {
  const { statusSummary } = await import(setupModule);
  const summary = statusSummary({
    runtime: { activeIssues: 2, quarantinedIssues: 1, staleLocks: 1 },
    github: { openReadyIssues: 3, prsOpen: 2, projectStatusMismatches: 0 },
  });

  assert.equal(summary.metrics.skill_status_reads_runtime_and_github, 1);
  assert.match(summary.markdown, /Active issues: 2/);
  assert.match(summary.markdown, /Project status mismatches: 0/);
});

test("recover flow detects stale lock and requires confirmation for mutation", async () => {
  const { recoverPlan } = await import(setupModule);
  const plan = recoverPlan({
    staleLock: { path: "/consumer/app/.northstar/runtime/watch.lock", pid: 123, heartbeatAgeSeconds: 900 },
    confirmed: false,
  });

  assert.equal(plan.metrics.skill_recover_detects_stale_lock, 1);
  assert.equal(plan.canMutate, false);
  assert.match(plan.commands[0].description, /stale watch lock/);
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `node --disable-warning=ExperimentalWarning tests/skills/northstar-setup-flow.test.ts`

Expected: FAIL because `setup-flow.mjs` is missing.

- [ ] **Step 3: Implement setup-flow module**

Create `skills/northstar/scripts/lib/setup-flow.mjs` with:

- `setupPlan(input)` returning config draft, label plan, Project plan, doctor commands, and mutation flags;
- `statusSummary(input)` returning runtime/GitHub/Project markdown and metrics;
- `recoverPlan(input)` returning stale lock, merge conflict, failed/quarantined, stale branch/PR, and projection failure recovery options.

All medium/high-risk recovery actions must set `canMutate: false` unless `confirmed === true`.

- [ ] **Step 4: Update project viewer fields**

In `skills/northstar/scripts/lib/project-viewer.mjs`, ensure fields include:

```js
{ name: "Northstar Lifecycle", type: "single_select", options: ["ready", "running", "verifying", "verified", "release_pending", "completed", "failed", "quarantined"] },
{ name: "Status", type: "single_select", options: ["Todo", "In Progress", "In Review", "Ready to Release", "Releasing", "Done", "Failed", "Blocked"] },
{ name: "PR URL", type: "text" },
{ name: "Merge SHA", type: "text" },
{ name: "Current Stage", type: "text" },
{ name: "Last Error", type: "text" },
{ name: "Retry Count", type: "number" },
{ name: "Blocked By", type: "text" },
```

Add views:

- `Northstar Board` grouped by `Status`;
- `Active Runs` filtered to `Status:In Progress,In Review,Ready to Release,Releasing`;
- `Blocked Recovery` filtered to `Status:Blocked,Failed`;
- `Release Evidence` showing `PR URL` and `Merge SHA`.

- [ ] **Step 5: Add operator intents**

In `skills/northstar/scripts/lib/operator-commands.mjs`, extend `supportedOperatorIntents` with:

```js
["setup", "plan issues", "run", "status", "recover"]
```

Map:

- `run` to `["node", "--run", "northstar", "--", "watch", "--config", configPath]`;
- `status` to `["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"]`;
- `recover` to `["node", "--run", "northstar", "--", "repair-runtime", "--config", configPath]`.

- [ ] **Step 6: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/skills/northstar-setup-flow.test.ts
node --disable-warning=ExperimentalWarning tests/skills/northstar-project-viewer.test.ts
node --disable-warning=ExperimentalWarning tests/skills/northstar-operator-commands.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add skills/northstar/scripts/lib/setup-flow.mjs skills/northstar/scripts/lib/operator-commands.mjs skills/northstar/scripts/lib/project-viewer.mjs skills/northstar/SKILL.md tests/skills/northstar-setup-flow.test.ts tests/skills/northstar-project-viewer.test.ts tests/skills/northstar-operator-commands.test.ts
git commit -m "feat: add northstar setup status and recovery skill flow"
```

### Task 10: Structured Artifact Contract And Browser Evidence Requirement

**Files:**
- Modify: `src/runtime/artifacts.ts`
- Modify: `tests/runtime/artifacts.test.ts`
- Modify: `src/orchestrator/software-dev-driver.ts`
- Modify: `tests/orchestrator/software-dev-driver.test.ts`

- [ ] **Step 1: Write failing artifact contract tests**

Add to `tests/runtime/artifacts.test.ts`:

```ts
test("worker_result accepts structured command summaries and rejects secret-shaped values", () => {
  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "worker_result",
    branch: "northstar/issue-35",
    base_branch: "main",
    commit_sha: "abc123",
    changed_files: ["src/App.tsx"],
    commands_run: [{ command: "npm test", status: "passed" }],
    test_summary: { passed: 18, failed: 0 },
    risks: [],
    next_action: "ready_for_verification",
    recovery_hint: null,
    self_check_summary: "npm test passed",
  });

  assert.equal(artifact.payload.commands_run[0].status, "passed");

  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "worker_result",
    branch: "b",
    base_branch: "main",
    commit_sha: "c",
    changed_files: ["src/App.tsx"],
    commands_run: [{ command: "echo github_pat_abc123456789", status: "passed" }],
    test_summary: { passed: 1, failed: 0 },
    risks: [],
    next_action: "ready_for_verification",
    recovery_hint: null,
    self_check_summary: "ok",
  }), /ARTIFACT_SECRET_VALUE/);
});

test("evidence_packet requires browser evidence when browser acceptance is required", () => {
  assert.throws(() => validateArtifactPayload({
    ...common,
    artifact_kind: "evidence_packet",
    role: "pr_verifier",
    status: "pass",
    pr_number: 42,
    base_branch: "main",
    gate_results: [{ name: "npm test", status: "pass" }],
    verifier: { session_id: "verifier-1" },
    browser_required: true,
  }), /ARTIFACT_BROWSER_EVIDENCE_REQUIRED/);

  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "evidence_packet",
    role: "pr_verifier",
    status: "pass",
    pr_number: 42,
    base_branch: "main",
    gate_results: [{ name: "npm test", status: "pass" }],
    verifier: { session_id: "verifier-1" },
    browser_required: true,
    browser_evidence: { ran: true, tests_passed: 12, screenshots: ["evidence/mobile.png"] },
  });

  assert.equal(artifact.payload.browser_evidence.tests_passed, 12);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `node --disable-warning=ExperimentalWarning tests/runtime/artifacts.test.ts`

Expected: FAIL with missing error codes or missing browser evidence enforcement.

- [ ] **Step 3: Implement artifact validation**

In `src/runtime/artifacts.ts`:

- add error codes `ARTIFACT_SECRET_VALUE` and `ARTIFACT_BROWSER_EVIDENCE_REQUIRED`;
- recursively scan string values with `redactSecrets(value) !== value` and reject;
- require `commands_run` array and `test_summary` object for successful `worker_result`;
- require `browser_evidence.ran === true` and `browser_evidence.tests_passed > 0` when `browser_required === true`;
- keep raw log rejection and compact summary limits.

- [ ] **Step 4: Require verifier evidence in software driver**

In `src/orchestrator/software-dev-driver.ts`, when an issue body or runtime context contains browser acceptance markers, pass `browser_required: true` into verifier artifact validation before release.

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/artifacts.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-driver.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/runtime/artifacts.ts src/orchestrator/software-dev-driver.ts tests/runtime/artifacts.test.ts tests/orchestrator/software-dev-driver.test.ts
git commit -m "feat: enforce structured northstar artifacts"
```

### Task 11: Native Dependency Discovery And Retryable Intake Warnings

**Files:**
- Modify: `src/intake/github.ts`
- Modify: `src/orchestrator/dependencies.ts`
- Modify: `tests/intake/intake.test.ts`
- Modify: `tests/orchestrator/dependencies.test.ts`

- [ ] **Step 1: Write failing dependency merge tests**

Add to `tests/orchestrator/dependencies.test.ts`:

```ts
test("dependency discovery merges marker and native dependencies with source evidence", () => {
  const result = mergeDependencySources({
    markers: [{ issue: 2, source: "Depends-On" }, { issue: 3, source: "Blocked-By" }],
    native: [{ issue: 2, source: "tasklist" }, { issue: 4, source: "linked_issue" }],
  });

  assert.deepEqual(result.dependencies.map((item) => item.issue).sort(), [2, 3, 4]);
  assert.equal(result.metrics.native_dependencies_discovered, 2);
  assert.equal(result.metrics.marker_dependencies_merged, 2);
  assert.equal(result.metrics.dependency_duplicates_removed, 1);
  assert.equal(result.dependencies.find((item) => item.issue === 2)?.sources.length, 2);
});

test("native dependency API failure records retryable warning without lifecycle failure", () => {
  const warning = nativeDependencyFailureWarning({
    issueNumber: 10,
    message: "GraphQL permission denied",
    nextRetryAt: "2026-05-31T02:00:00.000Z",
  });

  assert.equal(warning.event_type, "intake_warning_retryable");
  assert.equal(warning.payload.native_dependency_api_failure_retryable, 1);
  assert.equal(warning.payload.native_dependency_api_failure_lifecycle_failures, 0);
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `node --disable-warning=ExperimentalWarning tests/orchestrator/dependencies.test.ts`

Expected: FAIL with missing `mergeDependencySources` or warning helper.

- [ ] **Step 3: Implement dependency helpers**

In `src/orchestrator/dependencies.ts`, export:

```ts
export function mergeDependencySources(input: {
  markers: Array<{ issue: number; source: string }>;
  native: Array<{ issue: number; source: string }>;
}) {
  const byIssue = new Map<number, { issue: number; sources: string[] }>();
  for (const dependency of [...input.markers, ...input.native]) {
    const current = byIssue.get(dependency.issue) ?? { issue: dependency.issue, sources: [] };
    if (!current.sources.includes(dependency.source)) current.sources.push(dependency.source);
    byIssue.set(dependency.issue, current);
  }
  return {
    dependencies: [...byIssue.values()],
    metrics: {
      native_dependencies_discovered: input.native.length,
      marker_dependencies_merged: input.markers.length,
      dependency_duplicates_removed: input.markers.length + input.native.length - byIssue.size,
    },
  };
}
```

Export `nativeDependencyFailureWarning(input)` returning compact retryable history.

- [ ] **Step 4: Wire GitHub intake**

In `src/intake/github.ts`, add native discovery by:

- extracting tasklist issue references from body lines matching `- [ ] #123` and `- [x] owner/repo#123`;
- querying GitHub cross-reference or linked issue API when configured credentials allow it;
- catching API errors and returning `intake_warning_retryable` history rather than failing lifecycle;
- merging marker and native dependencies with the helper.

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/dependencies.test.ts
node --disable-warning=ExperimentalWarning tests/intake/intake.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/intake/github.ts src/orchestrator/dependencies.ts tests/intake/intake.test.ts tests/orchestrator/dependencies.test.ts
git commit -m "feat: merge native github dependency signals"
```

### Task 12: Product Inspect And GitHub Observability Output

**Files:**
- Modify: `src/orchestrator/inspect.ts`
- Modify: `src/runtime/inspect.ts`
- Modify: `src/adapters/github/observability.ts`
- Create: `tests/orchestrator/inspect.test.ts`
- Modify: `tests/adapters/github-observability.test.ts`

- [ ] **Step 1: Write failing inspect output test**

Create `tests/orchestrator/inspect.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { inspectIssueSnapshot } from "../../src/orchestrator/inspect.ts";

test("inspect issue exposes runtime github project and recovery fields", () => {
  const model = inspectIssueSnapshot({
    issue_id: "issue-88",
    source: "github",
    external_id: "88",
    title: "Inspect",
    body: "body",
    lifecycle_state: "release_pending",
    runtime_context_json: {
      project: { lifecycle: "release_pending", status: "Releasing" },
      pr: { number: 99, url: "https://github.com/owner/repo/pull/99", merge_sha: "" },
      current_stage: "release",
      owner_lease: { lease_id: "lease-1", heartbeat_seq: 3 },
      child_runs: [{ child_run_id: "child-1", root_session_id: "root-1", status: "running" }],
      cleanup: { backlog: 1 },
    },
    updated_at: "2026-05-31T01:00:00.000Z",
  }, [
    { event_type: "effect_failed_retryable", payload: { reason: "projection failed" } },
  ]);

  assert.equal(model.fields_present >= 12, true);
  assert.equal(model.project_status, "Releasing");
  assert.equal(model.pr_url, "https://github.com/owner/repo/pull/99");
  assert.equal(model.cleanup_backlog, 1);
  assert.match(model.recovery_suggestion, /retryable effect/);
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `node --disable-warning=ExperimentalWarning tests/orchestrator/inspect.test.ts`

Expected: FAIL because inspect model lacks Project, cleanup, and recovery fields.

- [ ] **Step 3: Implement inspect fields**

In `src/orchestrator/inspect.ts`, extend `OrchestratorInspectModel` with:

```ts
project_lifecycle: string | null;
project_status: string | null;
pr_url: string | null;
merge_sha: string | null;
current_stage: string | null;
last_heartbeat: string | null;
cleanup_backlog: number;
recovery_suggestion: string;
```

Compute at least 12 present fields for full issue snapshots.

- [ ] **Step 4: Update GitHub issue/PR observability tests**

In `tests/adapters/github-observability.test.ts`, add assertions:

```ts
assert.equal(progressComments.length <= significantTransitions.length + retryableFailures.length);
assert.equal(statusMarkerUpserts >= 3, true);
assert.equal(prVerifierEvidenceComments >= 1, true);
```

Modify `src/adapters/github/observability.ts` so issue status marker uses single upsert behavior and PR comments include verifier evidence, commands passed, browser evidence, and release readiness.

- [ ] **Step 5: Run GREEN checks**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/inspect.test.ts
node --disable-warning=ExperimentalWarning tests/adapters/github-observability.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/orchestrator/inspect.ts src/runtime/inspect.ts src/adapters/github/observability.ts tests/orchestrator/inspect.test.ts tests/adapters/github-observability.test.ts
git commit -m "feat: expose northstar product status and recovery"
```

### Task 13: V2 Spec-To-Issues Live Gate

**Files:**
- Modify: `tests/e2e-product-hardening-live/index.test.ts`
- Create: `tests/e2e-product-hardening-live/spec-to-issues-live.test.ts`
- Modify: `tests/e2e-product-hardening-live/harness.ts`

- [ ] **Step 1: Write failing V2 live test**

Create `tests/e2e-product-hardening-live/spec-to-issues-live.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { runSpecToIssuesLiveE2E } from "./harness.ts";

test("spec-to-issues live flow applies confirmed issue drafts and completes real issues", async (t) => {
  if (process.env.NORTHSTAR_PRODUCT_HARDENING_LIVE !== "1") {
    t.skip("Set NORTHSTAR_PRODUCT_HARDENING_LIVE=1 to run spec-to-issues live E2E.");
    return;
  }

  const result = await runSpecToIssuesLiveE2E({
    repo: process.env.NORTHSTAR_LIVE_GITHUB_REPO!,
    projectId: process.env.NORTHSTAR_LIVE_GITHUB_PROJECT_ID!,
    token: process.env.GITHUB_TOKEN!,
    confirmedApply: true,
  });

  t.diagnostic(JSON.stringify(result.metrics, null, 2));
  assert.equal(result.metrics.spec_plan_inputs_validated, 1);
  assert.equal(result.metrics.issues_generated_from_plan >= 3, true);
  assert.equal(result.metrics.dry_run_requires_no_github_mutation, 1);
  assert.equal(result.metrics.apply_requires_confirmation, 1);
  assert.equal(result.metrics.live_completed_issues >= 3, true);
  assert.equal(result.metrics.live_prs_merged >= 3, true);
  assert.equal(result.metrics.live_browser_tests_passed >= 1, true);
  assert.equal(result.metrics.secret_leaks_in_generated_issues, 0);
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
NORTHSTAR_PRODUCT_HARDENING_LIVE=1 \
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox \
NORTHSTAR_LIVE_GITHUB_PROJECT_ID="$NORTHSTAR_LIVE_GITHUB_PROJECT_ID" \
node --disable-warning=ExperimentalWarning tests/e2e-product-hardening-live/spec-to-issues-live.test.ts
```

Expected: FAIL because `runSpecToIssuesLiveE2E` is missing.

- [ ] **Step 3: Implement live spec-to-issues harness**

In `tests/e2e-product-hardening-live/harness.ts`, add `runSpecToIssuesLiveE2E(input)` that:

- creates a small design spec and implementation plan in a temporary consumer repo;
- runs `generateIssueDraftsFromSpecPlan` in dry-run mode and records zero GitHub mutations;
- runs apply mode only with `confirmedApply === true`;
- creates at least three real GitHub issues with dependency markers and `northstar:ready`;
- adds issues to the configured Project;
- runs production watch until all three complete;
- verifies Project status, PRs, merges, issue closes, and browser evidence;
- records URLs and merge SHAs.

- [ ] **Step 4: Run V2 live gate**

Run:

```bash
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_PRODUCT_HARDENING_LIVE=1 \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox \
NORTHSTAR_LIVE_GITHUB_PROJECT_ID="$NORTHSTAR_LIVE_GITHUB_PROJECT_ID" \
npm run test:e2e:product-hardening-live
```

Expected: PASS with V1 and V2 live metrics.

- [ ] **Step 5: Commit**

Run:

```bash
git add tests/e2e-product-hardening-live/index.test.ts tests/e2e-product-hardening-live/spec-to-issues-live.test.ts tests/e2e-product-hardening-live/harness.ts
git commit -m "test: add spec to issues live e2e gate"
```

---

## Final Verification Gate

- [ ] **Step 1: Run offline unit tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Run offline E2E suites**

Run:

```bash
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:e2e:production-cli-watch
npm run test:coverage
```

Expected: PASS, with coverage thresholds lines/branches/functions/statements `>=85%`.

- [ ] **Step 3: Verify live tests clear-skip without flags**

Run:

```bash
npm run test:e2e:production-live
npm run test:e2e:production-live-worktree
npm run test:e2e:product-hardening-live
```

Expected: PASS with clear skip messages when live flags are unset.

- [ ] **Step 4: Run real product hardening live E2E**

Run:

```bash
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_PRODUCT_HARDENING_LIVE=1 \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox \
NORTHSTAR_LIVE_GITHUB_PROJECT_ID="$NORTHSTAR_LIVE_GITHUB_PROJECT_ID" \
npm run test:e2e:product-hardening-live
```

Expected metrics:

```text
stale_watch_locks_detected >= 1
stale_watch_locks_reclaimed >= 1
fresh_watch_locks_rejected >= 1
duplicate_watch_writers = 0
merge_conflicts_detected >= 1
merge_conflict_recovery_attempts >= 1
merge_conflict_recovered_prs_merged >= 1
merge_conflict_terminal_failures = 0
completed_worktree_cleanup_attempts >= 1
completed_worktrees_archived_or_deleted >= 1
cleanup_failures_retryable >= 1
cleanup_completed_reversals = 0
parallel_ready_siblings >= 2
parallel_active_issue_workers >= 2
parallel_overlap_seconds >= 1
dependency_order_violations = 0
github_project_items_synced >= 5
github_project_lifecycle_completed >= 5
github_project_status_done >= 5
github_project_pr_urls_synced >= 5
github_project_merge_shas_synced >= 5
github_project_status_mismatches = 0
live_issues_created >= 5
live_completed_issues >= 5
live_prs_merged >= 5
live_browser_tests_passed >= 1
live_secret_leaks = 0
live_smoke_only = 0
fake_production_path_used = 0
spec_plan_inputs_validated = 1
issues_generated_from_plan >= 3
secret_leaks_in_generated_issues = 0
```

- [ ] **Step 5: Run CLI smoke checks**

Run:

```bash
node --run northstar -- --help
node --run northstar -- watch --help
node --run northstar -- inspect --help
```

Expected: PASS and commands list `watch`, `inspect`, `repair-runtime`, `intake`, `start`, `reconcile`, and `release`.

- [ ] **Step 6: Run source safety scans**

Run:

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests skills
rg "process\\.env\\." src
rg "paulpai0412/northstar-live-sandbox" src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
rg "readFileSync|writeFileSync|DatabaseSync|fetch\\(|spawn\\(|execFile\\(" src/runtime/state-machine.ts
```

Expected:

- first command returns no matches;
- `process.env` usage remains limited to bootstrap/credential boundaries already covered by tests;
- sandbox repo scan returns no matches in `src`;
- shell-chain scan returns no matches;
- state-machine purity scan returns no matches.

- [ ] **Step 7: Review git status**

Run: `git status --short`

Expected: only intentional tracked changes are present before the final commit, plus ignored local runtime artifacts.

---

## Final Report Requirements

Report:

- V1 reliability metrics.
- GitHub Project viewer sync metrics, including `github_project_status_mismatches`.
- Sequential and parallel live issue ordering evidence.
- Browser evidence path and screenshots.
- Spec-to-issues generation metrics.
- Issue URLs, PR URLs, Project URL, and merge SHAs.
- RED -> GREEN evidence by task.
- Fresh verification output summary.
- Modified files summary.
- Remaining work outside this plan:
  - npm publish.
  - production OS service packaging.
  - content_creation domain driver.
  - office_automation domain driver.
