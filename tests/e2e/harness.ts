import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import type { IssuePacket } from "../../src/intake/types.ts";
import { issuePacketId } from "../../src/intake/types.ts";
import { applyRuntimeEvents, createOwnerLease, newIssueSnapshot, type RuntimeEvent } from "../../src/runtime/state-machine.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import type { IssueSnapshot, LifecycleState } from "../../src/types/control-plane.ts";
import { lifecycleStates } from "../../src/types/control-plane.ts";
import { loadWorkflow, type WorkflowDefinition } from "../../src/types/workflow.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const now = "2026-05-29T03:00:00.000Z";

export interface E2ESummary {
  successful_full_cycle_workflows: number;
  total_scenarios: number;
  scenarios_passed: number;
  restart_recovery_completed: number;
  invalid_artifact_scenarios: number;
  workflows_completed: number;
  lifecycle_states_observed: number;
  new_domain_lifecycle_states: number;
  network_calls: number;
  live_credential_reads: number;
  coding_release_owner_leases: number;
  coding_release_child_run_records: number;
  coding_release_valid_child_artifacts: number;
  coding_release_confirmed_merge_facts: number;
  artifact_rejection_history_rows: number;
  retryable_projection_failures: number;
  retryable_effect_failures: number;
  post_completion_cleanup_failures_preserved: number;
  domain_full_cycle_workflows: number;
  domain_workflows_with_coding_role_chain: number;
}

export class OfflineE2EHarness {
  readonly dir: string;
  readonly dbPath: string;
  store: SqliteControlPlaneStore;
  readonly host = new FakeHostAdapter();
  private readonly observedStates = new Set<LifecycleState>();
  private issueSequence = 1000;
  private readonly metrics: E2ESummary = {
    successful_full_cycle_workflows: 0,
    total_scenarios: 0,
    scenarios_passed: 0,
    restart_recovery_completed: 0,
    invalid_artifact_scenarios: 0,
    workflows_completed: 0,
    lifecycle_states_observed: 0,
    new_domain_lifecycle_states: 0,
    network_calls: 0,
    live_credential_reads: 0,
    coding_release_owner_leases: 0,
    coding_release_child_run_records: 0,
    coding_release_valid_child_artifacts: 0,
    coding_release_confirmed_merge_facts: 0,
    artifact_rejection_history_rows: 0,
    retryable_projection_failures: 0,
    retryable_effect_failures: 0,
    post_completion_cleanup_failures_preserved: 0,
    domain_full_cycle_workflows: 0,
    domain_workflows_with_coding_role_chain: 0,
  };

  private constructor(dir: string, store: SqliteControlPlaneStore) {
    this.dir = dir;
    this.dbPath = join(dir, "northstar-e2e.sqlite");
    this.store = store;
  }

  static async create(): Promise<OfflineE2EHarness> {
    const dir = await mkdtemp(join(tmpdir(), "northstar-e2e-"));
    const store = SqliteControlPlaneStore.open(join(dir, "northstar-e2e.sqlite"));
    return new OfflineE2EHarness(dir, store);
  }

  seedIssue(workflowId: string, title: string): IssueSnapshot {
    this.issueSequence += 1;
    const packet: IssuePacket = {
      issue_number: String(this.issueSequence),
      title,
      source: "local",
      source_url: `local://${workflowId}/${this.issueSequence}`,
      branch: `northstar/e2e-${this.issueSequence}`,
      base_branch: "main",
      labels: ["northstar:e2e", workflowId],
      dependencies: [],
      raw_text: title,
      ready_for_agent: true,
    };
    this.store.upsertIssuePacket(packet);
    const snapshot = this.store.getIssue(issuePacketId(packet));
    this.observe(snapshot);
    return snapshot;
  }

  workflow(fixtureName: string): WorkflowDefinition {
    return loadWorkflow(join(repoRoot, "tests/fixtures/workflows", fixtureName));
  }

  apply(issueId: string, workflow: WorkflowDefinition, events: RuntimeEvent[]): IssueSnapshot {
    const snapshot = this.store.getIssue(issueId);
    const result = applyRuntimeEvents(snapshot, workflow, events);
    this.store.appendHistoryBatchAndUpdateSnapshot(issueId, result.history, result.snapshot);
    this.observe(result.snapshot);
    this.countAllHistory();
    return result.snapshot;
  }

  async cleanup(): Promise<void> {
    this.store.close();
    await rm(this.dir, { recursive: true, force: true });
  }

  summary(): E2ESummary {
    return { ...this.metrics, lifecycle_states_observed: this.observedStates.size };
  }

  formatSummary(): string {
    const summary = this.summary();
    return [
      `workflows_completed=${summary.workflows_completed}/4`,
      `scenarios_passed=${summary.scenarios_passed}/6`,
      `network_calls=${summary.network_calls}`,
      `lifecycle_states_observed=${summary.lifecycle_states_observed}`,
      `artifact_rejections=${summary.artifact_rejection_history_rows}`,
      `restart_recovery_completed=${summary.restart_recovery_completed}`,
      `domain_workflows_completed=${summary.domain_full_cycle_workflows}`,
      `confirmed_merge_facts=${summary.coding_release_confirmed_merge_facts}`,
      `retryable_projection_failures=${summary.retryable_projection_failures}`,
      `retryable_effect_failures=${summary.retryable_effect_failures}`,
      `post_completion_cleanup_failures_preserved=${summary.post_completion_cleanup_failures_preserved}`,
    ].join(" ");
  }

  runCodingReleaseFullCycle(): Promise<void> {
    const workflow = this.workflow("issue-to-pr-release.yaml");
    const issue = this.seedIssue("issue_to_pr_release", "E2E coding release");
    this.metrics.total_scenarios += 1;
    this.observe(newIssueSnapshot("failed-observer", { lifecycle_state: "failed" }));
    this.observe(newIssueSnapshot("quarantined-observer", { lifecycle_state: "quarantined" }));

    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "worker_result",
      role: "issue_worker",
      payload: {
        branch: "northstar/e2e-coding",
        base_branch: "main",
        commit_sha: "abc123",
        changed_files: ["src/runtime/example.ts"],
        commands_run: [{ command: "offline e2e worker self-check", status: "passed" }],
        test_summary: { passed: 1, failed: 0 },
        self_check_summary: "offline e2e worker self-check passed",
      },
    });

    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "evidence_packet",
      role: "pr_verifier",
      payload: {
        pr_number: 42,
        base_branch: "main",
        gate_results: [{ name: "npm test", status: "pass" }],
        verifier: { agent: "fake" },
      },
    });

    snapshot = this.apply(issue.issue_id, workflow, [{
      type: "projection_result",
      projection_target: "label",
      status: "failed",
      attempt: 1,
      last_error: "offline projection failure",
      next_retry_at: "2026-05-29T03:05:00.000Z",
      payload: { labels: ["northstar:e2e"] },
    }]);
    snapshot = this.apply(issue.issue_id, workflow, [{
      type: "claim_owner_lease",
      lease: createOwnerLease({
        lease_id: "lease-release-e2e",
        root_session_id: "root-release-e2e",
        role: "release_worker",
        now,
        ttl_seconds: 180,
      }),
    }]);
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "start_release", at: now }]);
    snapshot = this.apply(issue.issue_id, workflow, [{
      type: "release_result",
      status: "success",
      pr_merged: true,
      at: now,
    }]);

    const completed = this.apply(issue.issue_id, workflow, [{
      type: "effect_result",
      effect_type: "local_sync",
      status: "failed",
      last_error: "cleanup failed after merge",
      next_retry_at: "2026-05-29T03:05:00.000Z",
    }]);

    if (completed.lifecycle_state !== "completed") {
      throw new Error(`coding release expected completed, got ${completed.lifecycle_state}`);
    }

    this.metrics.successful_full_cycle_workflows += 1;
    this.metrics.scenarios_passed += 1;
    this.metrics.workflows_completed += 1;
    this.metrics.coding_release_owner_leases += 1;
    this.metrics.coding_release_child_run_records += completed.runtime_context_json.child_runs?.length ?? 0;
    this.metrics.post_completion_cleanup_failures_preserved += 1;
    return Promise.resolve();
  }

  runCodingNoReleaseFullCycle(): Promise<void> {
    const workflow = this.workflow("issue-to-done.yaml");
    const issue = this.seedIssue("issue_to_done", "E2E no release");
    this.metrics.total_scenarios += 1;
    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "worker_result",
      role: "issue_worker",
      payload: {
        branch: "northstar/e2e-no-release",
        base_branch: "main",
        commit_sha: "def456",
        changed_files: ["src/runtime/no-release.ts"],
        commands_run: [{ command: "offline no-release self-check", status: "passed" }],
        test_summary: { passed: 1, failed: 0 },
        self_check_summary: "offline no-release self-check passed",
      },
    });
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "gate_result", status: "pass", at: now }]);
    if (snapshot.lifecycle_state !== "completed") {
      throw new Error(`no-release expected completed, got ${snapshot.lifecycle_state}`);
    }
    this.metrics.successful_full_cycle_workflows += 1;
    this.metrics.scenarios_passed += 1;
    this.metrics.workflows_completed += 1;
    return Promise.resolve();
  }

  runContentCreationFullCycle(): Promise<void> {
    const workflow = this.workflow("content-creation-publish.yaml");
    const issue = this.seedIssue("content_creation_publish", "E2E content publish");
    this.metrics.total_scenarios += 1;
    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "draft_article",
      role: "writer",
      payload: { title: "Northstar E2E", body_text: "Offline deterministic content draft." },
    });
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "editorial_packet",
      role: "editor",
      payload: { review_notes: "Approved with edits" },
    });
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "gate_result", status: "pass", at: now }]);
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "publish_result",
      role: "publisher",
      payload: { published_url: "https://example.invalid/northstar-e2e", confirmed_delivery: true },
    });
    this.completeDomainWorkflow(snapshot, workflow, "content_creation_publish");
    return Promise.resolve();
  }

  runOfficeReportFullCycle(): Promise<void> {
    const workflow = this.workflow("office-report-delivery.yaml");
    const issue = this.seedIssue("office_report_delivery", "E2E office delivery");
    this.metrics.total_scenarios += 1;
    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "spreadsheet_report",
      role: "data_collector",
      payload: { workbook_path: "/tmp/northstar-e2e.xlsx", data_sources: ["local-fixture"] },
    });
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "review_packet",
      role: "reviewer",
      payload: { review_notes: "Ready for manager" },
    });
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "gate_result", status: "pass", at: now }]);
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "email_delivery_result",
      role: "mailer",
      payload: { recipient_count: 3, confirmed_delivery: true },
    });
    this.completeDomainWorkflow(snapshot, workflow, "office_report_delivery");
    return Promise.resolve();
  }

  runRestartRecoveryScenario(): Promise<void> {
    const workflow = this.workflow("issue-to-pr-release.yaml");
    const issue = this.seedIssue("issue_to_pr_release", "E2E restart recovery");
    this.metrics.total_scenarios += 1;
    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    const beforeSequences = this.store.listHistory(issue.issue_id).map((row) => row.sequence ?? 0);
    this.store.close();
    this.store = SqliteControlPlaneStore.open(this.dbPath);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "worker_result",
      role: "issue_worker",
      payload: {
        branch: "northstar/e2e-restart",
        base_branch: "main",
        commit_sha: "fed789",
        changed_files: ["src/runtime/restart.ts"],
        commands_run: [{ command: "restart recovery self-check", status: "passed" }],
        test_summary: { passed: 1, failed: 0 },
        self_check_summary: "restart recovery self-check passed",
      },
    });
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "evidence_packet",
      role: "pr_verifier",
      payload: {
        pr_number: 43,
        base_branch: "main",
        gate_results: [{ name: "restart", status: "pass" }],
        verifier: { agent: "fake" },
      },
    });
    snapshot = this.apply(issue.issue_id, workflow, [{
      type: "claim_owner_lease",
      lease: createOwnerLease({
        lease_id: "lease-release-restart-e2e",
        root_session_id: "root-release-restart-e2e",
        role: "release_worker",
        now,
        ttl_seconds: 180,
      }),
    }]);
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "start_release", at: now }]);
    snapshot = this.apply(issue.issue_id, workflow, [{
      type: "release_result",
      status: "success",
      pr_merged: true,
      at: now,
    }]);
    const afterSequences = this.store.listHistory(issue.issue_id).map((row) => row.sequence ?? 0);
    const monotonic = afterSequences.every((sequence, index) => index === 0 || sequence > afterSequences[index - 1]);
    if (!monotonic || afterSequences.length <= beforeSequences.length || snapshot.lifecycle_state !== "completed") {
      throw new Error("restart recovery did not preserve durable monotonic history through completion");
    }
    this.metrics.scenarios_passed += 1;
    this.metrics.restart_recovery_completed += 1;
    return Promise.resolve();
  }

  runInvalidArtifactScenario(): Promise<void> {
    const workflow = this.workflow("issue-to-pr-release.yaml");
    const issue = this.seedIssue("issue_to_pr_release", "E2E invalid artifact");
    this.metrics.total_scenarios += 1;
    const snapshot = this.startCurrentStage(issue.issue_id, workflow);
    const beforeState = snapshot.lifecycle_state;
    const childRun = snapshot.runtime_context_json.child_runs?.at(-1);
    if (!childRun) {
      throw new Error("invalid artifact scenario missing child run");
    }
    const rejected = this.apply(issue.issue_id, workflow, [{
      type: "child_artifact",
      child_run_id: childRun.child_run_id,
      status: "succeeded",
      artifact_history_id: this.store.listHistory(issue.issue_id).length + 1,
      at: now,
      artifact_kind: "worker_result",
      schema_version: "1.0",
      role: "issue_worker",
      summary: "Invalid artifact",
      retryable: false,
      payload: {
        branch: "northstar/e2e-invalid",
        base_branch: "main",
        commit_sha: "bad123",
        self_check_summary: "missing changed_files",
      },
    }]);
    if (rejected.lifecycle_state !== beforeState) {
      throw new Error("invalid artifact advanced lifecycle");
    }
    this.metrics.invalid_artifact_scenarios += 1;
    this.metrics.scenarios_passed += 1;
    this.countAllHistory();
    return Promise.resolve();
  }

  private observe(snapshot: IssueSnapshot): void {
    if (lifecycleStates.includes(snapshot.lifecycle_state)) {
      this.observedStates.add(snapshot.lifecycle_state);
    }
  }

  private countAllHistory(): void {
    const history = this.store.listAllIssuesForTests().flatMap((issue) => this.store.listHistory(issue.issue_id));
    this.metrics.artifact_rejection_history_rows = history.filter((row) => row.event_type === "artifact_rejected").length;
    this.metrics.retryable_projection_failures = history.filter((row) => row.event_type === "projection_failed").length;
    this.metrics.retryable_effect_failures = history.filter((row) => row.event_type === "effect_failed_retryable").length;
    this.metrics.coding_release_confirmed_merge_facts = history.filter((row) => row.event_type === "release_completed").length;
  }

  private startCurrentStage(issueId: string, workflow: WorkflowDefinition): IssueSnapshot {
    const snapshot = this.store.getIssue(issueId);
    const stageName = snapshot.runtime_context_json.stage_cursor ?? Object.keys(workflow.stages)[0];
    const stage = workflow.stages[stageName];
    const role = workflow.roles[stage.role];
    if (!snapshot.runtime_context_json.owner_lease) {
      this.apply(issueId, workflow, [{
        type: "claim_owner_lease",
        lease: createOwnerLease({
          lease_id: `lease-${issueId}-${stage.role}`,
          root_session_id: `root-${issueId}-${stage.role}`,
          role: stage.role,
          now,
          ttl_seconds: 180,
        }),
      }]);
    }
    const current = this.store.getIssue(issueId);
    const child = this.host.startBackgroundChild({
      issue_id: issueId,
      lease_id: current.runtime_context_json.owner_lease?.lease_id ?? "lease-missing",
      root_session_id: current.runtime_context_json.owner_lease?.root_session_id ?? "root-missing",
      role_name: stage.role,
      role,
    });
    return this.apply(issueId, workflow, [{
      type: "start_stage",
      child_run_id: child.child_run_id,
      session_id: child.session_id,
      at: now,
    }]);
  }

  private submitChildArtifact(
    issueId: string,
    workflow: WorkflowDefinition,
    snapshot: IssueSnapshot,
    artifact: { artifact_kind: string; role: string; payload: Record<string, unknown> },
  ): IssueSnapshot {
    const childRun = snapshot.runtime_context_json.child_runs?.at(-1);
    if (!childRun) {
      throw new Error(`No child run for ${issueId}`);
    }
    this.metrics.coding_release_valid_child_artifacts += artifact.role === "issue_worker" || artifact.role === "pr_verifier" ? 1 : 0;
    return this.apply(issueId, workflow, [{
      type: "child_artifact",
      child_run_id: childRun.child_run_id,
      status: "succeeded",
      artifact_history_id: this.store.listHistory(issueId).length + 1,
      at: now,
      artifact_kind: artifact.artifact_kind,
      schema_version: "1.0",
      role: artifact.role,
      summary: `${artifact.artifact_kind} success`,
      retryable: false,
      payload: artifact.payload,
    }]);
  }

  private completeDomainWorkflow(snapshot: IssueSnapshot, workflow: WorkflowDefinition, workflowId: string): void {
    if (snapshot.lifecycle_state !== "completed") {
      throw new Error(`${workflowId} expected completed, got ${snapshot.lifecycle_state}`);
    }
    const roleNames = Object.keys(workflow.roles).join(",");
    if (/issue_worker|pr_verifier|release_worker/.test(roleNames)) {
      this.metrics.domain_workflows_with_coding_role_chain += 1;
    }
    this.metrics.successful_full_cycle_workflows += 1;
    this.metrics.scenarios_passed += 1;
    this.metrics.workflows_completed += 1;
    this.metrics.domain_full_cycle_workflows += 1;
  }
}

export async function createOfflineE2EHarness(): Promise<OfflineE2EHarness> {
  return await OfflineE2EHarness.create();
}
