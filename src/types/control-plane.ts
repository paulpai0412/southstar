import type { HostCapabilityReport } from "../adapters/host/capabilities.ts";

export const lifecycleStates = [
  "ready",
  "claimed",
  "running",
  "verifying",
  "verified",
  "release_pending",
  "releasing",
  "exception",
  "completed",
  "cancelled",
  "failed",
  "quarantined",
];

export type LifecycleState =
  | "ready"
  | "claimed"
  | "running"
  | "verifying"
  | "verified"
  | "release_pending"
  | "releasing"
  | "exception"
  | "completed"
  | "cancelled"
  | "failed"
  | "quarantined";

export type ChildRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "blocked"
  | "failed"
  | "lost";

export interface OwnerLease {
  lease_id: string;
  root_session_id: string;
  role: string;
  generation: number;
  heartbeat_seq: number;
  last_heartbeat_at: string;
  expires_at: string;
}

export interface ChildRun {
  child_run_id: string;
  lease_id: string;
  root_session_id: string;
  role: string;
  status: ChildRunStatus;
  session_id: string;
  stream_adapter?: HostCapabilityReport["host"];
  stream_session_id?: string;
  stream_child_run_id?: string;
  stream_root_session_id?: string;
  started_at: string;
  last_seen_at: string;
  artifact_history_id?: number;
  capability_report?: HostCapabilityReport;
}

export interface RuntimeExceptionContext {
  id: string;
  state?: "pending_reconcile" | "resolved";
  source_lifecycle?: string;
  source_stage?: string;
  source_role?: string;
  source_child_run_id?: string;
  artifact_kind?: string;
  status?: string;
  category?: string;
  severity?: string;
  retryable?: boolean;
  summary?: string;
  recommended_action?: string;
  target_stage?: string;
  attempt_count?: number;
  max_attempts?: number;
  payload?: Record<string, unknown>;
  created_at?: string;
  last_reconciled_at?: string | null;
  [key: string]: unknown;
}

export interface RuntimeContext {
  owner_lease?: OwnerLease;
  stage_cursor?: string;
  child_runs?: ChildRun[];
  projection_sync?: Array<Record<string, unknown>>;
  release?: Record<string, unknown>;
  exception?: RuntimeExceptionContext;
  exception_carry_forward?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface IssueSnapshot {
  issue_id: string;
  lifecycle_state: LifecycleState;
  current_session_id?: string;
  worktree_path?: string;
  runtime_context_json: RuntimeContext;
}

export interface HistoryEntry {
  id?: number;
  sequence?: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at?: string;
}

export interface OperatorMessage {
  code: string;
  message: string;
}

export interface RuntimeEffect {
  type: string;
  payload: Record<string, unknown>;
  idempotency_key?: string;
}

export interface StateMachineResult {
  snapshot: IssueSnapshot;
  history: HistoryEntry[];
  effects: RuntimeEffect[];
  operatorMessages: OperatorMessage[];
}
