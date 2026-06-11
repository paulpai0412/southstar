import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import { FakeDomainDriver, type DomainDriver, type PullRequestResult, type ReleaseResult, type StagePreparation } from "../../src/orchestrator/domain-driver.ts";
import { createProductionOrchestrator } from "../../src/orchestrator/cycle.ts";
import { formatManualCliSummary, assertManualCliMetrics } from "../../src/orchestrator/metrics.ts";
import { ArtifactValidationError } from "../../src/runtime/artifacts.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";

test("manual orchestrator runs one issue from intake to completed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-cli-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 101,
      title: "Manual CLI smoke",
      body: "---\ndepends_on: []\npriority: 1\n---\nBody",
      sourceUrl: "https://github.test/issues/101",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:101" });
    await orchestrator.reconcileIssue({ issueId: "github:101" });
    await orchestrator.releaseIssue({ issueId: "github:101", autoRelease: false });
    const inspect = orchestrator.inspectIssue({ issueId: "github:101" });
    const metrics = orchestrator.metrics();

    assert.equal(store.getIssue("github:101").lifecycle_state, "completed");
    assert.equal(inspect.lifecycle_state, "completed");
    assert.equal(inspect.fields_present >= 8, true);
    assertManualCliMetrics(metrics.manual);
    assert.match(formatManualCliSummary(metrics.manual), /manual_cli_completed_issues=1/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestrator sends rich verifier progress to PR observability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-pr-progress-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const prProgressCalls: unknown[] = [];
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
      observability: {
        async trySyncIssueProgress() {
          return { status: "success", mutates_lifecycle: false };
        },
        async syncPrProgress(input) {
          prProgressCalls.push(input);
        },
      },
    });

    await orchestrator.intakeIssue({
      issueNumber: 111,
      title: "PR progress",
      body: "Body",
      sourceUrl: "https://github.test/issues/111",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:111" });
    await orchestrator.reconcileIssue({ issueId: "github:111" });

    assert.equal(prProgressCalls.length, 1);
    assert.match(JSON.stringify(prProgressCalls[0]), /verifierEvidence/);
    assert.match(JSON.stringify(prProgressCalls[0]), /commandsPassed/);
    assert.match(JSON.stringify(prProgressCalls[0]), /releaseReadiness/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestrator sends workflow-general context to domain driver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-context-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const domain = new CapturingDomainDriver();
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 202,
      title: "Workflow-general context",
      body: "Issue body with acceptance details",
      sourceUrl: "https://github.test/issues/202",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:202" });

    assert.equal(domain.prepareInput?.issue.id, "github:202");
    assert.equal(domain.prepareInput?.issue.number, 202);
    assert.equal(domain.prepareInput?.issue.title, "Workflow-general context");
    assert.equal(domain.prepareInput?.issue.body, "Issue body with acceptance details");
    assert.equal(domain.prepareInput?.issue.sourceUrl, "https://github.test/issues/202");
    assert.equal(domain.prepareInput?.workflow.id, "issue_to_pr_release");
    assert.equal(domain.prepareInput?.workflow.domain, "software_development");
    assert.equal(domain.prepareInput?.stage.name, "implementation");
    assert.equal(domain.prepareInput?.role.name, "implementation_agent");
    assert.equal(domain.prepareInput?.role.definition.agent, "build");
    assert.deepEqual(domain.prepareInput?.runtimeContext.dependencies, []);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestrator runs verifier after verifier stage dispatch and binds artifact to verifier child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-verifier-binding-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const domain = new VerifyingDomainDriver();
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 505,
      title: "Verifier binding",
      body: "Verify after dispatch",
      sourceUrl: "https://github.test/issues/505",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:505" });
    await orchestrator.reconcileIssue({ issueId: "github:505" });

    const history = store.listHistory("github:505");
    const verifierChild = store.getIssue("github:505").runtime_context_json.child_runs?.find((child) =>
      child.role === "verifier_agent"
    );
    const verifierArtifact = history.find((entry) =>
      entry.event_type === "child_artifact_received" && entry.payload.artifact_kind === "verification_result"
    );

    assert.equal(domain.verifyCalls, 1);
    assert.equal(verifierArtifact?.payload.child_run_id, verifierChild?.child_run_id);
    assert.equal(history.some((entry) => entry.event_type === "child_run_lost"), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch cycle does not start dependency-blocked ready issues", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-deps-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 1,
      title: "Foundation",
      body: "Build the foundation",
      sourceUrl: "https://github.test/issues/1",
      labels: ["northstar:ready"],
    });
    await orchestrator.intakeIssue({
      issueNumber: 2,
      title: "Dependent",
      body: "Depends-On: #1\n\nBuild after foundation",
      sourceUrl: "https://github.test/issues/2",
      labels: ["northstar:ready"],
    });

    const result = await orchestrator.runCycle({ autoRelease: false, maxStarts: 2 });

    assert.equal(result.effectsStarted, 1);
    assert.equal(store.getIssue("github:1").lifecycle_state, "running");
    assert.equal(store.getIssue("github:2").lifecycle_state, "ready");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch cycle defers new starts after reconciling in-flight work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-phase-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 1,
      title: "First",
      body: "Build first",
      sourceUrl: "https://github.test/issues/1",
      labels: ["northstar:ready"],
    });
    await orchestrator.intakeIssue({
      issueNumber: 2,
      title: "Second",
      body: "Build second",
      sourceUrl: "https://github.test/issues/2",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:1" });

    const result = await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    assert.equal(result.effectsStarted, 0);
    assert.equal(store.getIssue("github:1").lifecycle_state, "verified");
    assert.equal(store.getIssue("github:2").lifecycle_state, "ready");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch cycle retries release_pending issues", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-release-pending-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 1,
      title: "Release retry",
      body: "Build release retry",
      sourceUrl: "https://github.test/issues/1",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:1" });
    await orchestrator.reconcileIssue({ issueId: "github:1" });
    await orchestrator.releaseIssue({ issueId: "github:1", autoRelease: true });
    const completed = store.getIssue("github:1");
    store.appendHistoryBatchAndUpdateSnapshot("github:1", [], {
      ...completed,
      lifecycle_state: "release_pending",
    });

    await orchestrator.runCycle({ autoRelease: true, maxStarts: 1 });

    assert.equal(store.getIssue("github:1").lifecycle_state, "completed");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("releaseIssue does not rerun release worker for completed issues", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-completed-release-noop-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    store.createIssue(newIssueSnapshot("github:404", {
      lifecycle_state: "completed",
      runtime_context_json: {
        child_runs: [],
        pr: {
          prNumber: 9,
          prUrl: "https://github.test/pull/9",
          branch: "northstar/404",
          commitSha: "head-404",
        },
        release: {
          confirmed: true,
          merge_commit: "merge-404",
        },
      },
    }));
    const domain = new ThrowIfReleaseDomainDriver();
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    const result = await orchestrator.releaseIssue({ issueId: "github:404", autoRelease: true });
    const historyTypes = store.listHistory("github:404").map((entry) => entry.event_type);

    assert.equal(result.lifecycle_state, "completed");
    assert.equal(domain.releaseCalls, 0);
    assert.equal(historyTypes.includes("release_started"), false);
    assert.equal(historyTypes.includes("owner_lease_acquired"), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("release verifier artifact rejection transitions to exception without hard exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-release-verifier-reject-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new ReleaseVerifierRejectedDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 2,
      title: "Release verifier rejected",
      body: "Build release verifier rejection",
      sourceUrl: "https://github.test/issues/2",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:2" });
    await orchestrator.reconcileIssue({ issueId: "github:2" });
    const result = await orchestrator.releaseIssue({ issueId: "github:2", autoRelease: true });
    const snapshot = store.getIssue("github:2");

    assert.equal(result.next_action, "verifier_artifact_rejected");
    assert.equal(snapshot.lifecycle_state, "exception");
    assert.equal(snapshot.runtime_context_json.owner_lease, undefined);
    assert.equal(snapshot.runtime_context_json.blocked_by, undefined);
    assert.equal(snapshot.runtime_context_json.runtime_recovery?.reason_code, "artifact_rejected_retryable");
    assert.equal(store.listHistory("github:2").some((entry) => entry.event_type === "verifier_artifact_rejected"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("resumeIssue restores quarantined issue to ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-resume-ready-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 303,
      title: "Resume to ready",
      body: "Resume flow",
      sourceUrl: "https://github.test/issues/303",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:303" });
    const running = store.getIssue("github:303");
    store.appendHistoryBatchAndUpdateSnapshot("github:303", [], {
      ...running,
      lifecycle_state: "quarantined",
      runtime_context_json: {
        ...running.runtime_context_json,
        blocked_by: ["host_liveness"],
        last_error: "Host root liveness is missing",
        exception: { id: "exc-runtime" },
        runtime_recovery: { reason_code: "host_liveness_lost" },
      },
    });

    const resumed = await orchestrator.resumeIssue({
      issueId: "github:303",
      reason: "runtime bug fixed",
      targetLifecycle: "ready",
    });
    const snapshot = store.getIssue("github:303");

    assert.equal(snapshot.lifecycle_state, "ready");
    assert.equal(snapshot.runtime_context_json.owner_lease, undefined);
    assert.equal(snapshot.runtime_context_json.child_runs, undefined);
    assert.equal(snapshot.runtime_context_json.exception, undefined);
    assert.equal(snapshot.runtime_context_json.runtime_recovery, undefined);
    assert.equal(resumed.target_lifecycle, "ready");
    assert.equal(store.listHistory("github:303").some((entry) => entry.event_type === "operator_resume"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resumeIssue can immediately restart quarantined issue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-resume-running-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 304,
      title: "Resume to running",
      body: "Resume flow",
      sourceUrl: "https://github.test/issues/304",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:304" });
    const running = store.getIssue("github:304");
    store.appendHistoryBatchAndUpdateSnapshot("github:304", [], {
      ...running,
      lifecycle_state: "quarantined",
      runtime_context_json: {
        ...running.runtime_context_json,
        blocked_by: ["host_liveness"],
        last_error: "Host root liveness is missing",
        exception: { id: "exc-runtime" },
        runtime_recovery: { reason_code: "host_liveness_lost" },
      },
    });

    const resumed = await orchestrator.resumeIssue({
      issueId: "github:304",
      reason: "runtime bug fixed",
      targetLifecycle: "running",
    });
    const snapshot = store.getIssue("github:304");

    assert.equal(snapshot.lifecycle_state, "running");
    assert.equal(snapshot.runtime_context_json.owner_lease?.role, "implementation_agent");
    assert.equal(snapshot.runtime_context_json.child_runs?.at(-1)?.status, "running");
    assert.equal(resumed.target_lifecycle, "running");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resumeIssue restarts release-quarantined merged issue at release stage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-resume-release-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 305,
      title: "Resume release cleanup",
      body: "Release cleanup should resume without implementation rerun",
      sourceUrl: "https://github.test/issues/305",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:305" });
    const running = store.getIssue("github:305");
    store.appendHistoryBatchAndUpdateSnapshot("github:305", [], {
      ...running,
      lifecycle_state: "quarantined",
      runtime_context_json: {
        ...running.runtime_context_json,
        stage_cursor: "release",
        exception: {
          id: "exc-release",
          source_stage: "release",
          artifact_kind: "release_result",
          status: "blocked",
          summary: "PR #9 is already merged but local sync and worktree cleanup are incomplete.",
          payload: {
            release: {
              merge_commit: "merge-sha-9",
              local_sync: { local_head: "old-main", remote_head: "merge-sha-9", matches_remote: false },
              worktree_cleanup: { path: ".northstar/runtime/worktrees/issue-305", removed: false },
            },
          },
        },
      },
    });

    const resumed = await orchestrator.resumeIssue({
      issueId: "github:305",
      reason: "release cleanup prompt fixed",
      targetLifecycle: "running",
    });
    const snapshot = store.getIssue("github:305");

    assert.equal(snapshot.lifecycle_state, "releasing");
    assert.equal(snapshot.runtime_context_json.stage_cursor, "release");
    assert.equal(snapshot.runtime_context_json.owner_lease?.role, "release_agent");
    assert.equal(snapshot.runtime_context_json.child_runs?.at(-1)?.role, "release_agent");
    assert.deepEqual(snapshot.runtime_context_json.exception_carry_forward, {
      error: "PR #9 is already merged but local sync and worktree cleanup are incomplete.",
      release_context: {
        merge_commit: "merge-sha-9",
        local_head: "old-main",
        remote_head: "merge-sha-9",
        worktree_cleanup_path: ".northstar/runtime/worktrees/issue-305",
      },
    });
    assert.equal(resumed.target_lifecycle, "releasing");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startIssue dispatches verifier when ready issue carries verification stage cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-start-verifier-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 306,
      title: "Resume verifier",
      body: "Verifier should resume directly when stage cursor says verification",
      sourceUrl: "https://github.test/issues/306",
      labels: ["northstar:ready"],
    });
    const ready = store.getIssue("github:306");
    store.appendHistoryBatchAndUpdateSnapshot("github:306", [], {
      ...ready,
      runtime_context_json: {
        ...ready.runtime_context_json,
        stage_cursor: "verification",
      },
    });

    await orchestrator.startIssue({ issueId: "github:306" });
    const snapshot = store.getIssue("github:306");

    assert.equal(snapshot.lifecycle_state, "verifying");
    assert.equal(snapshot.runtime_context_json.stage_cursor, "verification");
    assert.equal(snapshot.runtime_context_json.owner_lease?.role, "verifier_agent");
    assert.equal(snapshot.runtime_context_json.child_runs?.at(-1)?.role, "verifier_agent");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class CapturingDomainDriver implements DomainDriver {
  prepareInput?: Parameters<DomainDriver["prepareStage"]>[0];

  async prepareStage(input: Parameters<DomainDriver["prepareStage"]>[0]): Promise<StagePreparation> {
    this.prepareInput = input;
    return {
      worktreePath: `/tmp/northstar/${input.issue.id.replace(/[^a-z0-9-]/gi, "-")}`,
      branch: `northstar/${input.issue.number}-${input.stage.name}`,
    };
  }

  async finalizeWorkerArtifact(input: Parameters<DomainDriver["finalizeWorkerArtifact"]>[0]): Promise<PullRequestResult> {
    return {
      prNumber: 1,
      prUrl: `https://github.test/${input.issue.id}/pull/1`,
      branch: input.branch,
      commitSha: "capture-commit-sha",
    };
  }

  async releaseVerifiedItem(): Promise<ReleaseResult> {
    return { confirmed: true, mergeSha: "capture-merge-sha" };
  }
}

class ReleaseVerifierRejectedDomainDriver extends FakeDomainDriver {
  async releaseVerifiedItem(): Promise<ReleaseResult> {
    throw new ArtifactValidationError(
      "ARTIFACT_FIELD_TYPE",
      "status",
      "unknown artifact status PASS_WITH_REPORTED_REGRESSION",
    );
  }
}

class VerifyingDomainDriver extends FakeDomainDriver {
  verifyCalls = 0;

  async verifyPullRequest(input: Parameters<NonNullable<DomainDriver["verifyPullRequest"]>>[0]): Promise<Record<string, unknown>> {
    this.verifyCalls += 1;
    return {
      schema_version: "1.0",
      artifact_kind: "verification_result",
      status: "pass",
      retryable: false,
      issue_number: input.issue.number,
      role: "verifier_agent",
      observed_at: "2026-05-30T00:00:00.000Z",
      summary: "verification passed",
      review: { requirements_passed: true, code_review_passed: true },
      functional_review: { required: false, status: "pass" },
      browser_evidence: { required: false, ran: false },
      workspace_evidence: {
        path_checked: ".northstar/runtime/worktrees/issue-1",
        expected_branch: "northstar/1",
        observed_branch: "northstar/1",
        expected_head_sha: "head-sha-1",
        observed_head_sha: "head-sha-1",
        matches_expected: true,
      },
      release_recommendation: "ready_for_release",
    };
  }
}

class ThrowIfReleaseDomainDriver extends FakeDomainDriver {
  releaseCalls = 0;

  async releaseVerifiedItem(): Promise<ReleaseResult> {
    this.releaseCalls += 1;
    throw new Error("release worker should not run for completed issue");
  }
}
