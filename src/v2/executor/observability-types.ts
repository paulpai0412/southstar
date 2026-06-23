export type SouthstarExecutorStatus =
  | "submitted"
  | "queued"
  | "starting"
  | "running"
  | "heartbeat-lost"
  | "queue-timeout"
  | "hard-timeout"
  | "callback-missing"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost"
  | "orphaned";

export type RunnerPhase =
  | "booting"
  | "root-session-started"
  | "subagent-running"
  | "artifact-uploading"
  | "callback-sent"
  | "shutdown";

export type ExecutorBindingPayload = {
  runId: string;
  taskId: string;
  attemptId: string;
  executorType: "tork";
  torkJobId: string;
  torkTaskId?: string;
  status?: SouthstarExecutorStatus;
  containerId?: string;
  southstarExecutorStatus: SouthstarExecutorStatus;
  torkObservedStatus?: string;
  dockerObservedStatus?: string;
  submittedAt: string;
  startedAt?: string;
  lastTorkObservedAt?: string;
  lastHeartbeatAt?: string;
  heartbeatSeq?: number;
  runnerPhase?: RunnerPhase;
  queueTimeoutAt: string;
  heartbeatTimeoutAt?: string;
  hardTimeoutAt: string;
  callbackReceivedAt?: string;
  terminalObservedAt?: string;
  reconcileGeneration: number;
  lastReconcileAt?: string;
  lastReconcileError?: string;
  logsRef?: string;
  idempotencyKey: string;
};

export type BindingValidationResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: string[] };

export type TorkStatusCategory =
  | "queued-like"
  | "running-like"
  | "completed-like"
  | "failed-like"
  | "cancelled-like"
  | "unknown";

export type NormalizedTorkStatus = {
  raw: string;
  category: TorkStatusCategory;
};

const TERMINAL_STATUSES: SouthstarExecutorStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "lost",
  "orphaned",
];

const ALL_STATUSES: SouthstarExecutorStatus[] = [
  "submitted",
  "queued",
  "starting",
  "running",
  "heartbeat-lost",
  "queue-timeout",
  "hard-timeout",
  "callback-missing",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "lost",
  "orphaned",
];

export function validateExecutorBindingPayload(payload: unknown): BindingValidationResult {
  if (!isRecord(payload)) {
    return { ok: false, issues: ["payload must be an object"] };
  }

  const issues: string[] = [];
  for (const field of [
    "runId",
    "taskId",
    "attemptId",
    "executorType",
    "torkJobId",
    "southstarExecutorStatus",
    "submittedAt",
    "queueTimeoutAt",
    "hardTimeoutAt",
    "idempotencyKey",
  ] as const) {
    if (typeof payload[field] !== "string" || payload[field].length === 0) {
      issues.push(`${field} must be a non-empty string`);
    }
  }

  if (payload.executorType !== "tork") {
    issues.push("executorType must be tork");
  }

  if (typeof payload.reconcileGeneration !== "number" || !Number.isFinite(payload.reconcileGeneration)) {
    issues.push("reconcileGeneration must be a finite number");
  }

  if (!isKnownStatus(payload.southstarExecutorStatus)) {
    issues.push("southstarExecutorStatus is not supported");
  }

  return issues.length === 0
    ? { ok: true, issues: [] }
    : { ok: false, issues };
}

export function isExecutorTerminalStatus(status: SouthstarExecutorStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function normalizeTorkStatus(status: string | undefined): NormalizedTorkStatus {
  const raw = status ?? "";
  const normalized = raw.toUpperCase();

  if (["CREATED", "PENDING", "QUEUED", "SCHEDULED"].includes(normalized)) {
    return { raw, category: "queued-like" };
  }

  if (["RUNNING", "STARTED", "ACTIVE"].includes(normalized)) {
    return { raw, category: "running-like" };
  }

  if (["COMPLETED", "SUCCEEDED", "SUCCESS", "PASSED"].includes(normalized)) {
    return { raw, category: "completed-like" };
  }

  if (["FAILED", "ERROR", "ERRORED", "TIMED_OUT", "TIMEOUT"].includes(normalized)) {
    return { raw, category: "failed-like" };
  }

  if (["CANCELLED", "CANCELED", "ABORTED"].includes(normalized)) {
    return { raw, category: "cancelled-like" };
  }

  return { raw, category: "unknown" };
}

export function classifyExecutorTimeouts(payload: ExecutorBindingPayload, nowMs = Date.now()): SouthstarExecutorStatus[] {
  const findings: SouthstarExecutorStatus[] = [];

  if (["submitted", "queued"].includes(payload.southstarExecutorStatus) && Date.parse(payload.queueTimeoutAt) <= nowMs) {
    findings.push("queue-timeout");
  }

  const normalized = normalizeTorkStatus(payload.torkObservedStatus);
  if (normalized.category === "running-like"
    && payload.heartbeatTimeoutAt
    && Date.parse(payload.heartbeatTimeoutAt) <= nowMs) {
    findings.push("heartbeat-lost");
  }

  if (!isExecutorTerminalStatus(payload.southstarExecutorStatus)
    && Date.parse(payload.hardTimeoutAt) <= nowMs) {
    findings.push("hard-timeout");
  }

  return findings;
}

function isKnownStatus(value: unknown): value is SouthstarExecutorStatus {
  return typeof value === "string" && ALL_STATUSES.includes(value as SouthstarExecutorStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
