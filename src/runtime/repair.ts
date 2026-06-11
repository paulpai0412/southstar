import type { HistoryEntry, IssueSnapshot, LifecycleState } from "../types/control-plane.ts";
import { activeLifecycleStates, inspectInvariantViolations, normalizeTerminalRuntime } from "./state-machine.ts";
import type { WorkflowDefinition } from "../types/workflow.ts";

export function repairSnapshot(
  snapshot: IssueSnapshot,
  now: string,
  workflow?: WorkflowDefinition,
): { snapshot: IssueSnapshot; history: HistoryEntry[] } {
  let next = structuredClone(snapshot) as IssueSnapshot;
  const history: HistoryEntry[] = [];

  backfillChildRootSessionBindings(next, history);

  if (hasConfirmedMerge(next)) {
    if (next.lifecycle_state !== "completed") {
      next.lifecycle_state = "completed";
      history.push(adminAction("restore_completed_after_confirmed_merge"));
    }
  }

  if (clearVerifiedStaleSessionProjection(next)) {
    history.push(adminAction("clear_verified_stale_session_projection"));
  }

  if (hasMissingExpectedActiveChildRun(next, workflow)) {
    const released = releaseActiveRuntimeOwnership(next, workflow, {
      now,
      reasonCode: "active_issue_missing_child_run",
    });
    next = released.snapshot;
    history.push(...released.history);
  }

  const violations = inspectInvariantViolations(next, now);
  if (violations.length > 0 && activeLifecycleStates.includes(next.lifecycle_state)) {
    const released = releaseActiveRuntimeOwnership(next, workflow, {
      now,
      reasonCode: "active_issue_invalid_owner_lease",
      details: { violations },
    });
    next = released.snapshot;
    history.push(...released.history);
  }

  if (normalizeTerminalRuntime(next)) {
    history.push(adminAction("clear_terminal_stale_session_projection"));
  }

  if (next.lifecycle_state === "ready" && next.current_session_id !== undefined) {
    delete next.current_session_id;
    history.push(adminAction("clear_ready_stale_session_fence"));
  }

  return { snapshot: next, history };
}

export function releaseActiveRuntimeOwnership(
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition | undefined,
  input: {
    now: string;
    reasonCode: string;
    details?: Record<string, unknown>;
  },
): { snapshot: IssueSnapshot; history: HistoryEntry[] } {
  const next = structuredClone(snapshot) as IssueSnapshot;
  const previousLifecycle = next.lifecycle_state;
  const previousStage = workflow ? stageNameForSnapshot(next, workflow) : next.runtime_context_json.stage_cursor;
  const nextLifecycle = lifecycleAfterOwnershipRelease(previousLifecycle);

  delete next.current_session_id;
  delete next.runtime_context_json.owner_lease;
  delete next.runtime_context_json.last_error;
  if (Array.isArray(next.runtime_context_json.blocked_by) && next.runtime_context_json.blocked_by.map(String).includes("host_liveness")) {
    const remaining = next.runtime_context_json.blocked_by.map(String).filter((value) => value !== "host_liveness");
    if (remaining.length > 0) {
      next.runtime_context_json.blocked_by = remaining;
    } else {
      delete next.runtime_context_json.blocked_by;
    }
  } else if (Array.isArray(next.runtime_context_json.blocked_by) && next.runtime_context_json.blocked_by.length === 0) {
    delete next.runtime_context_json.blocked_by;
  }

  for (const childRun of next.runtime_context_json.child_runs ?? []) {
    if (childRun.status === "running" || childRun.status === "queued") {
      childRun.status = "lost";
      childRun.last_seen_at = input.now;
    }
  }

  next.lifecycle_state = nextLifecycle;
  if (nextLifecycle === "exception") {
    const previousAttemptCount = repairAttemptCount(
      next.runtime_context_json.exception,
      input.reasonCode,
      previousStage,
    );
    next.runtime_context_json.exception = {
      id: `exc_repair_${Date.parse(input.now) || 0}`,
      state: "pending_reconcile",
      source_lifecycle: previousLifecycle,
      source_stage: previousStage,
      category: "runtime_invariant",
      severity: "retryable",
      retryable: true,
      summary: input.reasonCode,
      attempt_count: previousAttemptCount + 1,
      payload: input.details ?? {},
      created_at: input.now,
      last_reconciled_at: null,
    };
  }
  if (nextLifecycle === "ready") {
    delete next.runtime_context_json.stage_cursor;
  }
  next.runtime_context_json.runtime_recovery = {
    reason_code: input.reasonCode,
    recovered_at: input.now,
    previous_lifecycle: previousLifecycle,
    ...(previousStage === undefined ? {} : { previous_stage: previousStage }),
    ...(input.details ?? {}),
  };

  return {
    snapshot: next,
    history: [adminAction("release_active_runtime_ownership", {
      reason_code: input.reasonCode,
      previous_lifecycle: previousLifecycle,
      target_lifecycle: next.lifecycle_state,
      ...(previousStage === undefined ? {} : { previous_stage: previousStage }),
      ...(input.details ?? {}),
    })],
  };
}

function repairAttemptCount(exception: unknown, reasonCode: string, previousStage: string | undefined): number {
  if (typeof exception !== "object" || exception === null || Array.isArray(exception)) return 0;
  const record = exception as Record<string, unknown>;
  if (
    record.state !== "pending_reconcile" ||
    record.category !== "runtime_invariant" ||
    record.summary !== reasonCode ||
    record.source_stage !== previousStage
  ) {
    return 0;
  }
  return typeof record.attempt_count === "number" && Number.isFinite(record.attempt_count)
    ? record.attempt_count
    : 0;
}

function lifecycleAfterOwnershipRelease(previousLifecycle: LifecycleState): LifecycleState {
  if (["claimed", "running", "verifying", "releasing"].includes(previousLifecycle)) {
    return "exception";
  }
  return "ready";
}

function hasMissingExpectedActiveChildRun(
  snapshot: IssueSnapshot,
  workflow?: WorkflowDefinition,
): boolean {
  if (!["running", "verifying"].includes(snapshot.lifecycle_state)) {
    return false;
  }

  const childRuns = snapshot.runtime_context_json.child_runs ?? [];
  if (!workflow) {
    return childRuns.length === 0;
  }

  const stageName = stageNameForSnapshot(snapshot, workflow);
  const expectedRole = roleNameForStage(workflow, stageName);
  if (!expectedRole) return true;
  const expectedRun = childRuns.find((run) => run.role === expectedRole);
  return expectedRun === undefined || (expectedRun.status !== "running" && expectedRun.status !== "queued");
}

function stageNameForSnapshot(snapshot: IssueSnapshot, workflow: WorkflowDefinition): string {
  return snapshot.runtime_context_json.stage_cursor ?? Object.keys(workflow.stages)[0];
}

function roleNameForStage(workflow: WorkflowDefinition, stageName: string): string | undefined {
  const stage = workflow.stages[stageName];
  return stage?.role;
}

function clearVerifiedStaleSessionProjection(snapshot: IssueSnapshot): boolean {
  if (snapshot.lifecycle_state !== "verified") return false;

  let changed = false;
  if (snapshot.runtime_context_json.owner_lease) {
    delete snapshot.runtime_context_json.owner_lease;
    changed = true;
  }
  if (snapshot.current_session_id !== undefined && !snapshot.runtime_context_json.owner_lease) {
    delete snapshot.current_session_id;
    changed = true;
  }

  for (const childRun of snapshot.runtime_context_json.child_runs ?? []) {
    if (childRun.status === "running" || childRun.status === "queued") {
      childRun.status = "succeeded";
      changed = true;
    }
  }

  return changed;
}

function backfillChildRootSessionBindings(snapshot: IssueSnapshot, history: HistoryEntry[]): void {
  const lease = snapshot.runtime_context_json.owner_lease;
  const childRuns = snapshot.runtime_context_json.child_runs ?? [];
  if (!lease || childRuns.length === 0) {
    return;
  }

  let changed = false;
  for (const childRun of childRuns) {
    if (childRun.lease_id === lease.lease_id && !childRun.root_session_id) {
      childRun.root_session_id = lease.root_session_id;
      changed = true;
    }
  }

  if (changed) {
    history.push(adminAction("backfill_child_root_session_binding", {
      lease_id: lease.lease_id,
      root_session_id: lease.root_session_id,
    }));
  }
}

function hasConfirmedMerge(snapshot: IssueSnapshot): boolean {
  const release = snapshot.runtime_context_json.release;
  if (typeof release !== "object" || release === null) return false;
  const record = release as Record<string, unknown>;
  return record.pr_merged === true ||
    (record.confirmed === true && typeof record.merge_commit === "string" && record.merge_commit.length > 0);
}

function adminAction(action: string, extra: Record<string, unknown> = {}): HistoryEntry {
  return {
    event_type: "admin_action",
    payload: { action, ...extra },
  };
}
