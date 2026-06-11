import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IssueSnapshot } from "../../src/types/control-plane.ts";
import { loadWorkflow } from "../../src/types/workflow.ts";
import { issuePacketId, type IssuePacket } from "../../src/intake/types.ts";
import { applyRuntimeEvents, createOwnerLease, type RuntimeEvent } from "../../src/runtime/state-machine.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";

const now = "2026-05-29T12:00:00.000Z";

export async function createFullLiveRuntimeDriver(): Promise<FullLiveRuntimeDriver> {
  const dir = await mkdtemp(join(tmpdir(), "northstar-full-live-runtime-"));
  return new FullLiveRuntimeDriver(dir, SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite")));
}

export class FullLiveRuntimeDriver {
  private readonly workflow = loadWorkflow(resolve("tests/fixtures/workflows/issue-to-pr-release.yaml"));
  private readonly dir: string;
  private readonly store: SqliteControlPlaneStore;

  constructor(dir: string, store: SqliteControlPlaneStore) {
    this.dir = dir;
    this.store = store;
  }

  seedIssue(input: { issue_number: number; title: string; source_url: string }): IssueSnapshot {
    const packet: IssuePacket = {
      issue_number: String(input.issue_number),
      title: input.title,
      source: "github",
      source_url: input.source_url,
      branch: `northstar-smoke-${input.issue_number}`,
      base_branch: "main",
      labels: ["northstar:full-live"],
      dependencies: [],
      raw_text: input.title,
      ready_for_agent: true,
    };
    this.store.upsertIssuePacket(packet);
    return this.store.getIssue(issuePacketId(packet));
  }

  startImplementation(issueId: string): IssueSnapshot {
    return this.apply(issueId, [
      { type: "claim_owner_lease", lease: createOwnerLease({ lease_id: `lease-impl-${issueId}`, root_session_id: `root-impl-${issueId}`, role: "issue_worker", now, ttl_seconds: 600 }) },
      { type: "start_stage", child_run_id: `child-impl-${issueId}`, session_id: `session-impl-${issueId}`, at: now },
    ]);
  }

  submitWorkerResult(issueId: string, payload: { branch: string; commit_sha: string; changed_files: string[]; self_check_summary: string }): IssueSnapshot {
    return this.apply(issueId, [{
      type: "child_artifact",
      child_run_id: `child-impl-${issueId}`,
      status: "succeeded",
      artifact_history_id: this.store.listHistory(issueId).length + 1,
      at: now,
      artifact_kind: "worker_result",
      schema_version: "1.0",
      role: "issue_worker",
      summary: "full live worker success",
      retryable: false,
      payload: {
        branch: payload.branch,
        base_branch: "main",
        commit_sha: payload.commit_sha,
        changed_files: payload.changed_files,
        self_check_summary: payload.self_check_summary,
      },
    }]);
  }

  recordRetryableChildFailure(issueId: string, summary: string): IssueSnapshot {
    return this.apply(issueId, [{
      type: "child_artifact",
      child_run_id: `child-impl-${issueId}`,
      status: "failed_retryable",
      artifact_history_id: this.store.listHistory(issueId).length + 1,
      at: now,
      summary,
      retryable: true,
    }]);
  }

  recordInvalidWorkerArtifact(issueId: string): IssueSnapshot {
    return this.apply(issueId, [{
      type: "child_artifact",
      child_run_id: `child-impl-${issueId}`,
      status: "succeeded",
      artifact_history_id: this.store.listHistory(issueId).length + 1,
      at: now,
      artifact_kind: "worker_result",
      schema_version: "1.0",
      role: "issue_worker",
      summary: "OpenCode malformed worker artifact",
      retryable: false,
      payload: {
        branch: "northstar-opencode-malformed",
        base_branch: "main",
        commit_sha: "malformed123",
        self_check_summary: "missing changed_files",
      },
    }]);
  }

  recordUnknownChildArtifact(issueId: string, childRunId: string): IssueSnapshot {
    return this.apply(issueId, [{
      type: "child_artifact",
      child_run_id: childRunId,
      status: "failed_retryable",
      artifact_history_id: this.store.listHistory(issueId).length + 1,
      at: now,
      summary: "OpenCode artifact arrived for an unknown child run",
      retryable: true,
    }]);
  }

  startVerification(issueId: string): IssueSnapshot {
    return this.apply(issueId, [
      { type: "claim_owner_lease", lease: createOwnerLease({ lease_id: `lease-verify-${issueId}`, root_session_id: `root-verify-${issueId}`, role: "pr_verifier", now, ttl_seconds: 600 }) },
      { type: "start_stage", child_run_id: `child-verify-${issueId}`, session_id: `session-verify-${issueId}`, at: now },
    ]);
  }

  submitVerifierEvidence(issueId: string, input: { pr_number: number; gate_results: Array<{ name: string; status: string }> }): IssueSnapshot {
    return this.apply(issueId, [{
      type: "child_artifact",
      child_run_id: `child-verify-${issueId}`,
      status: "succeeded",
      artifact_history_id: this.store.listHistory(issueId).length + 1,
      at: now,
      artifact_kind: "evidence_packet",
      schema_version: "1.0",
      role: "pr_verifier",
      summary: "full live verifier success",
      retryable: false,
      payload: { pr_number: input.pr_number, base_branch: "main", gate_results: input.gate_results, verifier: { agent: "codex" } },
    }]);
  }

  recordVerificationRetryableFailure(issueId: string): IssueSnapshot {
    return this.apply(issueId, [{ type: "gate_result", status: "fail_retryable", at: now }]);
  }

  recordVerificationTerminalFailure(issueId: string): IssueSnapshot {
    return this.apply(issueId, [{ type: "gate_result", status: "fail_terminal", at: now }]);
  }

  quarantineInvalidLease(issueId: string): IssueSnapshot {
    return this.apply(issueId, [{ type: "operator_quarantine", reason: "OpenCode owner lease invalid or missing" }]);
  }

  resumeWithNewLease(issueId: string): IssueSnapshot {
    return this.apply(issueId, [{
      type: "resume_quarantined",
      lease: createOwnerLease({
        lease_id: `lease-recovered-${issueId}`,
        root_session_id: `root-recovered-${issueId}`,
        role: "issue_worker",
        now,
        ttl_seconds: 600,
      }),
    }]);
  }

  claimRelease(issueId: string): IssueSnapshot {
    return this.apply(issueId, [
      { type: "claim_owner_lease", lease: createOwnerLease({ lease_id: `lease-release-${issueId}`, root_session_id: `root-release-${issueId}`, role: "release_worker", now, ttl_seconds: 600 }) },
      { type: "start_release", at: now },
    ]);
  }

  submitReleaseSuccess(issueId: string, input: { merge_sha: string }): IssueSnapshot {
    return this.apply(issueId, [{ type: "release_result", status: "success", pr_merged: true, at: now, merge_sha: input.merge_sha }]);
  }

  confirmedMergeFacts(): number {
    return this.store
      .listAllIssuesForTests()
      .flatMap((issue) => this.store.listHistory(issue.issue_id))
      .filter((row) => row.event_type === "release_completed").length;
  }

  async cleanup(): Promise<void> {
    this.store.close();
    await rm(this.dir, { recursive: true, force: true });
  }

  private apply(issueId: string, events: RuntimeEvent[]): IssueSnapshot {
    const current = this.store.getIssue(issueId);
    const result = applyRuntimeEvents(current, this.workflow, events);
    this.store.appendHistoryBatchAndUpdateSnapshot(issueId, result.history, result.snapshot);
    return result.snapshot;
  }
}
