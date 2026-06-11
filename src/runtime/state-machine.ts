import type {
  ChildRun,
  HistoryEntry,
  IssueSnapshot,
  LifecycleState,
  OperatorMessage,
  OwnerLease,
  StateMachineResult,
} from "../types/control-plane.ts";
import type { HostCapabilityReport } from "../adapters/host/capabilities.ts";
import { lifecycleStates } from "../types/control-plane.ts";
import type { WorkflowDefinition } from "../types/workflow.ts";
import { ArtifactValidationError, artifactRejectionHistory, validateArtifactPayload } from "./artifacts.ts";

export const activeLifecycleStates = ["claimed", "running", "verifying", "releasing"];
export const terminalLifecycleStates = ["completed", "cancelled", "failed", "quarantined"];

type ReleaseSyncWorktreeEvent = {
  status: "synced" | "failed" | "skipped";
  path?: string;
  head_commit?: string;
  expected_commit?: string;
  code?: string;
  last_error?: string;
  retryable?: boolean;
  attempt_count?: number;
  next_retry_at?: string;
};

export type RuntimeEvent =
  | { type: "claim_owner_lease"; lease: OwnerLease }
  | { type: "heartbeat"; lease_id: string; at: string; ttl_seconds: number }
  | { type: "artifact_submitted"; artifact_history_id: number; at: string }
  | {
      type: "start_stage";
      child_run_id: string;
      session_id: string;
      at: string;
      child_status?: "running" | "queued";
      capability_report?: HostCapabilityReport;
    }
  | {
      type: "record_stream_session";
      child_run_id: string;
      stream_adapter: HostCapabilityReport["host"];
      stream_session_id: string;
      at: string;
      stream_child_run_id?: string;
      stream_root_session_id?: string;
    }
  | {
      type: "child_artifact";
      child_run_id: string;
      status: "succeeded" | "blocked" | "failed_retryable" | "failed_terminal";
      artifact_history_id: number;
      at: string;
      role?: string;
      artifact_kind?: string;
      observed_at?: string;
      summary?: string;
      retryable?: boolean;
      schema_version?: string;
      payload?: Record<string, unknown>;
    }
  | { type: "projection_result"; projection_target: string; status: "failed"; attempt?: number; last_error: string; next_retry_at: string; payload?: Record<string, unknown> }
  | {
      type: "pull_request_recorded";
      at: string;
      pr_number: number;
      pr_url: string;
      branch: string;
      commit_sha: string;
    }
  | { type: "release_result"; status: "success"; pr_merged: boolean; at: string; merge_sha?: string; sync_worktree?: ReleaseSyncWorktreeEvent }
  | { type: "sync_worktree_refresh_result"; at: string; sync_worktree: ReleaseSyncWorktreeEvent }
  | {
      type: "unexpected_external_merge_detected";
      at: string;
      classification: "pre_release_external_merge";
      possible_cause: string;
      detected_lifecycle?: string;
      detected_stage?: string;
      expected_stage?: string;
      pr_number?: number;
      pr_url?: string;
      branch?: string;
      head_commit?: string;
      merge_sha: string;
    }
  | {
      type: "external_merge_detected";
      at: string;
      classification?: string;
      detected_lifecycle?: string;
      detected_stage?: string;
      expected_stage?: string;
      pr_number?: number;
      pr_url?: string;
      branch?: string;
      head_commit?: string;
      merge_sha: string;
      sync_worktree?: ReleaseSyncWorktreeEvent;
    }
  | {
      type: "external_issue_closed_detected";
      at: string;
      issue_number?: number;
      state_reason?: string;
      closed_at?: string;
      labels?: string[];
    }
  | { type: "effect_result"; effect_type: string; status: "failed"; last_error: string; next_retry_at: string }
  | {
      type: "exception_raised";
      at: string;
      category: string;
      severity: "retryable" | "terminal" | "blocked";
      retryable: boolean;
      summary: string;
      source_child_run_id?: string;
      artifact_kind?: string;
      status?: string;
      payload?: Record<string, unknown>;
    }
  | { type: "resume_quarantined"; lease?: OwnerLease; host_liveness?: "live" | "missing" | "unknown" }
  | { type: "operator_resume_to_ready"; reason: string; target?: "ready" | "running" }
  | {
      type: "verifier_artifact_recovered";
      at: string;
      pr_number: number;
      pr_url: string;
      branch: string;
      commit_sha: string;
      source: "quarantine_recovery";
    }
  | { type: "gate_result"; status: "pass" | "fail_retryable" | "fail_terminal"; at: string }
  | { type: "release_approval_required"; at: string }
  | { type: "start_release"; at: string }
  | { type: "operator_quarantine"; reason: string };

export function newIssueSnapshot(
  issueId: string,
  overrides: Partial<IssueSnapshot> & {
    owner_lease?: OwnerLease;
    stage_cursor?: string;
    child_runs?: ChildRun[];
  } = {},
): IssueSnapshot {
  const runtimeContext = {
    child_runs: [],
    projection_sync: [],
    ...(overrides.runtime_context_json ?? {}),
  };

  if (overrides.owner_lease) {
    runtimeContext.owner_lease = overrides.owner_lease;
  }
  if (overrides.stage_cursor) {
    runtimeContext.stage_cursor = overrides.stage_cursor;
  }
  if (overrides.child_runs) {
    runtimeContext.child_runs = overrides.child_runs;
  }

  return {
    issue_id: issueId,
    lifecycle_state: overrides.lifecycle_state ?? "ready",
    current_session_id: overrides.current_session_id,
    worktree_path: overrides.worktree_path,
    runtime_context_json: runtimeContext,
  };
}

export function createOwnerLease(input: {
  lease_id: string;
  root_session_id: string;
  role: string;
  now: string;
  ttl_seconds: number;
  generation?: number;
}): OwnerLease {
  return {
    lease_id: input.lease_id,
    root_session_id: input.root_session_id,
    role: input.role,
    generation: input.generation ?? 1,
    heartbeat_seq: 0,
    last_heartbeat_at: input.now,
    expires_at: addSeconds(input.now, input.ttl_seconds),
  };
}

export function applyRuntimeEvents(
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  events: RuntimeEvent[],
): StateMachineResult {
  const next = cloneSnapshot(snapshot);
  const result: StateMachineResult = {
    snapshot: next,
    history: [],
    effects: [],
    operatorMessages: [],
  };

  for (const event of events) {
    applyRuntimeEvent(result, workflow, event);
  }

  return result;
}

export function inspectInvariantViolations(snapshot: IssueSnapshot, now: string): string[] {
  if (!isActive(snapshot.lifecycle_state)) {
    return [];
  }

  const lease = snapshot.runtime_context_json.owner_lease;
  if (!lease) {
    return ["active_issue_missing_owner_lease"];
  }
  if (Date.parse(lease.expires_at) <= Date.parse(now)) {
    return ["active_issue_expired_owner_lease"];
  }

  return [];
}

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && lifecycleStates.includes(value);
}

export function isTerminalLifecycleState(value: unknown): value is "completed" | "cancelled" | "failed" | "quarantined" {
  return typeof value === "string" && terminalLifecycleStates.includes(value);
}

export function normalizeTerminalRuntime(snapshot: IssueSnapshot): boolean {
  if (!isTerminalLifecycleState(snapshot.lifecycle_state)) {
    return false;
  }

  let changed = false;
  if (snapshot.current_session_id !== undefined) {
    delete snapshot.current_session_id;
    changed = true;
  }
  if (snapshot.runtime_context_json.owner_lease !== undefined) {
    delete snapshot.runtime_context_json.owner_lease;
    changed = true;
  }
  if (snapshot.runtime_context_json.stage_cursor !== undefined) {
    delete snapshot.runtime_context_json.stage_cursor;
    changed = true;
  }
  if (snapshot.runtime_context_json.current_stage !== undefined) {
    delete snapshot.runtime_context_json.current_stage;
    changed = true;
  }

  const terminalChildStatus = childStatusForTerminal(snapshot.lifecycle_state);
  for (const childRun of snapshot.runtime_context_json.child_runs ?? []) {
    if (childRun.status === "running" || childRun.status === "queued") {
      childRun.status = terminalChildStatus;
      changed = true;
    }
  }

  return changed;
}

function applyRuntimeEvent(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  event: RuntimeEvent,
): void {
  switch (event.type) {
    case "claim_owner_lease":
      claimOwnerLease(result, workflow, event.lease);
      return;
    case "heartbeat":
      recordHeartbeat(result, event);
      return;
    case "artifact_submitted":
      appendHistory(result, "artifact_submitted", event);
      return;
    case "start_stage":
      startStage(result, workflow, event);
      return;
    case "record_stream_session":
      recordStreamSession(result, event);
      return;
    case "child_artifact":
      applyChildArtifact(result, workflow, event);
      return;
    case "projection_result":
      recordProjectionFailure(result, event);
      return;
    case "pull_request_recorded":
      recordPullRequest(result, event);
      return;
    case "release_result":
      recordReleaseResult(result, event);
      return;
    case "sync_worktree_refresh_result":
      recordSyncWorktreeRefresh(result, event.sync_worktree, event.at);
      return;
    case "unexpected_external_merge_detected":
      recordUnexpectedExternalMergeDetected(result, event);
      return;
    case "external_merge_detected":
      recordExternalMergeDetected(result, event);
      return;
    case "external_issue_closed_detected":
      recordExternalIssueClosedDetected(result, event);
      return;
    case "effect_result":
      recordEffectResult(result, event);
      return;
    case "exception_raised":
      raiseException(result, workflow, event);
      return;
    case "resume_quarantined":
      resumeQuarantined(result, event);
      return;
    case "operator_resume_to_ready":
      operatorResumeToReady(result, workflow, event);
      return;
    case "verifier_artifact_recovered":
      recordVerifierArtifactRecovered(result, workflow, event);
      return;
    case "gate_result":
      applyGateResult(result, workflow, event);
      return;
    case "release_approval_required":
      requireReleaseApproval(result, workflow, event);
      return;
    case "start_release":
      startRelease(result, workflow, event);
      return;
    case "operator_quarantine":
      result.snapshot.lifecycle_state = "quarantined";
      normalizeTerminalRuntime(result.snapshot);
      appendHistory(result, "operator_quarantine", { reason: event.reason });
      return;
  }
}

function claimOwnerLease(result: StateMachineResult, workflow: WorkflowDefinition, lease: OwnerLease): void {
  const snapshot = result.snapshot;
  if (isTerminalLifecycleState(snapshot.lifecycle_state)) {
    addMessage(result, "terminal_owner_lease", "Terminal issue cannot acquire an owner lease.");
    return;
  }

  if (isActive(snapshot.lifecycle_state) && snapshot.runtime_context_json.owner_lease) {
    addMessage(result, "duplicate_owner_lease", "Active issue already has an owner lease.");
    return;
  }

  if ((snapshot.lifecycle_state === "verified" || snapshot.lifecycle_state === "release_pending") && isReleaseRole(workflow, lease.role)) {
    snapshot.runtime_context_json.owner_lease = lease;
    snapshot.current_session_id = lease.root_session_id;
    appendHistory(result, "owner_lease_acquired", { lease_id: lease.lease_id, role: lease.role });
    return;
  }

  snapshot.runtime_context_json.owner_lease = lease;
  snapshot.current_session_id = lease.root_session_id;
  snapshot.lifecycle_state = "claimed";
  appendHistory(result, "owner_lease_acquired", { lease_id: lease.lease_id, role: lease.role });
}

function recordHeartbeat(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "heartbeat" }>,
): void {
  const snapshot = result.snapshot;
  if (!isActive(snapshot.lifecycle_state)) {
    addMessage(result, "inactive_heartbeat", "Heartbeat was ignored because issue is not active.");
    return;
  }

  const lease = snapshot.runtime_context_json.owner_lease;
  if (!lease || lease.lease_id !== event.lease_id) {
    addMessage(result, "unknown_owner_lease", "Heartbeat lease does not match active lease.");
    return;
  }

  lease.heartbeat_seq += 1;
  lease.last_heartbeat_at = event.at;
  lease.expires_at = addSeconds(event.at, event.ttl_seconds);
  appendHistory(result, "owner_heartbeat", { lease_id: lease.lease_id, heartbeat_seq: lease.heartbeat_seq });
}

function startStage(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  event: Extract<RuntimeEvent, { type: "start_stage" }>,
): void {
  const snapshot = result.snapshot;
  const stageName = snapshot.runtime_context_json.stage_cursor ?? firstStageName(workflow);
  const stage = workflow.stages[stageName];
  if (!stage) {
    addMessage(result, "unknown_stage", `Unknown stage ${stageName}.`);
    return;
  }

  const lease = snapshot.runtime_context_json.owner_lease;
  const childRun: ChildRun = {
    child_run_id: event.child_run_id,
    lease_id: lease?.lease_id ?? "missing-lease",
    root_session_id: lease?.root_session_id ?? "missing-root-session",
    role: stage.role,
    status: event.child_status ?? "running",
    session_id: event.session_id,
    started_at: event.at,
    last_seen_at: event.at,
  };
  if (event.capability_report) {
    childRun.capability_report = event.capability_report;
  }

  snapshot.runtime_context_json.stage_cursor = stageName;
  snapshot.lifecycle_state = stage.lifecycle_state as LifecycleState;
  snapshot.runtime_context_json.child_runs = [...(snapshot.runtime_context_json.child_runs ?? []), childRun];
  appendHistory(result, "child_run_started", { child_run_id: childRun.child_run_id, role: childRun.role });
}

function recordStreamSession(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "record_stream_session" }>,
): void {
  const childRun = result.snapshot.runtime_context_json.child_runs?.find((run) => run.child_run_id === event.child_run_id);
  if (!childRun) {
    addMessage(result, "unknown_child_run", "Stream session child run does not match a known child run.");
    return;
  }

  childRun.stream_adapter = event.stream_adapter;
  childRun.stream_session_id = event.stream_session_id;
  childRun.last_seen_at = event.at;
  if (event.stream_child_run_id) {
    childRun.stream_child_run_id = event.stream_child_run_id;
  }
  if (event.stream_root_session_id) {
    childRun.stream_root_session_id = event.stream_root_session_id;
  }

  appendHistory(result, "host_stream_session_recorded", {
    child_run_id: childRun.child_run_id,
    role: childRun.role,
    stream_adapter: event.stream_adapter,
    stream_session_id: event.stream_session_id,
  });
}

function applyChildArtifact(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  event: Extract<RuntimeEvent, { type: "child_artifact" }>,
): void {
  const childRuns = result.snapshot.runtime_context_json.child_runs ?? [];
  const childRun = childRuns.find((run) => run.child_run_id === event.child_run_id);
  if (shouldValidateChildArtifact(event)) {
    try {
      validateExplicitChildArtifactBinding(event.payload ?? {}, {
        issue_number: artifactIssueNumber(result.snapshot),
        role: event.role ?? childRun?.role,
        status: artifactStatusFromChildEvent(event),
      });
      validateArtifactPayload({
        ...(event.payload ?? {}),
        schema_version: event.schema_version ?? event.payload?.schema_version ?? "1.0",
        artifact_kind: event.artifact_kind ?? event.payload?.artifact_kind,
        issue_number: artifactIssueNumber(result.snapshot),
        role: event.role ?? childRun?.role ?? event.payload?.role,
        status: artifactStatusFromChildEvent(event),
        observed_at: event.observed_at ?? event.payload?.observed_at ?? event.at,
        summary: event.summary ?? event.payload?.summary ?? "",
        retryable: event.retryable ?? (event.status === "blocked" || event.status === "failed_retryable"),
      }, workflow);
    } catch (error) {
      if (error instanceof ArtifactValidationError) {
        result.history.push(artifactRejectionHistory(result.snapshot.issue_id, {
          artifact_kind: event.artifact_kind ?? event.payload?.artifact_kind,
          role: event.role ?? childRun?.role,
          reason: error.code,
          path: error.path,
        }));
        raiseException(result, workflow, {
          type: "exception_raised",
          at: event.at,
          category: "artifact_validation",
          severity: "retryable",
          retryable: true,
          summary: `${error.code} at ${error.path}`,
          source_child_run_id: event.child_run_id,
          artifact_kind: event.artifact_kind ?? stringValueForException(event.payload?.artifact_kind),
          status: stringValueForException(event.payload?.status) ?? event.status,
          payload: {
            reason: error.code,
            path: error.path,
            artifact: event.payload ?? {},
          },
        });
        return;
      }
      throw error;
    }
  }

  if (!childRun) {
    appendHistory(result, "child_run_lost", { child_run_id: event.child_run_id });
  } else {
    childRun.status = childStatusFromArtifact(event.status);
    childRun.last_seen_at = event.at;
    childRun.artifact_history_id = event.artifact_history_id;
  }

  if (event.status === "blocked" || event.status === "failed_retryable" || event.status === "failed_terminal") {
    raiseException(result, workflow, {
      type: "exception_raised",
      at: event.at,
      category: "agent_reported_failure",
      severity: event.status === "blocked" ? "blocked" : event.status === "failed_terminal" ? "terminal" : "retryable",
      retryable: event.status !== "failed_terminal",
      summary: event.summary ?? `${event.status} child artifact`,
      source_child_run_id: event.child_run_id,
      artifact_kind: event.artifact_kind ?? stringValueForException(event.payload?.artifact_kind),
      status: stringValueForException(event.payload?.status) ?? event.status,
      payload: event.payload,
    });
    appendHistory(result, "child_artifact_received", {
      ...(event.payload ?? {}),
      child_run_id: event.child_run_id,
      status: artifactStatusFromChildEvent(event),
      child_status: event.status,
      artifact_history_id: event.artifact_history_id,
      ...(event.artifact_kind === undefined ? {} : { artifact_kind: event.artifact_kind }),
      ...(event.schema_version === undefined ? {} : { schema_version: event.schema_version }),
      ...(event.role === undefined ? {} : { role: event.role }),
      ...(event.summary === undefined ? {} : { summary: event.summary }),
    });
    return;
  }

  const artifactKind = event.artifact_kind ?? stringValueForException(event.payload?.artifact_kind);
  if (artifactKind === "release_result" && event.payload?.status === "completed") {
    const releasePayload = objectLike(event.payload.release);
    const mergeCommit = stringValueForException(releasePayload.merge_commit);
    const localSync = objectLike(releasePayload.local_sync);
    const worktreeCleanup = objectLike(releasePayload.worktree_cleanup);
    result.snapshot.runtime_context_json.release = {
      ...(result.snapshot.runtime_context_json.release ?? {}),
      confirmed: true,
      pr_merged: true,
      merge_commit: mergeCommit,
      merge_sha: mergeCommit,
      ...(Object.keys(localSync).length > 0 ? { local_sync: localSync } : {}),
      ...(Object.keys(worktreeCleanup).length > 0 ? { worktree_cleanup: worktreeCleanup } : {}),
      issue_update: objectLike(event.payload.issue_update),
    };
    result.snapshot.lifecycle_state = "completed";
    normalizeTerminalRuntime(result.snapshot);
    appendHistory(result, "child_artifact_received", {
      ...(event.payload ?? {}),
      child_run_id: event.child_run_id,
      status: artifactStatusFromChildEvent(event),
      child_status: event.status,
      artifact_history_id: event.artifact_history_id,
      ...(event.artifact_kind === undefined ? {} : { artifact_kind: event.artifact_kind }),
      ...(event.schema_version === undefined ? {} : { schema_version: event.schema_version }),
      ...(event.role === undefined ? {} : { role: event.role }),
      ...(event.summary === undefined ? {} : { summary: event.summary }),
    });
    return;
  }

  const stage = currentStage(result.snapshot, workflow);
  const target = childTarget(stage, event.status);
  if (target) {
    applyTransitionTargetWithRetryBudget(result, workflow, stage, target, event.status);
  }
  appendHistory(result, "child_artifact_received", {
    ...(event.payload ?? {}),
    child_run_id: event.child_run_id,
    status: artifactStatusFromChildEvent(event),
    child_status: event.status,
    artifact_history_id: event.artifact_history_id,
    ...(event.artifact_kind === undefined ? {} : { artifact_kind: event.artifact_kind }),
    ...(event.schema_version === undefined ? {} : { schema_version: event.schema_version }),
    ...(event.role === undefined ? {} : { role: event.role }),
    ...(event.summary === undefined ? {} : { summary: event.summary }),
  });
}

function validateExplicitChildArtifactBinding(
  payload: Record<string, unknown>,
  expected: { issue_number: number; role?: string; status: string },
): void {
  if ("issue_number" in payload && payload.issue_number !== expected.issue_number) {
    throw new ArtifactValidationError(
      "ARTIFACT_BINDING_MISMATCH",
      "issue_number",
      `issue_number must match runtime issue ${expected.issue_number}`,
    );
  }
  if ("role" in payload && expected.role !== undefined && payload.role !== expected.role) {
    throw new ArtifactValidationError(
      "ARTIFACT_BINDING_MISMATCH",
      "role",
      `role must match runtime child role ${expected.role}`,
    );
  }
  if ("status" in payload && payload.status !== expected.status) {
    throw new ArtifactValidationError(
      "ARTIFACT_BINDING_MISMATCH",
      "status",
      `status must match runtime child status ${expected.status}`,
    );
  }
}

function recordVerifierArtifactRecovered(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  event: Extract<RuntimeEvent, { type: "verifier_artifact_recovered" }>,
): void {
  if (result.snapshot.lifecycle_state !== "quarantined") {
    addMessage(result, "verifier_recovery_requires_quarantined", "Verifier artifact recovery can only run from quarantined.");
    return;
  }

  result.snapshot.lifecycle_state = "verified";
  result.snapshot.runtime_context_json.stage_cursor = verificationStageName(workflow) ?? result.snapshot.runtime_context_json.stage_cursor;
  delete result.snapshot.current_session_id;
  delete result.snapshot.runtime_context_json.owner_lease;
  delete result.snapshot.runtime_context_json.last_error;
  result.snapshot.runtime_context_json.blocked_by = [];
  result.snapshot.runtime_context_json.pr = {
    ...(result.snapshot.runtime_context_json.pr ?? {}),
    prNumber: event.pr_number,
    prUrl: event.pr_url,
    branch: event.branch,
    commitSha: event.commit_sha,
    headCommit: event.commit_sha,
  };
  appendHistory(result, "verifier_artifact_recovered", {
    source: event.source,
    pr_number: event.pr_number,
    pr_url: event.pr_url,
    branch: event.branch,
    commit_sha: event.commit_sha,
  });
}

function applyTransitionTargetWithRetryBudget(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  stage: ReturnType<typeof currentStage>,
  target: string,
  status: string,
): void {
  if (status !== "failed_retryable") {
    applyTransitionTarget(result.snapshot, workflow, target);
    return;
  }

  const targetStage = workflow.stages[target];
  if (!targetStage) {
    applyTransitionTarget(result.snapshot, workflow, target);
    return;
  }

  const role = workflow.roles[targetStage.role];
  const maxAttempts = role?.retry_policy?.max_attempts;
  const retryCount = numericRetryCount(result.snapshot.runtime_context_json.retry_count) + 1;
  result.snapshot.runtime_context_json.retry_count = retryCount;

  if (typeof maxAttempts === "number" && retryCount >= maxAttempts) {
    const terminalTarget = stage.on_failed_terminal ?? stage.on_fail_terminal ?? "failed";
    appendHistory(result, "retry_budget_exhausted", {
      target_stage: target,
      target_role: targetStage.role,
      retry_count: retryCount,
      max_attempts: maxAttempts,
      terminal_target: terminalTarget,
    });
    applyTransitionTarget(result.snapshot, workflow, terminalTarget);
    return;
  }

  appendHistory(result, "retry_scheduled", {
    target_stage: target,
    target_role: targetStage.role,
    retry_count: retryCount,
    ...(typeof maxAttempts === "number" ? { max_attempts: maxAttempts } : {}),
  });
  applyTransitionTarget(result.snapshot, workflow, target);
}

function numericRetryCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function syncWorktreeRefresh(snapshot: IssueSnapshot): Record<string, unknown> | undefined {
  const release = snapshot.runtime_context_json.release;
  if (!release || typeof release !== "object" || Array.isArray(release)) return undefined;
  const refresh = (release as Record<string, unknown>).sync_worktree_refresh;
  return refresh && typeof refresh === "object" && !Array.isArray(refresh) ? refresh as Record<string, unknown> : undefined;
}

function recordProjectionFailure(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "projection_result" }>,
): void {
  result.snapshot.runtime_context_json.projection_sync = [
    ...(result.snapshot.runtime_context_json.projection_sync ?? []),
    {
      projection_target: event.projection_target,
      status: event.status,
      attempt: event.attempt ?? 1,
      last_error: event.last_error,
      next_retry_at: event.next_retry_at,
      payload: event.payload ?? {},
    },
  ];
  appendHistory(result, "projection_failed", {
    projection_target: event.projection_target,
    status: event.status,
    attempt: event.attempt ?? 1,
    last_error: event.last_error,
    next_retry_at: event.next_retry_at,
    payload: event.payload ?? {},
  });
  result.effects.push({
    type: "projection_retry",
    payload: {
      projection_target: event.projection_target,
      next_retry_at: event.next_retry_at,
    },
    idempotency_key: `projection:${event.projection_target}:${event.attempt ?? 1}`,
  });
}

function recordReleaseResult(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "release_result" }>,
): void {
  if (event.status === "success" && event.pr_merged) {
    result.snapshot.lifecycle_state = "completed";
    result.snapshot.runtime_context_json.release = {
      ...(result.snapshot.runtime_context_json.release ?? {}),
      pr_merged: true,
      ...(event.merge_sha ? { merge_sha: event.merge_sha } : {}),
    };
    normalizeTerminalRuntime(result.snapshot);
    appendHistory(result, "release_completed", {
      pr_merged: true,
      ...(event.merge_sha ? { merge_sha: event.merge_sha } : {}),
    });
    recordSyncWorktreeRefresh(result, event.sync_worktree, event.at);
    return;
  }

  addMessage(result, "release_merge_not_confirmed", "Release result did not include confirmed PR merge.");
}

function recordPullRequest(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "pull_request_recorded" }>,
): void {
  result.snapshot.runtime_context_json.pr = {
    ...(result.snapshot.runtime_context_json.pr ?? {}),
    prNumber: event.pr_number,
    prUrl: event.pr_url,
    branch: event.branch,
    commitSha: event.commit_sha,
    headCommit: event.commit_sha,
  };
  appendHistory(result, "pull_request_recorded", {
    pr_number: event.pr_number,
    pr_url: event.pr_url,
    branch: event.branch,
    commit_sha: event.commit_sha,
  });
}

function recordExternalMergeDetected(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "external_merge_detected" }>,
): void {
  result.snapshot.lifecycle_state = "completed";
  result.snapshot.runtime_context_json.pr = {
    ...(result.snapshot.runtime_context_json.pr ?? {}),
    ...(event.pr_number === undefined ? {} : { prNumber: event.pr_number }),
    ...(event.pr_url === undefined ? {} : { prUrl: event.pr_url }),
    ...(event.branch === undefined ? {} : { branch: event.branch }),
    ...(event.head_commit === undefined ? {} : { commitSha: event.head_commit, headCommit: event.head_commit }),
    mergeSha: event.merge_sha,
  };
  result.snapshot.runtime_context_json.release = {
    ...(result.snapshot.runtime_context_json.release ?? {}),
    pr_merged: true,
    merge_sha: event.merge_sha,
  };
  normalizeTerminalRuntime(result.snapshot);
  appendHistory(result, "external_merge_detected", {
    ...(event.classification === undefined ? {} : { classification: event.classification }),
    ...(event.detected_lifecycle === undefined ? {} : { detected_lifecycle: event.detected_lifecycle }),
    ...(event.detected_stage === undefined ? {} : { detected_stage: event.detected_stage }),
    ...(event.expected_stage === undefined ? {} : { expected_stage: event.expected_stage }),
    ...(event.pr_number === undefined ? {} : { pr_number: event.pr_number }),
    ...(event.pr_url === undefined ? {} : { pr_url: event.pr_url }),
    ...(event.branch === undefined ? {} : { branch: event.branch }),
    ...(event.head_commit === undefined ? {} : { head_commit: event.head_commit }),
    merge_sha: event.merge_sha,
  });
  appendHistory(result, "release_completed", {
    pr_merged: true,
    merge_sha: event.merge_sha,
    source: "external_merge",
  });
  recordSyncWorktreeRefresh(result, event.sync_worktree, event.at);
}

function recordUnexpectedExternalMergeDetected(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "unexpected_external_merge_detected" }>,
): void {
  appendHistory(result, "unexpected_external_merge_detected", {
    classification: event.classification,
    possible_cause: event.possible_cause,
    ...(event.detected_lifecycle === undefined ? {} : { detected_lifecycle: event.detected_lifecycle }),
    ...(event.detected_stage === undefined ? {} : { detected_stage: event.detected_stage }),
    ...(event.expected_stage === undefined ? {} : { expected_stage: event.expected_stage }),
    ...(event.pr_number === undefined ? {} : { pr_number: event.pr_number }),
    ...(event.pr_url === undefined ? {} : { pr_url: event.pr_url }),
    ...(event.branch === undefined ? {} : { branch: event.branch }),
    ...(event.head_commit === undefined ? {} : { head_commit: event.head_commit }),
    merge_sha: event.merge_sha,
  });
}

function recordSyncWorktreeRefresh(
  result: StateMachineResult,
  syncWorktree: ReleaseSyncWorktreeEvent | undefined,
  now: string,
): void {
  if (!syncWorktree) return;
  const previous = syncWorktreeRefresh(result.snapshot);
  const attemptCount = syncWorktree.attempt_count ?? (syncWorktree.status === "failed"
    ? numericValue(previous?.attempt_count) + 1
    : numericValue(previous?.attempt_count));
  const enriched = {
    ...syncWorktree,
    ...(attemptCount > 0 ? { attempt_count: attemptCount } : {}),
    ...(syncWorktree.status === "failed" && syncWorktree.retryable !== false
      ? { next_retry_at: syncWorktree.next_retry_at ?? addSeconds(now, 60) }
      : {}),
  };
  result.snapshot.runtime_context_json.release = {
    ...(result.snapshot.runtime_context_json.release ?? {}),
    sync_worktree_refresh: enriched,
  };
  if (syncWorktree.status === "failed") {
    result.snapshot.runtime_context_json.last_error = syncWorktree.last_error ?? "sync worktree refresh failed";
    addBlocker(result.snapshot, "sync_worktree");
  }
  if (syncWorktree.status === "synced") {
    if (removeBlocker(result.snapshot, "sync_worktree")) {
      delete result.snapshot.runtime_context_json.last_error;
    }
    appendHistory(result, "sync_worktree_refreshed", enriched);
  } else if (syncWorktree.status === "failed") {
    appendHistory(result, "sync_worktree_refresh_failed", enriched);
  } else if (syncWorktree.status === "skipped") {
    appendHistory(result, "sync_worktree_refresh_skipped", enriched);
  }
}

function addBlocker(snapshot: IssueSnapshot, blocker: string): void {
  const existing = Array.isArray(snapshot.runtime_context_json.blocked_by)
    ? snapshot.runtime_context_json.blocked_by.map(String)
    : [];
  snapshot.runtime_context_json.blocked_by = [...new Set([...existing, blocker])];
}

function removeBlocker(snapshot: IssueSnapshot, blocker: string): boolean {
  const existing = Array.isArray(snapshot.runtime_context_json.blocked_by)
    ? snapshot.runtime_context_json.blocked_by.map(String)
    : [];
  if (!existing.includes(blocker)) return false;
  const remaining = existing.filter((value) => value !== blocker);
  if (remaining.length > 0) {
    snapshot.runtime_context_json.blocked_by = remaining;
  } else {
    delete snapshot.runtime_context_json.blocked_by;
  }
  return true;
}

function recordExternalIssueClosedDetected(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "external_issue_closed_detected" }>,
): void {
  result.snapshot.lifecycle_state = "cancelled";
  result.snapshot.runtime_context_json.github_issue_state = {
    state: "closed",
    ...(event.issue_number === undefined ? {} : { issue_number: event.issue_number }),
    ...(event.state_reason === undefined ? {} : { state_reason: event.state_reason }),
    ...(event.closed_at === undefined ? {} : { closed_at: event.closed_at }),
    ...(event.labels === undefined ? {} : { labels: event.labels }),
  };
  normalizeTerminalRuntime(result.snapshot);
  appendHistory(result, "external_issue_closed_detected", {
    state: "closed",
    target_lifecycle: "cancelled",
    ...(event.issue_number === undefined ? {} : { issue_number: event.issue_number }),
    ...(event.state_reason === undefined ? {} : { state_reason: event.state_reason }),
    ...(event.closed_at === undefined ? {} : { closed_at: event.closed_at }),
    ...(event.labels === undefined ? {} : { labels: event.labels }),
    at: event.at,
  });
}

function recordEffectResult(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "effect_result" }>,
): void {
  result.snapshot.runtime_context_json.projection_sync = [
    ...(result.snapshot.runtime_context_json.projection_sync ?? []),
    {
      projection_target: event.effect_type,
      status: event.status,
      last_error: event.last_error,
      next_retry_at: event.next_retry_at,
    },
  ];
  appendHistory(result, "effect_failed_retryable", {
    effect_type: event.effect_type,
    status: event.status,
    last_error: event.last_error,
    next_retry_at: event.next_retry_at,
  });
}

function raiseException(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  event: Extract<RuntimeEvent, { type: "exception_raised" }>,
): void {
  const snapshot = result.snapshot;
  const sourceLifecycle = snapshot.lifecycle_state;
  const sourceStage = snapshot.runtime_context_json.stage_cursor ?? firstStageName(workflow);
  const sourceRole = workflow.stages[sourceStage]?.role;
  const previousException = objectLike(snapshot.runtime_context_json.exception);
  const previousAttempt = typeof previousException.attempt_count === "number" ? previousException.attempt_count : 0;

  delete snapshot.current_session_id;
  delete snapshot.runtime_context_json.owner_lease;
  snapshot.lifecycle_state = "exception";
  snapshot.runtime_context_json.exception = {
    id: `exc_${Date.parse(event.at) || Date.now()}_${result.history.length + 1}`,
    state: "pending_reconcile",
    source_lifecycle: sourceLifecycle,
    source_stage: sourceStage,
    source_role: sourceRole,
    source_child_run_id: event.source_child_run_id,
    artifact_kind: event.artifact_kind,
    status: event.status,
    category: event.category,
    severity: event.severity,
    retryable: event.retryable,
    summary: event.summary,
    attempt_count: previousAttempt + 1,
    payload: event.payload ?? {},
    created_at: event.at,
    last_reconciled_at: null,
  };

  for (const childRun of snapshot.runtime_context_json.child_runs ?? []) {
    if (childRun.status === "running" || childRun.status === "queued") {
      childRun.status = event.severity === "blocked" ? "blocked" : "failed";
      childRun.last_seen_at = event.at;
    }
  }

  appendHistory(result, "exception_raised", snapshot.runtime_context_json.exception as Record<string, unknown>);
}

function resumeQuarantined(
  result: StateMachineResult,
  event: Extract<RuntimeEvent, { type: "resume_quarantined" }>,
): void {
  if (result.snapshot.lifecycle_state !== "quarantined") {
    addMessage(result, "resume_requires_quarantined", "Only quarantined issues can be resumed.");
    return;
  }

  if (event.lease) {
    result.snapshot.runtime_context_json.owner_lease = event.lease;
    result.snapshot.current_session_id = event.lease.root_session_id;
    result.snapshot.lifecycle_state = "running";
    appendHistory(result, "owner_lease_acquired", { lease_id: event.lease.lease_id, role: event.lease.role });
    return;
  }

  if (event.host_liveness === "live" && result.snapshot.runtime_context_json.owner_lease) {
    result.snapshot.lifecycle_state = "running";
    appendHistory(result, "issue_resumed", { host_liveness: "live" });
    return;
  }

  addMessage(result, "resume_requires_owner_lease", "Resume requires a new owner lease or host-confirmed live lease.");
}

function operatorResumeToReady(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  event: Extract<RuntimeEvent, { type: "operator_resume_to_ready" }>,
): void {
  if (result.snapshot.lifecycle_state !== "quarantined") {
    addMessage(result, "resume_requires_quarantined", "Only quarantined issues can be resumed.");
    return;
  }

  const exception = objectLike(result.snapshot.runtime_context_json.exception);
  const targetStage = operatorResumeTargetStage(result.snapshot, workflow, exception);
  const carryForward = operatorResumeCarryForward(result.snapshot, exception);

  result.snapshot.lifecycle_state = "ready";
  delete result.snapshot.current_session_id;
  delete result.snapshot.runtime_context_json.owner_lease;
  delete result.snapshot.runtime_context_json.stage_cursor;
  delete result.snapshot.runtime_context_json.current_stage;
  delete result.snapshot.runtime_context_json.blocked_by;
  delete result.snapshot.runtime_context_json.last_error;
  delete result.snapshot.runtime_context_json.exception;
  delete result.snapshot.runtime_context_json.exception_carry_forward;
  delete result.snapshot.runtime_context_json.runtime_recovery;
  delete result.snapshot.runtime_context_json.child_runs;
  if (targetStage) {
    result.snapshot.runtime_context_json.stage_cursor = targetStage;
  }
  if (Object.keys(carryForward).length > 0) {
    result.snapshot.runtime_context_json.exception_carry_forward = carryForward;
  }
  appendHistory(result, "operator_resume", {
    reason: event.reason,
    target: event.target ?? "ready",
    ...(targetStage ? { target_stage: targetStage } : {}),
  });
}

function operatorResumeTargetStage(
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  exception: Record<string, unknown>,
): string | undefined {
  const sourceStage = stringValueForException(exception.source_stage);
  if (!sourceStage || !workflow.stages[sourceStage]) return undefined;

  if (
    exception.artifact_kind === "verification_result" &&
    exception.status === "failed_retryable" &&
    sourceStage === verificationStageName(workflow)
  ) {
    if (verificationFailureOwner(exception) === "release") {
      return releaseStageName(workflow) ?? sourceStage;
    }
    return firstStageName(workflow);
  }

  if (
    exception.artifact_kind === "release_result" ||
    workflow.stages[sourceStage]?.lifecycle_state === "releasing"
  ) {
    return sourceStage;
  }

  return snapshot.runtime_context_json.stage_cursor && workflow.stages[snapshot.runtime_context_json.stage_cursor]
    ? snapshot.runtime_context_json.stage_cursor
    : sourceStage;
}

function operatorResumeCarryForward(
  snapshot: IssueSnapshot,
  exception: Record<string, unknown>,
): Record<string, unknown> {
  const hasResumeContext = typeof exception.source_stage === "string" || typeof exception.artifact_kind === "string";
  const carry: Record<string, unknown> = hasResumeContext
    ? { ...objectLike(snapshot.runtime_context_json.exception_carry_forward) }
    : {};
  const payload = objectLike(exception.payload);
  const summary = stringValueForException(exception.summary);

  if (summary && carry.error === undefined) {
    carry.error = summary;
  }

  if (exception.artifact_kind === "verification_result" && exception.status === "failed_retryable") {
    const feedback = payload.feedback_for_implementation;
    if (Array.isArray(feedback) && feedback.some((item) => typeof item === "string" && item.length > 0)) {
      carry.feedback_for_implementation = feedback.filter((item): item is string => typeof item === "string" && item.length > 0);
    }
    const releaseFeedback = payload.feedback_for_release;
    if (Array.isArray(releaseFeedback) && releaseFeedback.some((item) => typeof item === "string" && item.length > 0)) {
      carry.feedback_for_release = releaseFeedback.filter((item): item is string => typeof item === "string" && item.length > 0);
    }
  }

  if (exception.artifact_kind === "release_result") {
    const release = objectLike(payload.release);
    const localSync = objectLike(release.local_sync);
    const cleanup = objectLike(release.worktree_cleanup);
    const releaseContext: Record<string, unknown> = {};
    const mergeCommit = stringValueForException(release.merge_commit);
    const localHead = stringValueForException(localSync.local_head);
    const remoteHead = stringValueForException(localSync.remote_head);
    const cleanupPath = stringValueForException(cleanup.path);
    if (mergeCommit) releaseContext.merge_commit = mergeCommit;
    if (localHead) releaseContext.local_head = localHead;
    if (remoteHead) releaseContext.remote_head = remoteHead;
    if (cleanupPath) releaseContext.worktree_cleanup_path = cleanupPath;
    if (Object.keys(releaseContext).length > 0) {
      carry.release_context = releaseContext;
    }
  }

  return carry;
}

function verificationFailureOwner(exception: Record<string, unknown>): string | undefined {
  return stringValueForException(objectLike(exception.payload).failure_owner);
}

function applyGateResult(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  event: Extract<RuntimeEvent, { type: "gate_result" }>,
): void {
  const stage = currentStage(result.snapshot, workflow);
  const target = gateTarget(stage, event.status);
  if (target) {
    applyTransitionTarget(result.snapshot, workflow, target);
  }
  appendHistory(result, "gate_result", { status: event.status });
}

function startRelease(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  _event: Extract<RuntimeEvent, { type: "start_release" }>,
): void {
  const lease = result.snapshot.runtime_context_json.owner_lease;
  if (result.snapshot.lifecycle_state !== "verified" && result.snapshot.lifecycle_state !== "release_pending") {
    addMessage(result, "release_requires_verified", "Release can only start from verified or release_pending.");
    return;
  }
  if (!lease || !isReleaseRole(workflow, lease.role)) {
    addMessage(result, "release_requires_owner_lease", "Release requires a release-stage owner lease.");
    return;
  }

  const stageName = releaseStageName(workflow);
  if (!stageName) {
    addMessage(result, "release_stage_missing", "Workflow does not define a release stage.");
    return;
  }

  result.snapshot.runtime_context_json.stage_cursor = stageName;
  result.snapshot.lifecycle_state = "releasing";
  appendHistory(result, "release_started", { lease_id: lease.lease_id, root_session_id: lease.root_session_id });
}

function requireReleaseApproval(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  _event: Extract<RuntimeEvent, { type: "release_approval_required" }>,
): void {
  if (result.snapshot.lifecycle_state !== "verified") {
    addMessage(result, "release_approval_requires_verified", "Release approval can only be required after verification.");
    return;
  }
  const stageName = releaseStageName(workflow);
  if (!stageName) {
    addMessage(result, "release_stage_missing", "Workflow does not define a release stage.");
    return;
  }
  result.snapshot.runtime_context_json.stage_cursor = stageName;
  result.snapshot.lifecycle_state = "release_pending";
  appendHistory(result, "release_approval_required", { target_stage: stageName });
}

function currentStage(snapshot: IssueSnapshot, workflow: WorkflowDefinition) {
  const stageName = snapshot.runtime_context_json.stage_cursor ?? firstStageName(workflow);
  return workflow.stages[stageName];
}

function firstStageName(workflow: WorkflowDefinition): string {
  return Object.keys(workflow.stages)[0];
}

function verificationStageName(workflow: WorkflowDefinition): string | undefined {
  return Object.entries(workflow.stages)
    .find(([, stage]) => stage.lifecycle_state === "verifying")?.[0];
}

function releaseStageName(workflow: WorkflowDefinition): string | undefined {
  return Object.entries(workflow.stages)
    .find(([, stage]) => stage.lifecycle_state === "releasing")?.[0];
}

function isReleaseRole(workflow: WorkflowDefinition, role: string): boolean {
  return Object.values(workflow.stages).some((stage) =>
    stage.lifecycle_state === "releasing" && stage.role === role
  );
}

function childTarget(stage: ReturnType<typeof currentStage>, status: string): string | undefined {
  if (status === "succeeded") {
    return stage.on_success ?? stage.on_pass;
  }
  return undefined;
}

function gateTarget(stage: ReturnType<typeof currentStage>, status: string): string | undefined {
  if (status === "pass") {
    return stage.on_pass ?? stage.on_success;
  }
  if (status === "fail_retryable") {
    return stage.on_fail_retryable ?? stage.on_failed_retryable;
  }
  if (status === "fail_terminal") {
    return stage.on_fail_terminal ?? stage.on_failed_terminal;
  }
  return undefined;
}

function applyTransitionTarget(snapshot: IssueSnapshot, workflow: WorkflowDefinition, target: string): void {
  if (workflow.stages[target]) {
    releaseActiveOwnership(snapshot);
    snapshot.runtime_context_json.stage_cursor = target;
    snapshot.lifecycle_state = workflow.stages[target].lifecycle_state as LifecycleState;
    normalizeTerminalRuntime(snapshot);
    return;
  }

  if (isLifecycleState(target)) {
    releaseActiveOwnership(snapshot);
    snapshot.lifecycle_state = target;
    normalizeTerminalRuntime(snapshot);
  }
}

function releaseActiveOwnership(snapshot: IssueSnapshot): void {
  delete snapshot.current_session_id;
  delete snapshot.runtime_context_json.owner_lease;
}

function childStatusForTerminal(state: "completed" | "cancelled" | "failed" | "quarantined") {
  if (state === "completed") return "succeeded";
  if (state === "quarantined" || state === "cancelled") return "blocked";
  return "failed";
}

function childStatusFromArtifact(status: string) {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "blocked") {
    return "blocked";
  }
  return "failed";
}

function artifactStatusFromChildEvent(event: Extract<RuntimeEvent, { type: "child_artifact" }>) {
  if (event.status !== "succeeded") {
    return event.status;
  }
  const payloadStatus = event.payload?.status;
  if (typeof payloadStatus === "string" && ["ready_for_verification", "pass", "completed"].includes(payloadStatus)) {
    return payloadStatus;
  }
  const artifactKind = event.artifact_kind ?? event.payload?.artifact_kind;
  if (artifactKind === "evidence_packet") {
    return "pass";
  }
  return "success";
}

function shouldValidateChildArtifact(event: Extract<RuntimeEvent, { type: "child_artifact" }>): boolean {
  return event.artifact_kind !== undefined || event.payload !== undefined;
}

function artifactIssueNumber(snapshot: IssueSnapshot): number {
  const packet = snapshot.runtime_context_json.issue_packet;
  if (typeof packet === "object" && packet !== null && "issue_number" in packet) {
    const value = Number((packet as { issue_number?: unknown }).issue_number);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return Number(snapshot.issue_id);
}

function stringValueForException(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectLike(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function appendHistory(result: StateMachineResult, event_type: string, payload: Record<string, unknown>): void {
  result.history.push({ event_type, payload });
}

function addMessage(result: StateMachineResult, code: string, message: string): void {
  const operatorMessage: OperatorMessage = { code, message };
  result.operatorMessages.push(operatorMessage);
}

function isActive(state: LifecycleState): boolean {
  return activeLifecycleStates.includes(state);
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function cloneSnapshot(snapshot: IssueSnapshot): IssueSnapshot {
  return structuredClone(snapshot) as IssueSnapshot;
}
