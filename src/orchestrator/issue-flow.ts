import type { IssueSnapshot, StateMachineResult } from "../types/control-plane.ts";
import type { WorkflowDefinition } from "../types/workflow.ts";
import { applyRuntimeEvents, createOwnerLease, type RuntimeEvent } from "../runtime/state-machine.ts";
import type { ReleaseSyncWorktreeResult } from "./domain-driver.ts";

export function claimAndStartStage(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  stageName: string;
  leaseId: string;
  rootSessionId: string;
  childRunId: string;
  sessionId: string;
  childStatus?: "running" | "queued";
  now: string;
  ttlSeconds: number;
}): StateMachineResult {
  const stage = input.workflow.stages[input.stageName];
  if (!stage) throw new Error(`Unknown workflow stage ${input.stageName}`);

  const claimed = applyRuntimeEvents(input.snapshot, input.workflow, [
    {
      type: "claim_owner_lease",
      lease: createOwnerLease({
        lease_id: input.leaseId,
        root_session_id: input.rootSessionId,
        role: stage.role,
        now: input.now,
        ttl_seconds: input.ttlSeconds,
      }),
    },
  ]);
  if (claimed.operatorMessages.length > 0) {
    return claimed;
  }

  const started = applyRuntimeEvents(claimed.snapshot, input.workflow, [{
    type: "start_stage",
    child_run_id: input.childRunId,
    session_id: input.sessionId,
    child_status: input.childStatus,
    at: input.now,
  }]);
  return {
    snapshot: started.snapshot,
    history: [...claimed.history, ...started.history],
    effects: [...claimed.effects, ...started.effects],
    operatorMessages: [...claimed.operatorMessages, ...started.operatorMessages],
  };
}

export function submitWorkerArtifact(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  childRunId: string;
  artifactHistoryId: number;
  roleName: string;
  artifactKind: string;
  branch: string;
  commitSha: string;
  changedFiles: string[];
  now: string;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [{
    type: "child_artifact",
    child_run_id: input.childRunId,
    status: "succeeded",
    artifact_history_id: input.artifactHistoryId,
    at: input.now,
    artifact_kind: input.artifactKind,
    schema_version: "1.0",
    role: input.roleName,
    summary: "worker completed",
    retryable: false,
    payload: {
      branch: input.branch,
      base_branch: "main",
      commit_sha: input.commitSha,
      changed_files: input.changedFiles,
      commands_run: [{ command: "orchestrator worker", status: "passed" }],
      test_summary: { passed: 1, failed: 0 },
      self_check_summary: "orchestrator worker artifact",
    },
  }]);
}

export function submitChildArtifactPayload(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  childRunId: string;
  artifactHistoryId: number;
  artifact: Record<string, unknown>;
  now: string;
}): StateMachineResult {
  const status = artifactEventStatus(input.artifact.status);
  return applyRuntimeEvents(input.snapshot, input.workflow, [{
    type: "child_artifact",
    child_run_id: input.childRunId,
    status,
    artifact_history_id: input.artifactHistoryId,
    at: input.now,
    artifact_kind: stringField(input.artifact.artifact_kind),
    schema_version: stringField(input.artifact.schema_version),
    role: stringField(input.artifact.role),
    observed_at: stringField(input.artifact.observed_at),
    summary: stringField(input.artifact.summary),
    retryable: typeof input.artifact.retryable === "boolean" ? input.artifact.retryable : undefined,
    payload: input.artifact,
  }]);
}

export function submitVerifierArtifact(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  childRunId: string;
  artifactHistoryId: number;
  roleName: string;
  artifactKind: string;
  prNumber: number;
  now: string;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [{
    type: "child_artifact",
    child_run_id: input.childRunId,
    status: "succeeded",
    artifact_history_id: input.artifactHistoryId,
    at: input.now,
    artifact_kind: input.artifactKind,
    schema_version: "1.0",
    role: input.roleName,
    summary: "verification passed",
    retryable: false,
    payload: {
      pr_number: input.prNumber,
      base_branch: "main",
      gate_results: [{ name: "orchestrator gate", status: "pass" }],
      verifier: { session_id: input.childRunId },
    },
  }]);
}

function artifactEventStatus(status: unknown): "succeeded" | "blocked" | "failed_retryable" | "failed_terminal" {
  if (status === "success" || status === "pass" || status === "ready_for_verification" || status === "completed") return "succeeded";
  if (status === "blocked" || status === "failed_retryable" || status === "failed_terminal") return status;
  return "failed_retryable";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function submitPullRequestRecorded(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  prNumber: number;
  prUrl: string;
  branch: string;
  commitSha: string;
  now: string;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [{
    type: "pull_request_recorded",
    at: input.now,
    pr_number: input.prNumber,
    pr_url: input.prUrl,
    branch: input.branch,
    commit_sha: input.commitSha,
  }]);
}

export function claimAndStartRelease(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  roleName: string;
  leaseId: string;
  rootSessionId: string;
  childRunId: string;
  sessionId: string;
  now: string;
  ttlSeconds: number;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [
    {
      type: "claim_owner_lease",
      lease: createOwnerLease({
        lease_id: input.leaseId,
        root_session_id: input.rootSessionId,
        role: input.roleName,
        now: input.now,
        ttl_seconds: input.ttlSeconds,
      }),
    },
    { type: "start_release", at: input.now },
    {
      type: "start_stage",
      child_run_id: input.childRunId,
      session_id: input.sessionId,
      child_status: "queued",
      at: input.now,
    },
  ]);
}

export function submitConfirmedRelease(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  mergeSha: string;
  syncWorktree?: ReleaseSyncWorktreeResult;
  now: string;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [
    {
      type: "release_result",
      status: "success",
      pr_merged: true,
      merge_sha: input.mergeSha,
      at: input.now,
      ...(input.syncWorktree ? { sync_worktree: syncWorktreeResultToEvent(input.syncWorktree) } : {}),
    },
  ]);
}

export function submitExternalMerge(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  classification?: "pre_release_external_merge";
  possibleCause?: string;
  detectedLifecycle?: string;
  detectedStage?: string;
  expectedStage?: string;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  headCommit?: string;
  mergeSha: string;
  syncWorktree?: ReleaseSyncWorktreeResult;
  now: string;
}): StateMachineResult {
  const diagnosticEvent: RuntimeEvent[] = input.classification
    ? [{
        type: "unexpected_external_merge_detected",
        at: input.now,
        classification: input.classification,
        possible_cause: input.possibleCause ?? "external_actor_merged_before_release_stage",
        ...(input.detectedLifecycle === undefined ? {} : { detected_lifecycle: input.detectedLifecycle }),
        ...(input.detectedStage === undefined ? {} : { detected_stage: input.detectedStage }),
        ...(input.expectedStage === undefined ? {} : { expected_stage: input.expectedStage }),
        ...(input.prNumber === undefined ? {} : { pr_number: input.prNumber }),
        ...(input.prUrl === undefined ? {} : { pr_url: input.prUrl }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.headCommit === undefined ? {} : { head_commit: input.headCommit }),
        merge_sha: input.mergeSha,
      }]
    : [];
  return applyRuntimeEvents(input.snapshot, input.workflow, [...diagnosticEvent, {
    type: "external_merge_detected",
    at: input.now,
    ...(input.classification === undefined ? {} : { classification: input.classification }),
    ...(input.detectedLifecycle === undefined ? {} : { detected_lifecycle: input.detectedLifecycle }),
    ...(input.detectedStage === undefined ? {} : { detected_stage: input.detectedStage }),
    ...(input.expectedStage === undefined ? {} : { expected_stage: input.expectedStage }),
    ...(input.prNumber === undefined ? {} : { pr_number: input.prNumber }),
    ...(input.prUrl === undefined ? {} : { pr_url: input.prUrl }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(input.headCommit === undefined ? {} : { head_commit: input.headCommit }),
    merge_sha: input.mergeSha,
    ...(input.syncWorktree ? { sync_worktree: syncWorktreeResultToEvent(input.syncWorktree) } : {}),
  }]);
}

export function submitSyncWorktreeRefreshResult(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  syncWorktree: ReleaseSyncWorktreeResult;
  now: string;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [{
    type: "sync_worktree_refresh_result",
    at: input.now,
    sync_worktree: syncWorktreeResultToEvent(input.syncWorktree),
  }]);
}

function syncWorktreeResultToEvent(result: ReleaseSyncWorktreeResult) {
  return {
    status: result.status,
    ...(result.path === undefined ? {} : { path: result.path }),
    ...(result.headCommit === undefined ? {} : { head_commit: result.headCommit }),
    ...(result.expectedCommit === undefined ? {} : { expected_commit: result.expectedCommit }),
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.lastError === undefined ? {} : { last_error: result.lastError }),
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
  };
}
