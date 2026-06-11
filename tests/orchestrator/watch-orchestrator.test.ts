import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatchCycleWithCachedProduction, createWatchOrchestratorRunner, runWatchCycleWithProductionIntake } from "../../src/cli/watch-command.ts";
import { createProductionOrchestrator, type ProductionObservability } from "../../src/orchestrator/cycle.ts";
import { FakeDomainDriver, type DomainDriverContext } from "../../src/orchestrator/domain-driver.ts";
import { ArtifactValidationError } from "../../src/runtime/artifacts.ts";
import { loadConfig } from "../../src/config/load-config.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import { QueuedHostSessionBridge } from "../../src/orchestrator/software-dev-driver.ts";
import type { HostAdapter, StartBackgroundChildRequest, StartRootSessionRequest } from "../../src/types/host.ts";

test("watch delegates business flow to orchestrator runner", async () => {
  const calls: string[] = [];
  const runner = createWatchOrchestratorRunner({
    runCycle: async () => {
      calls.push("orchestrator.runCycle");
      return {
        activeIssues: 2,
        effectsStarted: 1,
        summary: {
          watch_cycles_completed: 1,
          watch_intake_processed: 1,
          watch_issues_started: 1,
          watch_secret_leaks: 0,
        },
      };
    },
  });

  const result = await runner();
  assert.equal(result.activeIssues, 2);
  assert.equal(result.effectsStarted, 1);
  assert.deepEqual(calls, ["orchestrator.runCycle"]);
});

test("watch intakes ready github issues before running cycle", async () => {
  const calls: string[] = [];
  const result = await runWatchCycleWithProductionIntake({
    listReadyIssues: async () => [
      readyIssue({ number: 2, title: "Second" }),
      readyIssue({ number: 1, title: "First" }),
    ],
    orchestrator: {
      intakeIssue: async (input) => {
        calls.push(`intake:${input.issueNumber}`);
      },
      runCycle: async () => ({ activeIssues: 2, effectsStarted: 1, historyRows: 3 }),
    },
    maxStarts: 1,
    autoRelease: false,
  });

  assert.deepEqual(calls, ["intake:1", "intake:2"]);
  assert.equal(result.activeIssues, 2);
  assert.equal(result.historyRows, 3);
});

test("watch skips github ready issue discovery when intake is disabled", async () => {
  let listed = 0;
  const result = await runWatchCycleWithProductionIntake({
    intakeEnabled: false,
    listReadyIssues: async () => {
      listed += 1;
      return [readyIssue({ number: 1, title: "Skipped" })];
    },
    orchestrator: {
      intakeIssue: async () => {
        throw new Error("intake should not run when disabled");
      },
      runCycle: async () => ({ activeIssues: 1, effectsStarted: 0, historyRows: 2 }),
    },
    maxStarts: 1,
    autoRelease: false,
  });

  assert.equal(listed, 0);
  assert.equal(result.activeIssues, 1);
  assert.equal(result.historyRows, 2);
});

test("watch reuses production dependencies across cycles", async () => {
  const config = loadConfig("tests/fixtures/.northstar.yaml");
  let productionBuilds = 0;
  let cycleRuns = 0;
  const runCycle = createWatchCycleWithCachedProduction({
    config,
    autoRelease: config.runtime.autoRelease,
    maxStarts: config.runtime.developmentCapacity,
    intakeEnabled: config.github.intake.enabled,
    createProduction: async () => {
      productionBuilds += 1;
      return {
        dependencies: {
          issueIntake: {
            listReadyIssues: async () => [],
          },
        },
        orchestrator: {
          intakeIssue: async () => undefined,
          runCycle: async () => {
            cycleRuns += 1;
            return { activeIssues: 0, effectsStarted: 0, historyRows: cycleRuns };
          },
        },
      };
    },
  });

  const first = await runCycle();
  const second = await runCycle();

  assert.equal(productionBuilds, 1);
  assert.equal(first.historyRows, 1);
  assert.equal(second.historyRows, 2);
});

test("watch retries production bootstrap after transient failure", async () => {
  const config = loadConfig("tests/fixtures/.northstar.yaml");
  let bootstrapAttempts = 0;
  const runCycle = createWatchCycleWithCachedProduction({
    config,
    autoRelease: config.runtime.autoRelease,
    maxStarts: config.runtime.developmentCapacity,
    intakeEnabled: config.github.intake.enabled,
    createProduction: async () => {
      bootstrapAttempts += 1;
      if (bootstrapAttempts === 1) {
        throw new Error("transient bootstrap failure");
      }
      return {
        dependencies: {
          issueIntake: {
            listReadyIssues: async () => [],
          },
        },
        orchestrator: {
          intakeIssue: async () => undefined,
          runCycle: async () => ({ activeIssues: 0, effectsStarted: 0, historyRows: 1 }),
        },
      };
    },
  });

  await assert.rejects(async () => await runCycle(), /transient bootstrap failure/);
  const result = await runCycle();

  assert.equal(bootstrapAttempts, 2);
  assert.equal(result.historyRows, 1);
});

test("production orchestrator syncs Project fields at each lifecycle transition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-project-sync-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    await orchestrator.intakeIssue({
      issueNumber: 42,
      title: "Project sync transitions",
      body: "Make Project projection complete",
      sourceUrl: "https://github.test/owner/repo/issues/42",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:42" });
    await orchestrator.reconcileIssue({ issueId: "github:42" });
    await orchestrator.releaseIssue({ issueId: "github:42", autoRelease: true });

    const byLifecycle = new Map(projectSyncs.map((sync) => [sync.lifecycleState, sync]));
    const projectionMarkers = store.listHistory("github:42")
      .filter((entry) => entry.event_type === "project_projection_synced")
      .map((entry) => entry.payload.lifecycle);
    assert.deepEqual([...byLifecycle.keys()], [
      "ready",
      "running",
      "verifying",
      "verified",
      "releasing",
      "completed",
    ]);
    assert.deepEqual(projectionMarkers, [
      "ready",
      "running",
      "verifying",
      "verified",
      "releasing",
      "completed",
    ]);
    assert.equal(byLifecycle.get("ready")?.fields?.["Northstar Lifecycle"], "ready");
    assert.equal(byLifecycle.get("running")?.fields?.Status, "In Progress");
    assert.equal(byLifecycle.get("verifying")?.fields?.Status, "In Review");
    assert.equal(byLifecycle.get("verified")?.fields?.Status, "Ready to Release");
    assert.equal(byLifecycle.get("releasing")?.fields?.Status, "Releasing");
    assert.equal(byLifecycle.get("completed")?.fields?.Status, "Done");
    assert.equal(byLifecycle.get("completed")?.fields?.["PR URL"], "https://github.test/github:42/pull/1");
    assert.equal(byLifecycle.get("completed")?.fields?.["Merge SHA"], "merge-1");
    assert.equal(orchestrator.metrics().manual.github_project_items_synced, 6);
    assert.equal(orchestrator.metrics().manual.github_project_lifecycle_completed, 1);
    assert.equal(orchestrator.metrics().manual.github_project_status_done, 1);
    assert.equal(orchestrator.metrics().manual.github_project_pr_urls_synced, 4);
    assert.equal(orchestrator.metrics().manual.github_project_merge_shas_synced, 1);
    assert.equal(orchestrator.metrics().manual.github_project_status_mismatches, 0);
    assert.equal(orchestrator.metrics().manual.github_projection_failures_retryable, 0);
    assert.equal(orchestrator.metrics().manual.github_projection_failures_do_not_mutate_lifecycle, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual run cycle waits for release approval instead of starting release worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-manual-release-approval-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:43", {
      lifecycle_state: "verified",
      stage_cursor: "verification",
      runtime_context_json: {
        issue_packet: {
          issue_number: "43",
          title: "Manual release approval",
          raw_text: "Require a human approval before release.",
          source_url: "https://github.test/owner/repo/issues/43",
        },
        branch: "northstar/issue-43",
        pr: {
          number: 43,
          url: "https://github.test/owner/repo/pull/43",
          head_branch: "northstar/issue-43",
          head_sha: "head-43",
          base_branch: "main",
        },
      },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    const cycle = await orchestrator.runCycle({ autoRelease: false, maxStarts: 1 });
    const snapshot = store.getIssue("github:43");
    const history = store.listHistory("github:43");

    assert.equal(cycle.effectsStarted, 0);
    assert.equal(snapshot.lifecycle_state, "release_pending");
    assert.equal(snapshot.runtime_context_json.stage_cursor, "release");
    assert.equal(snapshot.runtime_context_json.owner_lease, undefined);
    assert.equal(snapshot.runtime_context_json.child_runs?.length ?? 0, 0);
    assert.equal(history.some((entry) => entry.event_type === "release_approval_required"), true);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "release_pending");
    assert.equal(projectSyncs.at(-1)?.fields?.Status, "Pending Release Approval");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production watch reconciles externally closed ready issues before scheduling new work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-closed-ready-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-01T12:30:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      issueSource: new FakeIssueSourceState({
        13: { state: "closed", stateReason: "not_planned", closedAt: "2026-06-01T11:48:12Z" },
        14: { state: "closed", stateReason: "not_planned", closedAt: "2026-06-01T11:48:17Z" },
        16: { state: "open" },
      }),
    });

    for (const issue of [
      { issueNumber: 13, title: "Closed feature 1" },
      { issueNumber: 14, title: "Closed feature 2" },
      { issueNumber: 16, title: "Open replacement" },
    ]) {
      await orchestrator.intakeIssue({
        ...issue,
        body: "Body",
        sourceUrl: `https://github.test/owner/repo/issues/${issue.issueNumber}`,
        labels: ["northstar:ready"],
      });
    }

    const cycle = await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    const history13 = store.listHistory("github:13").map((entry) => entry.event_type);
    const history14 = store.listHistory("github:14").map((entry) => entry.event_type);

    assert.equal(cycle.effectsStarted, 1);
    assert.equal(store.getIssue("github:13").lifecycle_state, "cancelled");
    assert.equal(store.getIssue("github:14").lifecycle_state, "cancelled");
    assert.equal(store.getIssue("github:16").lifecycle_state, "running");
    assert.equal(history13.includes("external_issue_closed_detected"), true);
    assert.equal(history14.includes("external_issue_closed_detected"), true);
    assert.equal(projectSyncs.find((sync) => sync.issueNumber === 13 && sync.lifecycleState === "cancelled")?.fields?.Status, "Cancelled");
    assert.equal(projectSyncs.find((sync) => sync.issueNumber === 14 && sync.lifecycleState === "cancelled")?.fields?.["Current Stage"], "cancelled");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production startIssue refuses to dispatch a GitHub issue closed after intake", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-start-closed-ready-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new ThrowingHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-01T12:31:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      issueSource: new FakeIssueSourceState({
        13: { state: "closed", stateReason: "not_planned", closedAt: "2026-06-01T11:48:12Z" },
      }),
    });

    await orchestrator.intakeIssue({
      issueNumber: 13,
      title: "Closed after intake",
      body: "Body",
      sourceUrl: "https://github.test/owner/repo/issues/13",
      labels: ["northstar:ready"],
    });

    const snapshot = await orchestrator.startIssue({ issueId: "github:13" });
    const history = store.listHistory("github:13").map((entry) => entry.event_type);

    assert.equal(snapshot.lifecycle_state, "cancelled");
    assert.equal(store.getIssue("github:13").current_session_id, undefined);
    assert.equal(history.includes("external_issue_closed_detected"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production orchestrator emits progress before long worker work finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-progress-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const events: string[] = [];
  let unblockPrepare!: () => void;
  const prepareGate = new Promise<void>((resolve) => {
    unblockPrepare = resolve;
  });

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new BlockingPrepareDomainDriver(prepareGate),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      progress: async (event) => {
        events.push(event.event);
      },
    });

    await orchestrator.intakeIssue({
      issueNumber: 41,
      title: "Progress before long worker",
      body: "worker takes a long time",
      sourceUrl: "https://github.test/owner/repo/issues/41",
      labels: ["northstar:ready"],
    });

    const start = orchestrator.startIssue({ issueId: "github:41" });
    await waitForProgress(events, "worker_started");

    assert.deepEqual(events.filter((event) => event === "issue_started" || event === "worker_started"), [
      "issue_started",
      "worker_started",
    ]);

    unblockPrepare();
    await start;
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production orchestrator keeps recoverable dispatch block non-terminal when sync worktree cannot prepare base", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-sync-worktree-block-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new ThrowingHost(),
      domain: new SyncWorktreeFailureDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    await orchestrator.intakeIssue({
      issueNumber: 47,
      title: "Sync worktree blocked",
      body: "sync worktree must gate dispatch",
      sourceUrl: "https://github.test/owner/repo/issues/47",
      labels: ["northstar:ready"],
    });
    const snapshot = await orchestrator.startIssue({ issueId: "github:47" });
    const stored = store.getIssue("github:47");
    const history = store.listHistory("github:47").map((entry) => entry.event_type);
    const blockedProjection = projectSyncs.at(-1);

    assert.equal(snapshot.lifecycle_state, "ready");
    assert.equal(stored.lifecycle_state, "ready");
    assert.equal(stored.current_session_id, undefined);
    assert.equal(stored.runtime_context_json.owner_lease, undefined);
    assert.equal(stored.runtime_context_json.stage_cursor, undefined);
    assert.equal(stored.runtime_context_json.last_error, "sync worktree dirty");
    assert.deepEqual(stored.runtime_context_json.blocked_by, ["sync_worktree"]);
    assert.equal(blockedProjection?.lifecycleState, "ready");
    assert.equal(blockedProjection?.fields?.Status, "Blocked");
    assert.equal(blockedProjection?.fields?.["Last Error"], "sync worktree dirty");
    assert.equal(blockedProjection?.fields?.["Blocked By"], "sync_worktree");
    assert.equal(history.includes("dispatch_blocked_recoverable"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production watch recovers ready sync-worktree block before retrying dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-sync-worktree-recover-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const domain = new RecoverableSyncWorktreeDomainDriver();

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 71,
      title: "Recover dispatch block",
      body: "recover sync worktree before dispatch retry",
      sourceUrl: "https://github.test/owner/repo/issues/71",
      labels: ["northstar:ready"],
    });

    await orchestrator.startIssue({ issueId: "github:71" });
    const blocked = store.getIssue("github:71");
    assert.equal(blocked.lifecycle_state, "ready");
    assert.deepEqual(blocked.runtime_context_json.blocked_by, ["sync_worktree"]);

    await orchestrator.runCycle({ maxStarts: 1, autoRelease: false });
    const recovered = store.getIssue("github:71");
    const history = store.listHistory("github:71").map((entry) => entry.event_type);

    assert.equal(recovered.lifecycle_state, "running");
    assert.equal(recovered.runtime_context_json.blocked_by, undefined);
    assert.equal(recovered.runtime_context_json.blocked_error_code, undefined);
    assert.equal(history.includes("dispatch_recovery_succeeded"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile on ready issue clears dispatch blocker without running finalize", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-ready-recovery-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const domain = new RecoverableSyncWorktreeDomainDriver();

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 72,
      title: "Reconcile ready recovery",
      body: "ready reconcile should clear blocker only",
      sourceUrl: "https://github.test/owner/repo/issues/72",
      labels: ["northstar:ready"],
    });

    await orchestrator.startIssue({ issueId: "github:72" });
    const result = await orchestrator.reconcileIssue({ issueId: "github:72" }) as { next_action?: string };
    const snapshot = store.getIssue("github:72");
    const history = store.listHistory("github:72").map((entry) => entry.event_type);

    assert.equal(result.next_action, "dispatch_recovery_succeeded");
    assert.equal(snapshot.lifecycle_state, "ready");
    assert.equal(snapshot.runtime_context_json.blocked_by, undefined);
    assert.equal(snapshot.runtime_context_json.blocked_error_code, undefined);
    assert.equal(history.includes("dispatch_recovery_succeeded"), true);
    assert.equal(history.includes("child_artifact_received"), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production orchestrator records post-release sync worktree refresh failures as recoverable readiness errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-release-sync-worktree-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ReleaseSyncWorktreeFailureDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    await orchestrator.intakeIssue({
      issueNumber: 57,
      title: "Release sync worktree refresh",
      body: "release sync worktree failure must remain recoverable",
      sourceUrl: "https://github.test/owner/repo/issues/57",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:57" });
    await orchestrator.reconcileIssue({ issueId: "github:57" });
    const released = await orchestrator.releaseIssue({ issueId: "github:57", autoRelease: true });
    const stored = store.getIssue("github:57");
    const history = store.listHistory("github:57");

    assert.equal(released.lifecycle_state, "completed");
    assert.equal(stored.lifecycle_state, "completed");
    assert.equal(stored.runtime_context_json.last_error, "sync worktree HEAD stale-main does not match merged main merge-57");
    assert.deepEqual(stored.runtime_context_json.blocked_by, ["sync_worktree"]);
    assert.equal(history.some((entry) => entry.event_type === "release_completed"), true);
    assert.equal(history.some((entry) => entry.event_type === "sync_worktree_refresh_failed"), true);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "completed");
    assert.equal(projectSyncs.at(-1)?.fields?.Status, "Blocked");
    assert.equal(projectSyncs.at(-1)?.fields?.["Last Error"], "sync worktree HEAD stale-main does not match merged main merge-57");
    assert.equal(projectSyncs.at(-1)?.fields?.["Blocked By"], "sync_worktree");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production run cycle retries completed sync worktree refresh and repairs Project status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-completed-sync-retry-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const domain = new ReleaseSyncWorktreeRetryDomainDriver();
  let now = "2026-05-31T00:00:00.000Z";
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => now,
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    await orchestrator.intakeIssue({
      issueNumber: 58,
      title: "Release sync worktree retry",
      body: "release sync worktree failure must retry after completion",
      sourceUrl: "https://github.test/owner/repo/issues/58",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:58" });
    await orchestrator.reconcileIssue({ issueId: "github:58" });
    await orchestrator.releaseIssue({ issueId: "github:58", autoRelease: true });
    now = "2026-05-31T00:01:00.000Z";
    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    const stored = store.getIssue("github:58");
    const fullHistory = store.listHistory("github:58");
    const history = fullHistory.map((entry) => entry.event_type);
    const projectMarkers = fullHistory
      .filter((entry) => entry.event_type === "project_projection_synced")
      .map((entry) => entry.payload.project_status);

    assert.equal(stored.lifecycle_state, "completed");
    assert.equal(stored.runtime_context_json.release?.sync_worktree_refresh?.status, "synced");
    assert.equal(stored.runtime_context_json.release?.sync_worktree_refresh?.head_commit, "merge-58");
    assert.equal(stored.runtime_context_json.last_error, undefined);
    assert.equal(stored.runtime_context_json.blocked_by, undefined);
    assert.equal(domain.syncRefreshes, 1);
    assert.equal(history.includes("sync_worktree_refresh_retry_started"), true);
    assert.equal(history.includes("sync_worktree_refreshed"), true);
    assert.equal(projectMarkers.includes("Blocked"), true);
    assert.equal(projectMarkers.at(-1), "Done");
    assert.equal(projectSyncs.at(-1)?.fields?.Status, "Done");
    assert.equal(projectSyncs.at(-1)?.fields?.["Last Error"], "");
    assert.equal(projectSyncs.at(-1)?.fields?.["Blocked By"], "");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle reconciles externally merged active issue with audit history and terminal projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-external-merge-active-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const progressEvents: string[] = [];
  const archivedWorktrees: Array<{ worktreePath: string; archivePath: string }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:55", {
      lifecycle_state: "running",
      current_session_id: "root-stale-55",
      owner_lease: {
        lease_id: "lease-implementation-github:55",
        root_session_id: "root-stale-55",
        role: "implementation_agent",
        generation: 1,
        heartbeat_seq: 0,
        last_heartbeat_at: "2026-05-31T00:00:00.000Z",
        expires_at: "2026-05-31T00:10:00.000Z",
      },
      stage_cursor: "implementation",
      child_runs: [{
        child_run_id: "root-stale-55:implement",
        lease_id: "lease-implementation-github:55",
        root_session_id: "root-stale-55",
        role: "implementation_agent",
        status: "running",
        session_id: "root-stale-55",
        started_at: "2026-05-31T00:00:00.000Z",
        last_seen_at: "2026-05-31T00:00:00.000Z",
      }],
      runtime_context_json: {
        issue_packet: {
          issue_number: "55",
          title: "Already merged active issue",
          raw_text: "Worker finished externally and PR was merged",
          source_url: "https://github.test/owner/repo/issues/55",
        },
        branch: "northstar/issue-55",
      },
      worktree_path: "/repo/.northstar/runtime/worktrees/issue-55",
    }));
    const domain = new ExternallyCompletedDomainDriver();
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
      progress: async (event) => {
        progressEvents.push(event.event);
      },
      cleanupPolicy: { completedWorktrees: "archive", keepLast: 0, failedOrQuarantined: "keep" },
      cleanup: {
        archiveManagedWorktree: async (input) => {
          archivedWorktrees.push(input);
        },
        deleteManagedWorktree: async () => assert.fail("archive policy should not delete worktree"),
      },
      projectRoot: "/repo",
      worktreesDir: ".northstar/runtime/worktrees",
    });

    const cycle = await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    const snapshot = store.getIssue("github:55");
    const history = store.listHistory("github:55");
    assert.equal(snapshot.lifecycle_state, "completed");
    assert.equal(snapshot.current_session_id, undefined);
    assert.equal(snapshot.runtime_context_json.owner_lease, undefined);
    assert.equal(snapshot.runtime_context_json.stage_cursor, undefined);
    assert.equal(snapshot.runtime_context_json.child_runs?.[0]?.status, "succeeded");
    assert.equal((snapshot.runtime_context_json.pr as { prNumber?: number }).prNumber, 99);
    assert.equal((snapshot.runtime_context_json.pr as { prUrl?: string }).prUrl, "https://github.test/owner/repo/pull/99");
    assert.equal((snapshot.runtime_context_json.pr as { headCommit?: string }).headCommit, "external-head-99");
    assert.equal((snapshot.runtime_context_json.pr as { mergeSha?: string }).mergeSha, "external-merge-99");
    assert.equal((snapshot.runtime_context_json.release as { merge_sha?: string }).merge_sha, "external-merge-99");
    assert.deepEqual(snapshot.runtime_context_json.release?.sync_worktree_refresh, {
      status: "synced",
      path: "/repo/.northstar/runtime/sync-worktrees/main",
      head_commit: "external-merge-99",
      expected_commit: "external-merge-99",
    });
    const unexpectedMerge = history.find((entry) => entry.event_type === "unexpected_external_merge_detected");
    assert.deepEqual(unexpectedMerge?.payload, {
      classification: "pre_release_external_merge",
      possible_cause: "worker_or_external_actor_merged_before_release_stage",
      detected_lifecycle: "running",
      detected_stage: "implementation",
      expected_stage: "release",
      pr_number: 99,
      pr_url: "https://github.test/owner/repo/pull/99",
      branch: "northstar/issue-55",
      head_commit: "external-head-99",
      merge_sha: "external-merge-99",
    });
    const externalMerge = history.find((entry) => entry.event_type === "external_merge_detected");
    assert.deepEqual(externalMerge?.payload, {
      classification: "pre_release_external_merge",
      detected_lifecycle: "running",
      detected_stage: "implementation",
      expected_stage: "release",
      pr_number: 99,
      pr_url: "https://github.test/owner/repo/pull/99",
      branch: "northstar/issue-55",
      head_commit: "external-head-99",
      merge_sha: "external-merge-99",
    });
    assert.equal(history.some((entry) => entry.event_type === "sync_worktree_refreshed"), true);
    assert.equal(history.some((entry) => entry.event_type === "completed_worktree_cleanup_succeeded"), true);
    assert.deepEqual(archivedWorktrees, [{
      worktreePath: "/repo/.northstar/runtime/worktrees/issue-55",
      archivePath: "/repo/.northstar/runtime/archive/worktrees/issue-55-2026-05-31T00-00-00-000Z",
    }]);
    assert.equal(domain.syncRefreshes, 1);
    assert.equal(domain.dispatches, 0);
    assert.equal(cycle.effectsStarted, 0);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "completed");
    assert.equal(projectSyncs.at(-1)?.fields?.["Current Stage"], "completed");
    assert.deepEqual(progressEvents.filter((event) => event === "unexpected_external_merge_detected" || event === "external_merge_detected" || event === "completed"), [
      "unexpected_external_merge_detected",
      "external_merge_detected",
      "completed",
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle does not release a stale verified snapshot after external completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-external-completed-verified-stale-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:56", {
      lifecycle_state: "verified",
      stage_cursor: "release",
      runtime_context_json: {
        issue_packet: {
          issue_number: "56",
          title: "Already externally merged verified issue",
          raw_text: "PR was merged outside the release worker",
          source_url: "https://github.test/owner/repo/issues/56",
        },
        pr: {
          prNumber: 99,
          prUrl: "https://github.test/owner/repo/pull/99",
          branch: "northstar/issue-56",
          commitSha: "external-head-99",
        },
      },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ExternallyCompletedDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    const cycle = await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    const snapshot = store.getIssue("github:56");
    const history = store.listHistory("github:56");

    assert.equal(cycle.effectsStarted, 0);
    assert.equal(snapshot.lifecycle_state, "completed");
    assert.equal(snapshot.current_session_id, undefined);
    assert.equal(snapshot.runtime_context_json.owner_lease, undefined);
    assert.equal(history.some((entry) => entry.event_type === "external_merge_detected"), true);
    assert.equal(history.some((entry) => entry.event_type === "release_started"), false);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "completed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile recovers external merge after verifier artifact ingestion failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-verifier-fail-external-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(58));
    const domain = new VerifierArtifactFailureThenExternalCompletionDomainDriver();
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    const result = await orchestrator.reconcileIssue({ issueId: "github:58" });
    const snapshot = store.getIssue("github:58");
    const history = store.listHistory("github:58").map((entry) => entry.event_type);

    assert.equal(result.issue.lifecycle_state, "completed");
    assert.equal(snapshot.lifecycle_state, "completed");
    assert.equal(history.includes("external_merge_detected"), true);
    assert.equal(history.includes("release_completed"), true);
    assert.equal(history.includes("verifier_artifact_rejected"), false);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "completed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile treats verifier artifact ingestion failure as retryable without hard exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-verifier-fail-retryable-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(59));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new VerifierArtifactFailureDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    const result = await orchestrator.reconcileIssue({ issueId: "github:59" });
    const snapshot = store.getIssue("github:59");
    const history = store.listHistory("github:59");

    assert.equal(result.issue.lifecycle_state, "exception");
    assert.equal(snapshot.lifecycle_state, "exception");
    assert.equal(snapshot.runtime_context_json.last_error, "browser acceptance requires a structured verifier evidence artifact");
    assert.equal(snapshot.runtime_context_json.blocked_by, undefined);
    assert.equal(snapshot.runtime_context_json.runtime_recovery?.reason_code, "artifact_rejected_retryable");
    assert.equal(history.some((entry) => entry.event_type === "verifier_artifact_rejected"), true);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "exception");
    assert.equal(projectSyncs.at(-1)?.fields?.Status, "Blocked");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile treats implementation agent contract failures as retryable without hard exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-worker-contract-fail-retryable-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(63));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ImplementationAgentContractFailureDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    const result = await orchestrator.reconcileIssue({ issueId: "github:63" });
    const snapshot = store.getIssue("github:63");
    const history = store.listHistory("github:63");

    assert.equal(result.next_action, "worker_artifact_rejected");
    assert.equal(result.issue.lifecycle_state, "exception");
    assert.equal(snapshot.lifecycle_state, "exception");
    assert.equal(snapshot.current_session_id, undefined);
    assert.equal(snapshot.runtime_context_json.owner_lease, undefined);
    assert.equal(snapshot.runtime_context_json.runtime_recovery?.reason_code, "worker_artifact_rejected_retryable");
    assert.equal(snapshot.runtime_context_json.last_error, "agent result issue_number must be 63");
    assert.equal(snapshot.runtime_context_json.exception?.summary, "worker_artifact_rejected_retryable");
    assert.deepEqual(snapshot.runtime_context_json.exception_carry_forward, {
      error: "agent result issue_number must be 63",
    });
    assert.equal(history.some((entry) => entry.event_type === "worker_artifact_rejected"), true);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "exception");
    assert.equal(projectSyncs.at(-1)?.fields?.Status, "Blocked");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile treats typed artifact validation failures as retryable issue recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-artifact-validation-retryable-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));

  try {
    store.createIssue(runningIssueSnapshot(60));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ArtifactValidationFailureDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    const result = await orchestrator.reconcileIssue({ issueId: "github:60" });
    const snapshot = store.getIssue("github:60");

    assert.equal(result.issue.lifecycle_state, "exception");
    assert.equal(snapshot.lifecycle_state, "exception");
    assert.equal(snapshot.runtime_context_json.blocked_by, undefined);
    assert.equal(snapshot.runtime_context_json.runtime_recovery?.reason_code, "artifact_rejected_retryable");
    assert.equal(store.listHistory("github:60").some((entry) => entry.event_type === "verifier_artifact_rejected"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile preserves PR metadata when verifier artifact validation fails after PR creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-artifact-validation-pr-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(61));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ArtifactValidationFailureWithPrDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    const result = await orchestrator.reconcileIssue({ issueId: "github:61" });
    const snapshot = store.getIssue("github:61");
    const history = store.listHistory("github:61");

    assert.equal(result.issue.lifecycle_state, "exception");
    assert.equal(snapshot.lifecycle_state, "exception");
    assert.equal((snapshot.runtime_context_json.pr as { prNumber?: number }).prNumber, 41);
    assert.equal((snapshot.runtime_context_json.pr as { prUrl?: string }).prUrl, "https://github.test/owner/repo/pull/41");
    assert.equal((snapshot.runtime_context_json.pr as { commitSha?: string }).commitSha, "head-41");
    assert.equal(history.some((entry) => entry.event_type === "pull_request_recorded"), true);
    assert.equal(history.some((entry) => entry.event_type === "verifier_artifact_rejected"), true);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "exception");
    assert.equal(projectSyncs.at(-1)?.fields?.["PR URL"], "https://github.test/owner/repo/pull/41");
    assert.equal(projectSyncs.at(-1)?.fields?.Status, "Blocked");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile records domain-provided worker and verifier artifacts instead of synthetic smoke artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-domain-artifacts-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));

  try {
    store.createIssue(runningIssueSnapshot(62));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new DomainArtifactPayloadDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.reconcileIssue({ issueId: "github:62" });
    const history = store.listHistory("github:62");
    const workerArtifact = history.find((entry) =>
      entry.event_type === "child_artifact_received" &&
      entry.payload.artifact_kind === "worker_result"
    );
    const verifierArtifact = history.find((entry) =>
      entry.event_type === "child_artifact_received" &&
      entry.payload.artifact_kind === "evidence_packet"
    );

    assert.equal(store.getIssue("github:62").lifecycle_state, "verified");
    assert.deepEqual(workerArtifact?.payload.changed_files, ["src/domain-artifact.ts"]);
    assert.equal(workerArtifact?.payload.commit_sha, "domain-head-62");
    assert.equal(verifierArtifact?.payload.pr_number, 62);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile recovers quarantined verifier artifact when domain validates existing PR evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-quarantined-verifier-recovery-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const issueProgress: Array<{ issueNumber: number; lifecycleState: string; blockedBy?: string[] }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress(input) {
      issueProgress.push({
        issueNumber: input.issueNumber,
        lifecycleState: input.lifecycleState,
        blockedBy: input.blockedBy,
      });
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:39", {
      lifecycle_state: "quarantined",
      runtime_context_json: {
        issue_packet: {
          issue_number: "39",
          title: "Recovered browser evidence",
          raw_text: "Browser evidence was valid but schema rejected it",
          source_url: "https://github.test/owner/repo/issues/39",
        },
        pr: {
          prNumber: 41,
          prUrl: "https://github.test/owner/repo/pull/41",
          branch: "northstar/issue-39",
          commitSha: "head-39",
        },
        last_error: "ARTIFACT_UNKNOWN_KIND at artifact_kind: unknown artifact kind northstar_worker_result",
        blocked_by: ["verifier_artifact"],
      },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new RecoveringVerifierArtifactDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    const result = await orchestrator.reconcileIssue({ issueId: "github:39" });
    const snapshot = store.getIssue("github:39");
    const history = store.listHistory("github:39");

    assert.equal(result.next_action, "verifier_artifact_recovered");
    assert.equal(snapshot.lifecycle_state, "verified");
    assert.equal(snapshot.runtime_context_json.stage_cursor, "verification");
    assert.deepEqual(snapshot.runtime_context_json.blocked_by, []);
    assert.equal(snapshot.runtime_context_json.last_error, undefined);
    assert.equal(history.some((entry) => entry.event_type === "verifier_artifact_recovered"), true);
    assert.equal(issueProgress.at(-1)?.lifecycleState, "verified");
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "verified");
    assert.equal(projectSyncs.at(-1)?.fields?.["PR URL"], "https://github.test/owner/repo/pull/41");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle projects ready issue blocked by quarantined dependency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-dependency-terminal-block-projection-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const issueProgress: Array<{ issueNumber: number; lifecycleState: string; blockedBy?: string[] }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress(input) {
      issueProgress.push({
        issueNumber: input.issueNumber,
        lifecycleState: input.lifecycleState,
        blockedBy: input.blockedBy,
      });
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:39", {
      lifecycle_state: "quarantined",
      runtime_context_json: {
        issue_packet: {
          issue_number: "39",
          title: "Quarantined dependency",
          raw_text: "Upstream failed verification",
          source_url: "https://github.test/owner/repo/issues/39",
        },
      },
    }));
    store.createIssue(newIssueSnapshot("github:40", {
      lifecycle_state: "ready",
      runtime_context_json: {
        issue_packet: {
          issue_number: "40",
          title: "Dependent issue",
          raw_text: "Depends-On: #39",
          source_url: "https://github.test/owner/repo/issues/40",
        },
        dependencies: [39],
        blocked_by: ["sync_worktree"],
      },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    const cycle = await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    const dependent = store.getIssue("github:40");

    assert.equal(cycle.effectsStarted, 0);
    assert.equal(dependent.lifecycle_state, "ready");
    assert.deepEqual(dependent.runtime_context_json.blocked_by, ["sync_worktree", "dependency:39:quarantined"]);
    assert.equal(dependent.runtime_context_json.last_error, "Dependency #39 is quarantined");
    assert.equal(store.listHistory("github:40").some((entry) => entry.event_type === "dependency_blocked"), true);
    assert.equal(projectSyncs.find((sync) => sync.issueNumber === 40)?.fields?.Status, "Blocked");
    assert.equal(projectSyncs.find((sync) => sync.issueNumber === 40)?.fields?.["Blocked By"], "sync_worktree, dependency:39:quarantined");
    assert.deepEqual(issueProgress.find((sync) => sync.issueNumber === 40)?.blockedBy, ["sync_worktree", "dependency:39:quarantined"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production orchestrator passes configured Project id and does not count skipped syncs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-project-id-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectIds: unknown[] = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectIds.push((input as { projectId?: unknown }).projectId);
      return { type: "projection_skipped", status: "skipped", projection_target: "github_project", mutates_lifecycle: false };
    },
  };

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    await orchestrator.intakeIssue({
      issueNumber: 43,
      title: "Project id",
      body: "Project id must flow to adapter",
      sourceUrl: "https://github.test/owner/repo/issues/43",
      labels: ["northstar:ready"],
    });

    assert.deepEqual(projectIds, ["PVT_project_1"]);
    assert.equal(orchestrator.metrics().manual.github_project_items_synced, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production orchestrator persists retryable Project projection failures without mutating lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-project-failure-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields() {
      return {
        type: "projection_result",
        projection_target: "github_project",
        status: "failed",
        last_error: "project temporarily unavailable",
        next_retry_at: "2026-05-31T00:01:00.000Z",
        mutates_lifecycle: false,
      };
    },
  };

  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    await orchestrator.intakeIssue({
      issueNumber: 44,
      title: "Project failure",
      body: "Project failure must be persisted",
      sourceUrl: "https://github.test/owner/repo/issues/44",
      labels: ["northstar:ready"],
    });

    const snapshot = store.getIssue("github:44");
    const projectionFailures = store.listHistory("github:44").filter((entry) => entry.event_type === "projection_failed");
    assert.equal(snapshot.lifecycle_state, "ready");
    assert.equal(projectionFailures.length, 1);
    assert.equal(projectionFailures[0]?.payload.projection_target, "github_project");
    assert.equal(orchestrator.metrics().manual.github_projection_failures_retryable, 1);
    assert.equal(orchestrator.metrics().manual.github_projection_failures_do_not_mutate_lifecycle, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle projects ready issue with missing dependency as blocked instead of silently staying Todo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-missing-dependency-blocked-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const issueProgress: Array<{ issueNumber: number; lifecycleState: string; blockedBy?: string[] }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress(input) {
      issueProgress.push({
        issueNumber: input.issueNumber,
        lifecycleState: input.lifecycleState,
        blockedBy: input.blockedBy,
      });
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    await createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:15:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    }).intakeIssue({
      issueNumber: 41,
      title: "Missing dependency",
      body: "Depends-On: #999\n\nDo the dependent work.",
      sourceUrl: "https://github.test/owner/repo/issues/41",
      labels: ["northstar:ready"],
    });
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:15:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    const cycle = await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    const dependent = store.getIssue("github:41");
    const history = store.listHistory("github:41");

    assert.equal(cycle.effectsStarted, 0);
    assert.equal(dependent.lifecycle_state, "ready");
    assert.deepEqual(dependent.runtime_context_json.blocked_by, ["dependency:999:missing"]);
    assert.equal(dependent.runtime_context_json.last_error, "Dependency #999 is missing");
    assert.equal(history.some((entry) => entry.event_type === "dependency_blocked"), true);
    assert.equal(projectSyncs.at(-1)?.fields?.Status, "Blocked");
    assert.equal(projectSyncs.at(-1)?.fields?.["Blocked By"], "dependency:999:missing");
    assert.deepEqual(issueProgress.at(-1)?.blockedBy, ["dependency:999:missing"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production orchestrator can sync failed and quarantined Project lifecycle projections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-terminal-project-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:45", {
      lifecycle_state: "failed",
      runtime_context_json: { issue_packet: { issue_number: "45" }, stage_cursor: "implementation", last_error: "terminal failure" },
    }));
    store.createIssue(newIssueSnapshot("github:46", {
      lifecycle_state: "quarantined",
      runtime_context_json: { issue_packet: { issue_number: "46" }, stage_cursor: "implementation", blocked_by: ["operator"] },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    }) as ReturnType<typeof createProductionOrchestrator> & {
      syncProjectIssue(input: { issueId: string }): Promise<void>;
    };

    await orchestrator.syncProjectIssue({ issueId: "github:45" });
    await orchestrator.syncProjectIssue({ issueId: "github:46" });

    assert.deepEqual(projectSyncs.map((sync) => sync.lifecycleState), ["failed", "quarantined"]);
    assert.equal(projectSyncs[0]?.fields?.Status, "Failed");
    assert.equal(projectSyncs[0]?.fields?.["Last Error"], "terminal failure");
    assert.equal(projectSyncs[1]?.fields?.Status, "Blocked");
    assert.equal(projectSyncs[1]?.fields?.["Blocked By"], "operator");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production run cycle syncs terminal Project lifecycle projections once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-terminal-cycle-project-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:47", {
      lifecycle_state: "failed",
      runtime_context_json: { issue_packet: { issue_number: "47" }, stage_cursor: "implementation", last_error: "terminal failure" },
    }));
    store.createIssue(newIssueSnapshot("github:48", {
      lifecycle_state: "quarantined",
      runtime_context_json: { issue_packet: { issue_number: "48" }, stage_cursor: "implementation", blocked_by: ["operator"] },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    assert.deepEqual(projectSyncs.map((sync) => sync.lifecycleState), ["failed", "quarantined"]);
    assert.equal(projectSyncs[0]?.fields?.Status, "Failed");
    assert.equal(projectSyncs[1]?.fields?.Status, "Blocked");
    assert.equal(store.listHistory("github:47").filter((entry) => entry.event_type === "project_projection_synced").length, 1);
    assert.equal(store.listHistory("github:48").filter((entry) => entry.event_type === "project_projection_synced").length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production run cycle gates terminal Project projection retries until retry time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-terminal-retry-project-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  let now = "2026-05-31T00:00:00.000Z";
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return {
        type: "projection_result",
        projection_target: "github_project",
        status: "failed",
        last_error: "project outage",
        next_retry_at: "2026-05-31T00:05:00.000Z",
        mutates_lifecycle: false,
      };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:49", {
      lifecycle_state: "failed",
      runtime_context_json: { issue_packet: { issue_number: "49" }, stage_cursor: "implementation", last_error: "terminal failure" },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => now,
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    now = "2026-05-31T00:05:01.000Z";
    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    assert.deepEqual(projectSyncs.map((sync) => sync.lifecycleState), ["failed", "failed"]);
    assert.equal(store.getIssue("github:49").lifecycle_state, "failed");
    assert.equal(store.listHistory("github:49").filter((entry) => entry.event_type === "projection_failed").length, 2);
    assert.equal(store.listHistory("github:49").filter((entry) => entry.event_type === "project_projection_retry_scheduled").length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production run cycle gates thrown terminal Project projection retries until retry time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-terminal-throw-project-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  let now = "2026-05-31T00:00:00.000Z";
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      throw new Error("project transport down");
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:50", {
      lifecycle_state: "quarantined",
      runtime_context_json: { issue_packet: { issue_number: "50" }, stage_cursor: "implementation", blocked_by: ["operator"] },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => now,
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    assert.deepEqual(projectSyncs.map((sync) => sync.lifecycleState), ["quarantined"]);
    assert.equal(store.getIssue("github:50").lifecycle_state, "quarantined");
    assert.equal(store.listHistory("github:50").filter((entry) => entry.event_type === "projection_failed").length, 1);
    assert.equal(store.listHistory("github:50").filter((entry) => entry.event_type === "project_projection_retry_scheduled").length, 1);

    now = "2026-05-31T00:01:01.000Z";
    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    assert.deepEqual(projectSyncs.map((sync) => sync.lifecycleState), ["quarantined", "quarantined"]);
    assert.equal(store.getIssue("github:50").lifecycle_state, "quarantined");
    assert.equal(store.listHistory("github:50").filter((entry) => entry.event_type === "projection_failed").length, 2);
    assert.equal(store.listHistory("github:50").filter((entry) => entry.event_type === "project_projection_retry_scheduled").length, 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production run cycle retries completed Project projection until evidence is synced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-completed-retry-project-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  let now = "2026-05-31T00:00:00.000Z";
  let attempts = 0;
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      attempts += 1;
      if (attempts === 1) {
        return {
          type: "projection_result",
          projection_target: "github_project",
          status: "failed",
          last_error: "project temporarily missing item",
          next_retry_at: "2026-05-31T00:01:00.000Z",
          mutates_lifecycle: false,
        };
      }
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:51", {
      lifecycle_state: "completed",
      runtime_context_json: {
        issue_packet: { issue_number: "51" },
        stage_cursor: "release",
        pr: { prUrl: "https://github.test/owner/repo/pull/51" },
        release: { merge_sha: "merge-51" },
      },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => now,
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    now = "2026-05-31T00:01:01.000Z";
    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    assert.deepEqual(projectSyncs.map((sync) => sync.lifecycleState), ["completed", "completed"]);
    assert.equal(projectSyncs[1]?.fields?.Status, "Done");
    assert.equal(projectSyncs[1]?.fields?.["PR URL"], "https://github.test/owner/repo/pull/51");
    assert.equal(projectSyncs[1]?.fields?.["Merge SHA"], "merge-51");
    assert.equal(store.getIssue("github:51").lifecycle_state, "completed");
    assert.equal(store.listHistory("github:51").filter((entry) => entry.event_type === "project_projection_synced").length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile on completed issue repairs projection without re-running worker or PR creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-completed-repair-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:52", {
      lifecycle_state: "completed",
      runtime_context_json: {
        issue_packet: { issue_number: "52" },
        stage_cursor: "release",
        pr: { prUrl: "https://github.test/owner/repo/pull/52", prNumber: 52 },
        release: { merge_sha: "merge-52" },
      },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    }) as ReturnType<typeof createProductionOrchestrator> & {
      reconcileIssue(input: { issueId: string }): Promise<{ next_action?: string }>;
    };

    const result = await orchestrator.reconcileIssue({ issueId: "github:52" });

    assert.equal(result.next_action, "projection_repaired");
    assert.deepEqual(projectSyncs.map((sync) => sync.lifecycleState), ["completed"]);
    assert.equal(store.getIssue("github:52").lifecycle_state, "completed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retry-sync repairs completed issue progress labels and Project projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-retry-sync-completed-observability-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const progressSyncs: string[] = [];
  const projectSyncs: string[] = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress(input) {
      progressSyncs.push(input.lifecycleState);
      return { status: "success", projection_target: "github_observability", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input.lifecycleState);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:54", {
      lifecycle_state: "completed",
      runtime_context_json: {
        issue_packet: { issue_number: "54" },
        stage_cursor: "release",
        pr: { prUrl: "https://github.test/owner/repo/pull/54", prNumber: 54 },
        release: { merge_sha: "merge-54" },
      },
    }));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    }) as ReturnType<typeof createProductionOrchestrator> & {
      retrySyncIssue(input: { issueId: string }): Promise<{ synced: string[]; skipped: string[]; failed: string[] }>;
    };

    const result = await orchestrator.retrySyncIssue({ issueId: "github:54" });

    assert.deepEqual(progressSyncs, ["completed"]);
    assert.deepEqual(projectSyncs, ["completed"]);
    assert.deepEqual(result.synced.sort(), ["github_observability", "github_project"]);
    assert.deepEqual(result.failed, []);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle reconciles externally merged issue to completed without dispatching duplicate PR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-reconcile-external-merge-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:53", {
      lifecycle_state: "ready",
      runtime_context_json: {
        issue_packet: {
          issue_number: "53",
          title: "Already merged",
          raw_text: "Already closed by a merged PR",
          source_url: "https://github.test/owner/repo/issues/53",
        },
        stage_cursor: "implementation",
      },
    }));
    const domain = new ExternallyCompletedDomainDriver();
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    const cycle = await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    const snapshot = store.getIssue("github:53");
    assert.equal(snapshot.lifecycle_state, "completed");
    assert.equal((snapshot.runtime_context_json.pr as { prNumber?: number }).prNumber, 99);
    assert.equal((snapshot.runtime_context_json.release as { merge_sha?: string }).merge_sha, "external-merge-99");
    assert.equal(domain.dispatches, 0);
    assert.equal(cycle.effectsStarted, 0);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "completed");
    assert.equal(projectSyncs.at(-1)?.fields?.["PR URL"], "https://github.test/owner/repo/pull/99");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle refreshes PR metadata for already completed issue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-refresh-completed-pr-metadata-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { type: "projection_result", projection_target: "github_project", status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(newIssueSnapshot("github:60", {
      lifecycle_state: "completed",
      runtime_context_json: {
        issue_packet: {
          issue_number: "60",
          title: "Completed but stale PR metadata",
          raw_text: "Completion metadata should refresh",
          source_url: "https://github.test/owner/repo/issues/60",
        },
        stage_cursor: "release",
        pr: {
          prNumber: 60,
          prUrl: "https://github.test/owner/repo/pull/60",
          branch: "northstar/issue-60",
          commitSha: "stale-head-60",
          headCommit: "stale-head-60",
        },
        release: { merge_sha: "merge-60" },
      },
    }));

    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ExternallyCompletedDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-31T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      projectId: "PVT_project_1",
    });

    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    const snapshot = store.getIssue("github:60");
    const history = store.listHistory("github:60");

    assert.equal(snapshot.lifecycle_state, "completed");
    assert.equal((snapshot.runtime_context_json.pr as { prNumber?: number }).prNumber, 99);
    assert.equal((snapshot.runtime_context_json.pr as { commitSha?: string }).commitSha, "external-head-99");
    assert.equal(projectSyncs.at(-1)?.fields?.["PR URL"], "https://github.test/owner/repo/pull/99");
    assert.equal(history.some((entry) => entry.event_type === "pull_request_recorded"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle releases expired active owner lease before worker reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-expired-active-lease-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(50));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:20:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    const firstCycle = await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    const retried = store.getIssue("github:50");
    const firstHistory = store.listHistory("github:50");

    assert.equal(retried.lifecycle_state, "ready");
    assert.equal(retried.current_session_id, undefined);
    assert.equal(retried.runtime_context_json.owner_lease, undefined);
    assert.equal(retried.runtime_context_json.stage_cursor, "implementation");
    assert.deepEqual(retried.runtime_context_json.child_runs, []);
    assert.equal(retried.runtime_context_json.exception?.resolved_action, "retry_same_stage");
    assert.equal(firstCycle.effectsStarted, 0);
    assert.equal(firstHistory.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "release_active_runtime_ownership" &&
      entry.payload.reason_code === "active_issue_invalid_owner_lease" &&
      Array.isArray(entry.payload.violations) &&
      entry.payload.violations.includes("active_issue_expired_owner_lease")
    ), true);

    assert.equal(projectSyncs.at(-1)?.lifecycleState, "ready");
    assert.equal(projectSyncs.at(-1)?.fields?.Status, "Todo");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle releases running issue missing expected child run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-missing-child-run-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    const snapshot = runningIssueSnapshot(60);
    snapshot.runtime_context_json.child_runs = [];
    store.createIssue(snapshot);
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:20:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    const firstCycle = await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });
    const retried = store.getIssue("github:60");
    const firstHistory = store.listHistory("github:60");

    assert.equal(retried.lifecycle_state, "ready");
    assert.equal(retried.runtime_context_json.owner_lease, undefined);
    assert.equal(retried.current_session_id, undefined);
    assert.deepEqual(retried.runtime_context_json.child_runs, []);
    assert.equal(retried.runtime_context_json.exception?.resolved_action, "retry_same_stage");
    assert.equal(firstCycle.effectsStarted, 0);
    assert.equal(firstHistory.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "release_active_runtime_ownership" &&
      entry.payload.reason_code === "active_issue_missing_child_run"
    ), true);

    assert.equal(projectSyncs.at(-1)?.lifecycleState, "ready");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle reconciles a planned stage root before treating it as missing host liveness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-planned-root-reconcile-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    const host = new QueuedHostSessionBridge();
    const domain = new FakeDomainDriver();
    const orchestrator = createProductionOrchestrator({
      store,
      host,
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    await orchestrator.intakeIssue({
      issueNumber: 83,
      title: "Planned root regression",
      body: "Build a tracer bullet",
      sourceUrl: "https://github.test/issues/83",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:83" });

    const cycle = await orchestrator.runCycle({ autoRelease: false, maxStarts: 1 });
    const snapshot = store.getIssue("github:83");
    const history = store.listHistory("github:83");

    assert.equal(cycle.effectsStarted, 0);
    assert.equal(snapshot.lifecycle_state, "verified");
    assert.equal(history.some((entry) => entry.event_type === "child_artifact_received"), true);
    assert.equal(history.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "release_active_runtime_ownership" &&
      entry.payload.reason_code === "host_liveness_lost"
    ), false);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "verified");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle reconciles external merge before host liveness recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-external-before-host-quarantine-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(82));
    const domain = new ExternallyCompletedDomainDriver();
    const orchestrator = createProductionOrchestrator({
      store,
      host: new MissingRootHost(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:05:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    const cycle = await orchestrator.runCycle({ autoRelease: false, maxStarts: 1 });
    const completed = store.getIssue("github:82");
    const history = store.listHistory("github:82");

    assert.equal(completed.lifecycle_state, "completed");
    assert.equal((completed.runtime_context_json.release as { merge_sha?: string }).merge_sha, "external-merge-99");
    assert.equal(cycle.effectsStarted, 0);
    assert.equal(history.some((entry) => entry.event_type === "external_merge_detected"), true);
    assert.equal(history.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "quarantine_active_issue_missing_host_process"
    ), false);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "completed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle releases running issue when host root session is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-missing-host-root-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const progressEvents: string[] = [];
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(80));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new MissingRootHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:05:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
      progress: async (event) => {
        progressEvents.push(event.event);
      },
    });

    const firstCycle = await orchestrator.runCycle({ autoRelease: false, maxStarts: 1 });
    const retried = store.getIssue("github:80");
    const firstHistory = store.listHistory("github:80");

    assert.equal(retried.lifecycle_state, "ready");
    assert.equal(retried.runtime_context_json.owner_lease, undefined);
    assert.equal(retried.current_session_id, undefined);
    assert.deepEqual(retried.runtime_context_json.child_runs, []);
    assert.equal(retried.runtime_context_json.exception?.resolved_action, "retry_same_stage");
    assert.equal(firstCycle.effectsStarted, 0);
    assert.equal(firstHistory.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "release_active_runtime_ownership" &&
      entry.payload.reason_code === "host_liveness_lost" &&
      entry.payload.host_component === "root"
    ), true);
    assert.equal(progressEvents.includes("runtime_invariant_repair"), true);

    assert.equal(projectSyncs.at(-1)?.lifecycleState, "ready");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle releases running issue when expected child process is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-missing-host-child-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(81));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new MissingChildHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:05:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    const firstCycle = await orchestrator.runCycle({ autoRelease: false, maxStarts: 1 });
    const retried = store.getIssue("github:81");
    const firstHistory = store.listHistory("github:81");

    assert.equal(retried.lifecycle_state, "ready");
    assert.equal(retried.runtime_context_json.owner_lease, undefined);
    assert.equal(retried.current_session_id, undefined);
    assert.deepEqual(retried.runtime_context_json.child_runs, []);
    assert.equal(retried.runtime_context_json.exception?.resolved_action, "retry_same_stage");
    assert.equal(firstCycle.effectsStarted, 0);
    assert.equal(firstHistory.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "release_active_runtime_ownership" &&
      entry.payload.reason_code === "host_liveness_lost" &&
      entry.payload.host_component === "child"
    ), true);

    assert.equal(projectSyncs.at(-1)?.lifecycleState, "ready");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production orchestrator heartbeats only the reconciled owner lease while worker reconciliation is in flight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-worker-heartbeat-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(53));
    store.createIssue(runningIssueSnapshot(54));
    let tick = 0;
    const heartbeatGate = new Promise<void>((resolve, reject) => {
      const poll = setInterval(() => {
        const issue53Heartbeat = store.listHistory("github:53").some((entry) => entry.event_type === "owner_heartbeat");
        if (issue53Heartbeat) {
          clearInterval(poll);
          clearTimeout(timeout);
          resolve();
        }
      }, 1);
      const timeout = setTimeout(() => {
        clearInterval(poll);
        reject(new Error("owner heartbeat was not recorded while worker was in flight"));
      }, 50);
    });
    const domain = new BlockingFinalizeDomainDriver(heartbeatGate);
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => new Date(Date.parse("2026-06-02T00:00:00.000Z") + tick++ * 60_000).toISOString(),
      leaseTimeoutSeconds: 600,
      heartbeatIntervalSeconds: 0.001,
      roleOverrides: {},
      observability,
    });

    await orchestrator.reconcileIssue({ issueId: "github:53" });
    const history53 = store.listHistory("github:53");
    const history54 = store.listHistory("github:54");
    const snapshot53 = store.getIssue("github:53");
    const snapshot54 = store.getIssue("github:54");

    assert.equal(domain.finalizeCalls, 1);
    assert.equal(history53.some((entry) => entry.event_type === "owner_heartbeat"), true);
    assert.equal(history54.some((entry) => entry.event_type === "owner_heartbeat"), false);
    assert.equal(history53.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "quarantine_active_issue_without_valid_lease"
    ), false);
    assert.equal(history54.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "quarantine_active_issue_without_valid_lease"
    ), false);
    assert.equal(snapshot53.lifecycle_state, "verified");
    assert.equal(snapshot54.lifecycle_state, "running");
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "verified");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run cycle preserves active ownership on unknown host liveness and records retryable evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-unknown-host-liveness-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(81));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new UnknownRootHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:05:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    const cycle = await orchestrator.runCycle({ autoRelease: false, maxStarts: 1 });
    const snapshot = store.getIssue("github:81");
    const history = store.listHistory("github:81");

    assert.equal(cycle.effectsStarted, 0);
    assert.equal(snapshot.lifecycle_state, "running");
    assert.equal(snapshot.runtime_context_json.owner_lease?.lease_id, "lease-implementation-github:81");
    assert.equal(snapshot.current_session_id, "root-81");
    assert.equal(snapshot.runtime_context_json.child_runs?.[0]?.status, "running");
    assert.equal(history.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "host_liveness_check_failed" &&
      entry.payload.host_status === "unknown"
    ), true);
    assert.equal(history.some((entry) =>
      entry.event_type === "admin_action" &&
      entry.payload.action === "release_active_runtime_ownership"
    ), false);
    assert.equal(projectSyncs.at(-1)?.lifecycleState, "running");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production run cycle reconciles active issues concurrently within capacity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-watch-active-parallel-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));

  try {
    store.createIssue(runningIssueSnapshot(53));
    store.createIssue(runningIssueSnapshot(54));
    const domain = new ParallelFinalizeDomainDriver();
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      heartbeatIntervalSeconds: 0.001,
      roleOverrides: {},
    });

    const cycle = orchestrator.runCycle({ autoRelease: false, maxStarts: 2 });
    await domain.waitForFinalize("github:53");
    const issue54StartedBeforeIssue53Released = await domain.waitForFinalizeWithin("github:54", 50);
    domain.release("github:53");
    await domain.waitForFinalize("github:54");
    domain.release("github:54");
    await cycle;

    assert.equal(issue54StartedBeforeIssue53Released, true);
    assert.deepEqual(domain.finalizeOrder.sort(), ["github:53", "github:54"]);
    assert.equal(store.getIssue("github:53").lifecycle_state, "verified");
    assert.equal(store.getIssue("github:54").lifecycle_state, "verified");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("start issue skips already active runtime without preparing duplicate worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-start-active-skip-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const projectSyncs: Array<{ issueNumber: number; lifecycleState: string; fields?: Record<string, unknown> }> = [];
  const observability: ProductionObservability = {
    async trySyncIssueProgress() {
      return { status: "success", mutates_lifecycle: false };
    },
    async syncProjectFields(input) {
      projectSyncs.push(input);
      return { status: "success", mutates_lifecycle: false };
    },
  };

  try {
    store.createIssue(runningIssueSnapshot(62));
    const orchestrator = createProductionOrchestrator({
      store,
      host: new DeterministicHost(),
      domain: new ThrowingDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-06-02T00:20:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability,
    });

    const snapshot = await orchestrator.startIssue({ issueId: "github:62" });
    const history = store.listHistory("github:62");

    assert.equal(snapshot.lifecycle_state, "running");
    assert.equal(history.filter((entry) => entry.event_type === "child_run_started").length, 0);
    assert.equal(projectSyncs.length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class DeterministicHost implements HostAdapter {
  private root = 0;
  private child = 0;

  startRootSession(_request: StartRootSessionRequest) {
    this.root += 1;
    return { root_session_id: `root-${this.root}` };
  }

  recordHeartbeat() {
    return { status: "recorded" as const };
  }

  startBackgroundChild(request: StartBackgroundChildRequest) {
    this.child += 1;
    return {
      child_run_id: `child-${this.child}`,
      root_session_id: request.root_session_id,
      session_id: `session-${this.child}`,
      status: "running" as const,
      agent: "test",
      load_skills: [],
    };
  }

  readRootStatus() {
    return { status: "live" as const };
  }

  readChildStatus() {
    return { status: "running" };
  }

  resumeHint(rootSessionId: string) {
    return `resume ${rootSessionId}`;
  }

  capabilities() {
    return ["test"];
  }
}

class ThrowingDomainDriver extends FakeDomainDriver {
  override async prepareStage(): Promise<never> {
    throw new Error("domain driver should not be called");
  }

  override async finalizeWorkerArtifact(): Promise<never> {
    throw new Error("domain driver should not be called");
  }

  override async releaseVerifiedItem(): Promise<never> {
    throw new Error("domain driver should not be called");
  }
}

class BlockingFinalizeDomainDriver extends FakeDomainDriver {
  finalizeCalls = 0;
  private readonly gate: Promise<void>;

  constructor(gate: Promise<void>) {
    super();
    this.gate = gate;
  }

  override async finalizeWorkerArtifact() {
    this.finalizeCalls += 1;
    await this.gate;
    return {
      prNumber: 53,
      prUrl: "https://github.test/owner/repo/pull/53",
      branch: "northstar/issue-53",
      commitSha: "head-53",
    };
  }
}

class ParallelFinalizeDomainDriver extends FakeDomainDriver {
  readonly finalizeOrder: string[] = [];
  private readonly waiters = new Map<string, () => void>();
  private readonly releases = new Map<string, () => void>();

  override async finalizeWorkerArtifact(input: DomainDriverContext) {
    const issueId = input.issue.id;
    this.finalizeOrder.push(issueId);
    this.waiters.get(issueId)?.();
    await new Promise<void>((resolve) => {
      this.releases.set(issueId, resolve);
    });
    const issueNumber = input.issue.number;
    return {
      prNumber: issueNumber,
      prUrl: `https://github.test/owner/repo/pull/${issueNumber}`,
      branch: `northstar/issue-${issueNumber}`,
      commitSha: `head-${issueNumber}`,
    };
  }

  async waitForFinalize(issueId: string): Promise<void> {
    if (this.finalizeOrder.includes(issueId)) return;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.waiters.set(issueId, resolve);
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`${issueId} finalize was not started concurrently`)), 50);
      }),
    ]);
  }

  async waitForFinalizeWithin(issueId: string, timeoutMs: number): Promise<boolean> {
    if (this.finalizeOrder.includes(issueId)) return true;
    return await Promise.race([
      new Promise<boolean>((resolve) => {
        this.waiters.set(issueId, () => resolve(true));
      }),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  }

  release(issueId: string): void {
    this.releases.get(issueId)?.();
  }
}

class ExternallyCompletedDomainDriver extends ThrowingDomainDriver {
  dispatches = 0;
  syncRefreshes = 0;

  async reconcileExternalCompletion(input: DomainDriverContext) {
    return {
      completed: true,
      prNumber: 99,
      prUrl: "https://github.test/owner/repo/pull/99",
      branch: `northstar/issue-${input.issue.number}`,
      commitSha: "external-head-99",
      mergeSha: "external-merge-99",
    };
  }

  async refreshCompletedBase() {
    this.syncRefreshes += 1;
    return {
      status: "synced" as const,
      path: "/repo/.northstar/runtime/sync-worktrees/main",
      headCommit: "external-merge-99",
      expectedCommit: "external-merge-99",
    };
  }
}

class FakeIssueSourceState {
  private readonly states: Record<number, {
    state: "open" | "closed";
    stateReason?: string;
    closedAt?: string;
  }>;

  constructor(states: Record<number, {
    state: "open" | "closed";
    stateReason?: string;
    closedAt?: string;
  }>) {
    this.states = states;
  }

  async readIssueState(issueNumber: number) {
    return {
      number: issueNumber,
      labels: ["northstar:ready"],
      ...(this.states[issueNumber] ?? { state: "open" as const }),
    };
  }
}

class BlockingPrepareDomainDriver extends FakeDomainDriver {
  private readonly prepareGate: Promise<void>;

  constructor(prepareGate: Promise<void>) {
    super();
    this.prepareGate = prepareGate;
  }

  override async prepareStage() {
    await this.prepareGate;
    return {
      worktreePath: "/tmp/northstar/blocking-prepare",
      branch: "northstar/blocking-prepare",
    };
  }
}

class SyncWorktreeFailureDomainDriver extends FakeDomainDriver {
  override async prepareStage(): Promise<never> {
    throw Object.assign(new Error("sync worktree dirty"), { code: "SYNC_WORKTREE_DIRTY" });
  }
}

class RecoverableSyncWorktreeDomainDriver extends FakeDomainDriver {
  blocked = true;

  override async prepareStage() {
    if (this.blocked) throw Object.assign(new Error("sync worktree dirty"), { code: "SYNC_WORKTREE_DIRTY" });
    return {
      worktreePath: "/tmp/northstar/recovered-sync-worktree",
      branch: "northstar/recovered-sync-worktree",
    };
  }

  override async finalizeWorkerArtifact(): Promise<never> {
    throw new Error("finalize should not run while issue is still ready");
  }

  async recoverDispatchBlock() {
    this.blocked = false;
    return { recovered: true };
  }
}

class ReleaseSyncWorktreeFailureDomainDriver extends FakeDomainDriver {
  override async releaseVerifiedItem() {
    return {
      confirmed: true,
      mergeSha: "merge-57",
      syncWorktree: {
        status: "failed" as const,
        path: "/repo/.northstar/runtime/sync-worktrees/main",
        headCommit: "stale-main",
        expectedCommit: "merge-57",
        code: "SYNC_WORKTREE_HEAD_MISMATCH",
        lastError: "sync worktree HEAD stale-main does not match merged main merge-57",
        retryable: true,
      },
    };
  }
}

class ReleaseSyncWorktreeRetryDomainDriver extends FakeDomainDriver {
  syncRefreshes = 0;

  override async releaseVerifiedItem() {
    return {
      confirmed: true,
      mergeSha: "merge-58",
      syncWorktree: {
        status: "failed" as const,
        path: "/repo/.northstar/runtime/sync-worktrees/main",
        headCommit: "stale-main",
        expectedCommit: "merge-58",
        code: "SYNC_WORKTREE_HEAD_MISMATCH",
        lastError: "sync worktree HEAD stale-main does not match merged main merge-58",
        retryable: true,
      },
    };
  }

  async refreshCompletedBase() {
    this.syncRefreshes += 1;
    return {
      status: "synced" as const,
      path: "/repo/.northstar/runtime/sync-worktrees/main",
      headCommit: "merge-58",
      expectedCommit: "merge-58",
    };
  }
}

class VerifierArtifactFailureDomainDriver extends FakeDomainDriver {
  override async finalizeWorkerArtifact(): Promise<never> {
    throw new Error("browser acceptance requires a structured verifier evidence artifact");
  }

  async reconcileExternalCompletion() {
    return undefined;
  }
}

class ImplementationAgentContractFailureDomainDriver extends FakeDomainDriver {
  override async finalizeWorkerArtifact(): Promise<never> {
    throw new Error("agent result issue_number must be 63");
  }
}

class VerifierArtifactFailureThenExternalCompletionDomainDriver extends VerifierArtifactFailureDomainDriver {
  private attempts = 0;

  override async reconcileExternalCompletion() {
    this.attempts += 1;
    if (this.attempts === 1) return undefined;
    return {
      completed: true,
      prNumber: 58,
      prUrl: "https://github.test/owner/repo/pull/58",
      branch: "northstar/issue-58",
      commitSha: "external-head-58",
      mergeSha: "external-merge-58",
    };
  }
}

class ArtifactValidationFailureDomainDriver extends FakeDomainDriver {
  override async finalizeWorkerArtifact(): Promise<never> {
    throw new ArtifactValidationError("ARTIFACT_MISSING_FIELD", "artifact_kind", "artifact_kind must be a non-empty string");
  }
}

class ArtifactValidationFailureWithPrDomainDriver extends FakeDomainDriver {
  override async finalizeWorkerArtifact(): Promise<never> {
    const error = new ArtifactValidationError("ARTIFACT_MISSING_FIELD", "artifact_kind", "artifact_kind must be a non-empty string") as ArtifactValidationError & {
      pullRequest: { prNumber: number; prUrl: string; branch: string; commitSha: string };
    };
    error.pullRequest = {
      prNumber: 41,
      prUrl: "https://github.test/owner/repo/pull/41",
      branch: "northstar/issue-61",
      commitSha: "head-41",
    };
    throw error;
  }
}

class DomainArtifactPayloadDriver extends FakeDomainDriver {
  override async finalizeWorkerArtifact() {
    return {
      prNumber: 62,
      prUrl: "https://github.test/owner/repo/pull/62",
      branch: "northstar/issue-62",
      commitSha: "domain-head-62",
      workerArtifact: {
        schema_version: "1.0",
        artifact_kind: "worker_result",
        issue_number: 62,
        role: "implementation_agent",
        status: "success",
        observed_at: "2026-06-02T00:00:00.000Z",
        summary: "implementation complete",
        retryable: false,
        branch: "northstar/issue-62",
        base_branch: "main",
        commit_sha: "domain-head-62",
        changed_files: ["src/domain-artifact.ts"],
        commands_run: [{ command: "npm test", status: "passed" }],
        test_summary: { passed: 1, failed: 0 },
        self_check_summary: "domain artifact verified",
      },
      verifierArtifact: {
        schema_version: "1.0",
        artifact_kind: "evidence_packet",
        issue_number: 62,
        role: "verifier_agent",
        status: "pass",
        observed_at: "2026-06-02T00:00:00.000Z",
        summary: "verification passed",
        retryable: false,
        pr_number: 62,
        base_branch: "main",
        gate_results: [{ name: "npm test", status: "pass" }],
        verifier: { session_id: "verifier-62" },
      },
    };
  }
}

class RecoveringVerifierArtifactDomainDriver extends FakeDomainDriver {
  async recoverVerifierArtifact(input: DomainDriverContext) {
    const pr = input.runtimeContext.pr as { prNumber: number; prUrl: string; branch: string; commitSha: string };
    return {
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      branch: pr.branch,
      commitSha: pr.commitSha,
    };
  }
}

class ThrowingHost implements HostAdapter {
  startRootSession(): never {
    throw new Error("host dispatch should not start when sync worktree is blocked");
  }

  startBackgroundChild(): never {
    throw new Error("host dispatch should not start when sync worktree is blocked");
  }

  recordHeartbeat() {
    return { status: "recorded" as const };
  }

  readRootStatus() {
    return { status: "missing" as const };
  }

  readChildStatus() {
    return { status: "missing" };
  }

  resumeHint(rootSessionId: string) {
    return `resume ${rootSessionId}`;
  }

  capabilities() {
    return ["test"];
  }
}

class MissingRootHost implements HostAdapter {
  startRootSession(): never {
    throw new Error("host dispatch should not start when root session is missing");
  }

  startBackgroundChild(): never {
    throw new Error("host dispatch should not start when root session is missing");
  }

  recordHeartbeat(): { status: "recorded" } {
    return { status: "recorded" };
  }

  readRootStatus(_root_session_id: string) {
    return { status: "missing" as const };
  }

  readChildStatus() {
    return { status: "running" };
  }

  resumeHint(rootSessionId: string) {
    return `resume ${rootSessionId}`;
  }

  capabilities() {
    return ["test"];
  }
}

class UnknownRootHost implements HostAdapter {
  startRootSession(): never {
    throw new Error("host dispatch should not start when root liveness is unknown");
  }

  startBackgroundChild(): never {
    throw new Error("host dispatch should not start when root liveness is unknown");
  }

  recordHeartbeat(): { status: "recorded" } {
    return { status: "recorded" };
  }

  readRootStatus(_root_session_id: string) {
    return { status: "unknown" as const };
  }

  readChildStatus() {
    return { status: "running" };
  }

  resumeHint(rootSessionId: string) {
    return `resume ${rootSessionId}`;
  }

  capabilities() {
    return ["test"];
  }
}

class MissingChildHost implements HostAdapter {
  startRootSession(): never {
    throw new Error("host dispatch should not start when child process is missing");
  }

  startBackgroundChild(): never {
    throw new Error("host dispatch should not start when child process is missing");
  }

  recordHeartbeat(): { status: "recorded" } {
    return { status: "recorded" };
  }

  readRootStatus(_root_session_id: string) {
    return { status: "live" as const };
  }

  readChildStatus() {
    return { status: "stopped" };
  }

  resumeHint(rootSessionId: string) {
    return `resume ${rootSessionId}`;
  }

  capabilities() {
    return ["test"];
  }
}

function readyIssue(input: { number: number; title: string }) {
  return {
    issueId: `github:${input.number}`,
    number: input.number,
    title: input.title,
    body: `Body ${input.number}`,
    sourceUrl: `https://github.test/issues/${input.number}`,
    labels: ["northstar:ready"],
    dependencies: [],
    dependencyDiscovery: {
      markerDependencies: [],
      nativeLinkedIssueDependencies: [],
      nativeLinkedIssueDependenciesDiscovered: 0,
      duplicatesRemoved: 0,
      nativeLinkedIssueApiFailureRetryable: 0,
      nativeLinkedIssueApiFailureDoesNotFailLifecycle: 1 as const,
    },
  };
}

function runningIssueSnapshot(issueNumber: number) {
  return newIssueSnapshot(`github:${issueNumber}`, {
    lifecycle_state: "running",
    current_session_id: `root-${issueNumber}`,
    owner_lease: {
      lease_id: `lease-implementation-github:${issueNumber}`,
      root_session_id: `root-${issueNumber}`,
      role: "implementation_agent",
      generation: 1,
      heartbeat_seq: 0,
      last_heartbeat_at: "2026-06-02T00:00:00.000Z",
      expires_at: "2026-06-02T00:10:00.000Z",
    },
    stage_cursor: "implementation",
    child_runs: [{
      child_run_id: `child-${issueNumber}`,
      lease_id: `lease-implementation-github:${issueNumber}`,
      root_session_id: `root-${issueNumber}`,
      role: "implementation_agent",
      status: "running",
      session_id: `session-${issueNumber}`,
      started_at: "2026-06-02T00:00:00.000Z",
      last_seen_at: "2026-06-02T00:00:00.000Z",
    }],
    runtime_context_json: {
      issue_packet: {
        issue_number: String(issueNumber),
        title: `Verifier artifact issue ${issueNumber}`,
        raw_text: "Browser evidence malformed after worker finished",
        source_url: `https://github.test/owner/repo/issues/${issueNumber}`,
      },
      branch: `northstar/issue-${issueNumber}`,
    },
    worktree_path: `/repo/.northstar/runtime/worktrees/issue-${issueNumber}`,
  });
}

async function waitForProgress(events: string[], event: string): Promise<void> {
  for (let index = 0; index < 10; index++) {
    if (events.includes(event)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
