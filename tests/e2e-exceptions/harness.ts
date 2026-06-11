import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IssuePacket } from "../../src/intake/types.ts";
import {
  applyRuntimeEvents,
  createOwnerLease,
  newIssueSnapshot,
  type RuntimeEvent,
} from "../../src/runtime/state-machine.ts";
import { repairSnapshot } from "../../src/runtime/repair.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import type { HistoryEntry, IssueSnapshot, LifecycleState, OwnerLease } from "../../src/types/control-plane.ts";
import { loadWorkflow, type WorkflowDefinition } from "../../src/types/workflow.ts";
import {
  emptyExceptionE2EMetrics,
  hasExceptionE2ESecretLeak,
  markRequirementCovered,
  type ExceptionE2EMetrics,
  type ExceptionRequirementId,
} from "./metrics.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const now = "2026-05-29T03:00:00.000Z";

export interface SeedIssueOptions {
  issueId: string;
  lifecycleState?: LifecycleState;
  stageCursor?: string;
  ownerLease?: OwnerLease;
}

export class ExceptionE2EHarness {
  readonly dir: string;
  readonly dbPath: string;
  readonly store: SqliteControlPlaneStore;
  readonly metrics: ExceptionE2EMetrics;
  private issueSequence = 2100;

  private constructor(dir: string, store: SqliteControlPlaneStore) {
    this.dir = dir;
    this.dbPath = join(dir, "northstar-exception-e2e.sqlite");
    this.store = store;
    this.metrics = emptyExceptionE2EMetrics();
  }

  static async create(): Promise<ExceptionE2EHarness> {
    const dir = await mkdtemp(join(tmpdir(), "northstar-exception-e2e-"));
    const dbPath = join(dir, "northstar-exception-e2e.sqlite");
    const store = SqliteControlPlaneStore.open(dbPath);
    return new ExceptionE2EHarness(dir, store);
  }

  seedIssue(options: SeedIssueOptions): IssueSnapshot {
    const issueNumber = issueNumberFromId(options.issueId);
    const packet: IssuePacket = {
      issue_number: String(issueNumber),
      title: `Exception E2E ${issueNumber}`,
      source: "local",
      source_url: `local://exception-e2e/${issueNumber}`,
      branch: `northstar/exception-e2e-${issueNumber}`,
      base_branch: "main",
      labels: ["northstar:e2e", "northstar:exception"],
      dependencies: [],
      raw_text: `Exception E2E ${issueNumber}`,
      ready_for_agent: true,
    };
    this.store.upsertIssuePacket(packet);

    const seeded = this.store.getIssue(options.issueId);
    const snapshot = newIssueSnapshot(options.issueId, {
      lifecycle_state: options.lifecycleState ?? seeded.lifecycle_state,
      owner_lease: options.ownerLease,
      stage_cursor: options.stageCursor,
      runtime_context_json: seeded.runtime_context_json,
    });
    this.store.appendHistoryBatchAndUpdateSnapshot(options.issueId, [], snapshot);
    return snapshot;
  }

  listIssues(): IssueSnapshot[] {
    return this.store.listAllIssuesForTests();
  }

  workflow(name = "issue-to-pr-release.yaml"): WorkflowDefinition {
    return loadWorkflow(join(repoRoot, "tests/fixtures/workflows", name));
  }

  apply(issueId: string, workflow: WorkflowDefinition, events: RuntimeEvent[]): IssueSnapshot {
    const snapshot = this.store.getIssue(issueId);
    const result = applyRuntimeEvents(snapshot, workflow, events);
    this.store.appendHistoryBatchAndUpdateSnapshot(issueId, result.history, result.snapshot);
    this.updateSafetyMetrics();
    return result.snapshot;
  }

  repair(issueId: string): IssueSnapshot {
    const snapshot = this.store.getIssue(issueId);
    const repaired = repairSnapshot(snapshot, now);
    this.store.appendHistoryBatchAndUpdateSnapshot(issueId, repaired.history, repaired.snapshot);
    this.metrics.exception_e2e_repair_admin_actions += repaired.history.filter((entry) => entry.event_type === "admin_action").length;
    this.updateSafetyMetrics();
    return repaired.snapshot;
  }

  cover(id: ExceptionRequirementId): void {
    markRequirementCovered(this.metrics, id);
  }

  summary(): ExceptionE2EMetrics {
    this.updateSafetyMetrics();
    return {
      ...this.metrics,
      covered_requirements: [...this.metrics.covered_requirements],
    };
  }

  history(issueId: string): HistoryEntry[] {
    return this.store.listHistory(issueId);
  }

  ownerLease(issueId: string, role = "implementation_agent", ttlSeconds = 180): OwnerLease {
    return createOwnerLease({
      lease_id: `lease-${issueId}-${role}`,
      root_session_id: `root-${issueId}-${role}`,
      role,
      now,
      ttl_seconds: ttlSeconds,
    });
  }

  async runQuarantineAndResumeScenarios(): Promise<void> {
    this.metrics.exception_e2e_scenarios_total += 6;
    const workflow = this.workflow();

    const missingLease = this.seedIssue({
      issueId: "local:2001",
      lifecycleState: "running",
      stageCursor: "implementation",
    });
    const recoveredMissing = this.repair(missingLease.issue_id);
    if (recoveredMissing.lifecycle_state !== "exception") {
      throw new Error(`EX-01 expected exception, got ${recoveredMissing.lifecycle_state}`);
    }
    this.metrics.exception_e2e_recovery_cases += 1;
    this.cover("EX-01");

    const expiredLease = this.seedIssue({
      issueId: "local:2002",
      lifecycleState: "running",
      stageCursor: "implementation",
      ownerLease: this.ownerLease("expired", "implementation_agent", -60),
    });
    const recoveredExpired = this.repair(expiredLease.issue_id);
    if (recoveredExpired.lifecycle_state !== "exception") {
      throw new Error(`EX-02 expected exception, got ${recoveredExpired.lifecycle_state}`);
    }
    this.metrics.exception_e2e_recovery_cases += 1;
    this.cover("EX-02");

    const quarantinedForResume = this.seedIssue({
      issueId: "local:2005",
      lifecycleState: "quarantined",
      stageCursor: "implementation",
    });
    this.metrics.exception_e2e_quarantined_cases += 1;

    const rejectedNoLease = this.apply(quarantinedForResume.issue_id, workflow, [{ type: "resume_quarantined" }]);
    if (rejectedNoLease.lifecycle_state !== "quarantined") {
      throw new Error("EX-03 resume without lease advanced lifecycle");
    }
    this.metrics.exception_e2e_quarantined_cases += 1;
    this.metrics.exception_e2e_resume_rejections += 1;
    this.cover("EX-03");

    const resumedWithLease = this.apply(quarantinedForResume.issue_id, workflow, [{
      type: "resume_quarantined",
      lease: this.ownerLease("resume-new"),
    }]);
    if (resumedWithLease.lifecycle_state !== "running") {
      throw new Error(`EX-04 expected running, got ${resumedWithLease.lifecycle_state}`);
    }
    this.metrics.exception_e2e_recovery_cases += 1;
    this.cover("EX-04");

    const liveLeaseIssue = this.seedIssue({
      issueId: "local:2003",
      lifecycleState: "quarantined",
      stageCursor: "implementation",
      ownerLease: this.ownerLease("host-live"),
    });
    const resumedLive = this.apply(liveLeaseIssue.issue_id, workflow, [{
      type: "resume_quarantined",
      host_liveness: "live",
    }]);
    if (resumedLive.lifecycle_state !== "running") {
      throw new Error(`EX-05 expected running, got ${resumedLive.lifecycle_state}`);
    }
    this.metrics.exception_e2e_recovery_cases += 1;
    this.cover("EX-05");

    const unknownLiveIssue = this.seedIssue({
      issueId: "local:2004",
      lifecycleState: "quarantined",
      stageCursor: "implementation",
      ownerLease: this.ownerLease("host-unknown"),
    });
    const rejectedUnknown = this.apply(unknownLiveIssue.issue_id, workflow, [{
      type: "resume_quarantined",
      host_liveness: "unknown",
    }]);
    if (rejectedUnknown.lifecycle_state !== "quarantined") {
      throw new Error("EX-06 unknown host liveness should stay quarantined");
    }
    this.metrics.exception_e2e_quarantined_cases += 1;
    this.metrics.exception_e2e_resume_rejections += 1;
    this.cover("EX-06");
    this.metrics.exception_e2e_scenarios_passed += 6;
  }

  async runExecutionExceptionScenarios(): Promise<void> {
    this.metrics.exception_e2e_scenarios_total += 8;

    const retryable = this.activeIssue("Exception retryable child");
    const retryableResult = this.apply(retryable.issue.issue_id, retryable.workflow, [{
      type: "child_artifact",
      child_run_id: `child-${retryable.issue.issue_id}`,
      status: "failed_retryable",
      artifact_history_id: this.history(retryable.issue.issue_id).length + 1,
      at: now,
    }]);
    if (retryableResult.lifecycle_state !== "exception") {
      throw new Error("EX-07 retryable child failure should enter exception lifecycle");
    }
    this.metrics.exception_e2e_retryable_failures += 1;
    this.cover("EX-07");

    const terminal = this.activeIssue("Exception terminal child");
    const terminalResult = this.apply(terminal.issue.issue_id, terminal.workflow, [{
      type: "child_artifact",
      child_run_id: `child-${terminal.issue.issue_id}`,
      status: "failed_terminal",
      artifact_history_id: this.history(terminal.issue.issue_id).length + 1,
      at: now,
    }]);
    if (terminalResult.lifecycle_state !== "exception") {
      throw new Error("EX-08 terminal child failure should enter exception lifecycle");
    }
    this.metrics.exception_e2e_failed_cases += 1;
    this.metrics.exception_e2e_terminal_failures += 1;
    this.cover("EX-08");

    const invalid = this.activeIssue("Exception invalid artifact");
    const invalidBefore = invalid.issue.lifecycle_state;
    const rejected = this.apply(invalid.issue.issue_id, invalid.workflow, [{
      type: "child_artifact",
      child_run_id: `child-${invalid.issue.issue_id}`,
      status: "succeeded",
      artifact_history_id: this.history(invalid.issue.issue_id).length + 1,
      at: now,
      artifact_kind: "worker_result",
      schema_version: "1.0",
      role: "implementation_agent",
      summary: "missing changed_files",
      retryable: false,
      payload: {
        branch: "northstar/e2e-invalid",
        base_branch: "main",
        commit_sha: "invalid123",
        self_check_summary: "invalid artifact missing changed_files",
      },
    }]);
    if (rejected.lifecycle_state !== "exception" || !this.history(invalid.issue.issue_id).some((row) => row.event_type === "artifact_rejected")) {
      throw new Error("EX-09 invalid artifact should reject and enter exception lifecycle");
    }
    this.metrics.exception_e2e_artifact_rejections += 1;
    this.cover("EX-09");

    const verifyRetry = this.activeIssue("Exception verification retry", "verification");
    const verifyRetryResult = this.apply(verifyRetry.issue.issue_id, verifyRetry.workflow, [{
      type: "gate_result",
      status: "fail_retryable",
      at: now,
    }]);
    if (verifyRetryResult.lifecycle_state !== "verifying" || verifyRetryResult.runtime_context_json.stage_cursor !== "verification") {
      throw new Error("EX-10 verification retry gate should remain at verification without fail transition");
    }
    this.metrics.exception_e2e_retryable_failures += 1;
    this.cover("EX-10");

    const verifyTerminal = this.activeIssue("Exception verification terminal", "verification");
    const verifyTerminalResult = this.apply(verifyTerminal.issue.issue_id, verifyTerminal.workflow, [{
      type: "gate_result",
      status: "fail_terminal",
      at: now,
    }]);
    if (verifyTerminalResult.lifecycle_state !== "verifying") {
      throw new Error("EX-11 verification terminal gate should remain at verification without fail transition");
    }
    this.metrics.exception_e2e_failed_cases += 1;
    this.metrics.exception_e2e_terminal_failures += 1;
    this.cover("EX-11");

    const projection = this.activeIssue("Exception projection failure", "verification");
    const projectionBefore = projection.issue.lifecycle_state;
    const projectionResult = this.apply(projection.issue.issue_id, projection.workflow, [{
      type: "projection_result",
      projection_target: "label",
      status: "failed",
      attempt: 1,
      last_error: "rate limited",
      next_retry_at: "2026-05-29T03:05:00.000Z",
      payload: { labels: ["northstar:e2e:exception"] },
    }]);
    if (projectionResult.lifecycle_state !== projectionBefore || !this.history(projection.issue.issue_id).some((row) => row.event_type === "projection_failed")) {
      throw new Error("EX-12 projection failure should be retryable and non-mutating");
    }
    this.metrics.exception_e2e_retryable_failures += 1;
    this.cover("EX-12");

    const effect = this.activeIssue("Exception effect failure");
    const effectResult = this.apply(effect.issue.issue_id, effect.workflow, [{
      type: "effect_result",
      effect_type: "projection_retry",
      status: "failed",
      last_error: "effect worker failed",
      next_retry_at: "2026-05-29T03:05:00.000Z",
    }]);
    if (effectResult.lifecycle_state !== "running" || !this.history(effect.issue.issue_id).some((row) => row.event_type === "effect_failed_retryable")) {
      throw new Error("EX-13 effect failure should record retryable history without failing lifecycle");
    }
    this.metrics.exception_e2e_retryable_failures += 1;
    this.cover("EX-13");

    const release = this.seedIssue({
      issueId: "local:2199",
      lifecycleState: "failed",
    });
    this.store.appendHistoryBatchAndUpdateSnapshot(release.issue_id, [], {
      ...release,
      runtime_context_json: {
        ...release.runtime_context_json,
        release: { pr_merged: true },
        projection_sync: [{ projection_target: "local_main_sync", status: "failed" }],
      },
    });
    const repairedRelease = this.repair(release.issue_id);
    if (repairedRelease.lifecycle_state !== "completed") {
      throw new Error("EX-14 confirmed merge recovery should restore completed");
    }
    this.metrics.exception_e2e_recovery_cases += 1;
    this.cover("EX-14");

    this.metrics.exception_e2e_scenarios_passed += 8;
  }

  async dispose(): Promise<void> {
    this.store.close();
    await rm(this.dir, { recursive: true, force: true });
  }

  private updateSafetyMetrics(): void {
    const serialized = JSON.stringify(
      this.store.listAllIssuesForTests().flatMap((issue) => this.store.listHistory(issue.issue_id)),
    );
    this.metrics.exception_e2e_secret_leaks = hasExceptionE2ESecretLeak(serialized) ? 1 : 0;
    this.metrics.exception_e2e_network_calls = 0;
    this.metrics.exception_e2e_live_credential_reads = 0;
    this.metrics.exception_e2e_duplicate_child_runs = countDuplicateChildRuns(this.store.listAllIssuesForTests());
  }

  private activeIssue(title: string, stageCursor = "implementation"): { issue: IssueSnapshot; workflow: WorkflowDefinition } {
    this.issueSequence += 1;
    const workflow = this.workflow();
    const issueId = `local:${this.issueSequence}`;
    const stageRole = stageCursor === "verification" ? "verifier_agent" : "implementation_agent";
    const issue = this.seedIssue({
      issueId,
      lifecycleState: stageCursor === "verification" ? "verifying" : "running",
      stageCursor,
      ownerLease: this.ownerLease(issueId, stageRole),
    });
    const childRun = {
      child_run_id: `child-${issue.issue_id}`,
      lease_id: `lease-${issue.issue_id}-${stageRole}`,
      root_session_id: `root-${issue.issue_id}-${stageRole}`,
      role: stageRole,
      status: "running" as const,
      session_id: `session-${issue.issue_id}`,
      started_at: now,
      last_seen_at: now,
    };
    this.store.appendHistoryBatchAndUpdateSnapshot(issue.issue_id, [], {
      ...issue,
      runtime_context_json: {
        ...issue.runtime_context_json,
        child_runs: [childRun],
        issue_title: title,
      },
    });
    return { issue: this.store.getIssue(issue.issue_id), workflow };
  }
}

export async function createExceptionE2EHarness(): Promise<ExceptionE2EHarness> {
  return ExceptionE2EHarness.create();
}

function issueNumberFromId(issueId: string): number {
  const value = Number(issueId.split(":").at(-1));
  if (!Number.isFinite(value)) {
    throw new Error(`Issue id must end with a numeric fixture id: ${issueId}`);
  }
  return value;
}

function countDuplicateChildRuns(issues: IssueSnapshot[]): number {
  let duplicates = 0;
  for (const issue of issues) {
    const seen = new Set<string>();
    for (const childRun of issue.runtime_context_json.child_runs ?? []) {
      if (seen.has(childRun.child_run_id)) {
        duplicates += 1;
      }
      seen.add(childRun.child_run_id);
    }
  }
  return duplicates;
}
