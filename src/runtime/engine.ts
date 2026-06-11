import {
  applyRuntimeEvents,
  createOwnerLease,
  newIssueSnapshot,
  type RuntimeEvent,
} from "./state-machine.ts";
import type { HistoryEntry, IssueSnapshot, RuntimeEffect } from "../types/control-plane.ts";
import type { HostAdapter } from "../types/host.ts";
import type { WorkflowDefinition } from "../types/workflow.ts";
import type { SqliteControlPlaneStore } from "./store.ts";

export interface RuntimeEngineOptions {
  store: SqliteControlPlaneStore;
  workflow: WorkflowDefinition;
  collectEvents: (snapshot: IssueSnapshot, recentHistory: HistoryEntry[]) => RuntimeEvent[];
  executeEffects: (effects: RuntimeEffect[], snapshot: IssueSnapshot) => HistoryEntry[];
}

export class RuntimeEngine {
  private readonly options: RuntimeEngineOptions;

  constructor(options: RuntimeEngineOptions) {
    this.options = options;
  }

  cycle(): { processedIssues: number } {
    const issues = this.options.store.listActiveIssues();
    for (const issue of issues) {
      const recentHistory = this.options.store.listRecentHistory(issue.issue_id);
      const events = this.options.collectEvents(issue, recentHistory);
      const result = applyRuntimeEvents(issue, this.options.workflow, events);
      if (result.history.length > 0) {
        this.options.store.appendHistoryBatchAndUpdateSnapshot(issue.issue_id, result.history, result.snapshot);
      }
      let effectResults: HistoryEntry[];
      try {
        effectResults = this.options.executeEffects(result.effects, result.snapshot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        effectResults = result.effects.map((effect) => ({
          event_type: "effect_failed_retryable",
          payload: {
            idempotency_key: effect.idempotency_key,
            effect_type: effect.type,
            status: "failed",
            last_error: message,
          },
        }));
      }
      for (const history of effectResults) {
        this.options.store.recordIdempotentHistory(issue.issue_id, history);
      }
    }

    return { processedIssues: issues.length };
  }
}

export type EngineCommand =
  | { type: "start"; issue_id: string }
  | {
      type: "child_artifact";
      issue_id: string;
      child_run_id: string;
      status: "succeeded" | "blocked" | "failed_retryable" | "failed_terminal";
    };

export interface EngineCommandCycleOptions {
  store: SqliteControlPlaneStore;
  workflow: WorkflowDefinition;
  host: HostAdapter;
  now: string;
  command: EngineCommand;
  leaseTtlSeconds?: number;
}

export function runEngineCommandCycle(options: EngineCommandCycleOptions): { snapshot: IssueSnapshot; history: HistoryEntry[] } {
  if (options.command.type === "start") {
    return runStartCommand(options);
  }
  return runChildArtifactCommand(options);
}

export function runWorkflowToIdle(workflow: WorkflowDefinition): IssueSnapshot {
  const now = "2026-05-29T03:00:00.000Z";
  let snapshot = newIssueSnapshot("engine-smoke", {
    lifecycle_state: "claimed",
    owner_lease: createOwnerLease({
      lease_id: "lease-engine",
      root_session_id: "root-engine",
      role: workflow.stages[Object.keys(workflow.stages)[0]].role,
      now,
      ttl_seconds: 180,
    }),
    stage_cursor: Object.keys(workflow.stages)[0],
  });

  for (let index = 0; index < 10; index++) {
    const stageName = snapshot.runtime_context_json.stage_cursor;
    if (!stageName) {
      return snapshot;
    }

    const stage = workflow.stages[stageName];
    if (!stage || snapshot.lifecycle_state === "completed" || snapshot.lifecycle_state === "release_pending" || snapshot.lifecycle_state === "releasing") {
      return snapshot;
    }

    if (stage.on_pass) {
      snapshot = applyRuntimeEvents(snapshot, workflow, [{ type: "gate_result", status: "pass", at: now }]).snapshot;
    } else {
      snapshot = applyRuntimeEvents(snapshot, workflow, [{
        type: "child_artifact",
        child_run_id: `engine-child-${index}`,
        status: "succeeded",
        artifact_history_id: index + 1,
        at: now,
      }]).snapshot;
    }
  }

  return snapshot;
}

function runStartCommand(options: EngineCommandCycleOptions): { snapshot: IssueSnapshot; history: HistoryEntry[] } {
  const snapshot = options.store.getIssue(options.command.issue_id);
  const stageName = snapshot.runtime_context_json.stage_cursor ?? firstStageName(options.workflow);
  const stage = options.workflow.stages[stageName];
  if (!stage) {
    throw new Error(`Unknown workflow stage: ${stageName}`);
  }
  const role = options.workflow.roles[stage.role];
  if (!role) {
    throw new Error(`Unknown workflow role: ${stage.role}`);
  }

  const root = options.host.startRootSession({
    issue_id: snapshot.issue_id,
    role_name: stage.role,
    role,
  });
  const lease = createOwnerLease({
    lease_id: `lease-${snapshot.issue_id}-1`,
    root_session_id: root.root_session_id,
    role: stage.role,
    now: options.now,
    ttl_seconds: options.leaseTtlSeconds ?? 180,
  });
  const claimed = applyRuntimeEvents(snapshot, options.workflow, [{ type: "claim_owner_lease", lease }]);
  options.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, claimed.history, claimed.snapshot);

  const child = options.host.startBackgroundChild({
    issue_id: snapshot.issue_id,
    lease_id: lease.lease_id,
    root_session_id: lease.root_session_id,
    role_name: stage.role,
    role,
  });
  const started = applyRuntimeEvents(claimed.snapshot, options.workflow, [{
    type: "start_stage",
    child_run_id: child.child_run_id,
    session_id: child.session_id,
    capability_report: child.capability_report,
    at: options.now,
  }]);
  options.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, started.history, started.snapshot);

  return { snapshot: started.snapshot, history: [...claimed.history, ...started.history] };
}

function runChildArtifactCommand(options: EngineCommandCycleOptions): { snapshot: IssueSnapshot; history: HistoryEntry[] } {
  const snapshot = options.store.getIssue(options.command.issue_id);
  const result = applyRuntimeEvents(snapshot, options.workflow, [{
    type: "child_artifact",
    child_run_id: options.command.child_run_id,
    status: options.command.status,
    artifact_history_id: options.store.listHistory(snapshot.issue_id).length + 1,
    at: options.now,
  }]);
  options.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, result.history, result.snapshot);

  return { snapshot: result.snapshot, history: result.history };
}

function firstStageName(workflow: WorkflowDefinition): string {
  return Object.keys(workflow.stages)[0];
}
