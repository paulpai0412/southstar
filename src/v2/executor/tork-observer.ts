import type { SouthstarDb } from "../db/postgres.ts";
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
import type { RuntimeExceptionKind } from "../exceptions/types.ts";
import { normalizeTorkStatus, type TorkStatusCategory } from "./observability-types.ts";
import type { RecoveryProviderActions } from "./provider-actions.ts";

type HandExecutionRow = {
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  status: "queued" | "running";
  payload_json: unknown;
};

export async function observeTorkHandExecutionExceptionsPg(
  db: SouthstarDb,
  input: { now?: string; providerActions?: RecoveryProviderActions; providerPollReason?: string } = {},
): Promise<{ observedKinds: string[] }> {
  const now = input.now ? new Date(input.now) : new Date();
  const nowMs = now.getTime();
  const observedAt = now.toISOString();
  const controller = createRuntimeExceptionController({ db });
  const observedKinds: RuntimeExceptionKind[] = [];
  const rows = await db.query<HandExecutionRow>(
    `select resource_key, run_id, task_id, session_id, status, payload_json
       from southstar.runtime_resources
      where resource_type = 'hand_execution'
        and status in ('queued', 'running')
      order by updated_at, resource_key`,
  );

  for (const row of rows.rows) {
    const payload = asRecord(row.payload_json);
    const runId = row.run_id ?? stringValue(payload.runId);
    if (!runId) continue;
    const taskId = row.task_id ?? stringValue(payload.taskId);
    const sessionId = row.session_id ?? stringValue(payload.sessionId);
    const attemptId = stringValue(payload.attemptId);
    const handExecutionId = stringValue(payload.handExecutionId) ?? row.resource_key;
    const externalJobId = stringValue(payload.externalJobId);

    if (externalJobId && input.providerActions?.poll) {
      const providerObservation = await pollProviderStatus({
        providerActions: input.providerActions,
        runId,
        externalJobId,
        reason: input.providerPollReason ?? "observe-tork-provider-status",
      });
      if (providerObservation?.terminal) {
        const patched = await patchTerminalWithoutCallbackPg(db, {
          resourceKey: row.resource_key,
          terminalStatus: terminalHandExecutionStatus(providerObservation.category),
          observedAt,
          torkObservedStatus: providerObservation.status,
        });
        if (!patched) continue;
        await observeAndDecide({
          controller,
          runId,
          taskId,
          sessionId,
          attemptId,
          handExecutionId,
          resourceKey: row.resource_key,
          externalJobId,
          status: row.status,
          kind: "tork_terminal_without_callback",
          observedAt,
          torkObservedStatus: providerObservation.status,
          terminalWithoutCallback: true,
        });
        observedKinds.push("tork_terminal_without_callback");
        continue;
      }
      if (row.status === "queued" && providerObservation?.running) {
        const patched = await patchRunningProviderStatusPg(db, {
          resourceKey: row.resource_key,
          runId,
          taskId,
          sessionId,
          attemptId,
          observedAt,
          startedAt: providerObservation.startedAt ?? observedAt,
          torkObservedStatus: providerObservation.status,
        });
        if (patched) continue;
      }
    }

    if (row.status === "queued") {
      const queuedAt = stringValue(payload.queuedAt);
      const queueTimeoutSeconds = numberValue(payload.queueTimeoutSeconds);
      if (!queuedAt || !queueTimeoutSeconds) continue;
      if (!isExpired(queuedAt, queueTimeoutSeconds, nowMs)) continue;
      await observeAndDecide({
        controller,
        runId,
        taskId,
        sessionId,
        attemptId,
        handExecutionId,
        resourceKey: row.resource_key,
        externalJobId,
        status: row.status,
        kind: "tork_queue_timeout",
        observedAt,
      });
      observedKinds.push("tork_queue_timeout");
      continue;
    }

    const anchor = stringValue(payload.lastHeartbeatAt) ?? stringValue(payload.startedAt);
    const heartbeatTimeoutSeconds = numberValue(payload.heartbeatTimeoutSeconds);
    if (!anchor || !heartbeatTimeoutSeconds) continue;
    if (!isExpired(anchor, heartbeatTimeoutSeconds, nowMs)) continue;
    await observeAndDecide({
      controller,
      runId,
      taskId,
      sessionId,
      attemptId,
      handExecutionId,
      resourceKey: row.resource_key,
      externalJobId,
      status: row.status,
      kind: "tork_running_hang",
      observedAt,
    });
    observedKinds.push("tork_running_hang");
  }

  return { observedKinds };
}

async function observeAndDecide(input: {
  controller: ReturnType<typeof createRuntimeExceptionController>;
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  handExecutionId: string;
  resourceKey: string;
  externalJobId?: string;
  status: "queued" | "running";
  kind: "tork_queue_timeout" | "tork_running_hang" | "tork_terminal_without_callback";
  observedAt: string;
  torkObservedStatus?: string;
  terminalWithoutCallback?: boolean;
}): Promise<void> {
  const exception = await input.controller.observe({
    runId: input.runId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    handExecutionId: input.handExecutionId,
    source: "tork-observer",
    kind: input.kind,
    severity: "recoverable",
    observedAt: input.observedAt,
    evidenceRefs: [input.resourceKey],
    providerEvidence: {
      ...(input.externalJobId ? { externalJobId: input.externalJobId } : {}),
      status: input.status,
      ...(input.torkObservedStatus ? { torkObservedStatus: input.torkObservedStatus } : {}),
      ...(input.terminalWithoutCallback ? { terminalWithoutCallback: true } : {}),
    },
  });
  const classification = await input.controller.classify(exception);
  await input.controller.decide(classification);
}

async function pollProviderStatus(input: {
  providerActions: RecoveryProviderActions;
  runId: string;
  externalJobId: string;
  reason: string;
}): Promise<{
  status: string;
  category: TorkStatusCategory;
  terminal: boolean;
  running: boolean;
  startedAt?: string;
} | null> {
  let observation: unknown;
  try {
    observation = await input.providerActions.poll?.({
      externalJobId: input.externalJobId,
      runId: input.runId,
      reason: input.reason,
    });
  } catch {
    return null;
  }
  const status = extractProviderStatus(observation);
  const normalized = normalizeTorkStatus(status);
  const terminal = normalized.category === "failed-like"
    || normalized.category === "cancelled-like"
    || normalized.category === "completed-like";
  const startedAt = extractProviderStartedAt(observation);
  const running = normalized.category === "running-like" || Boolean(startedAt && !terminal);
  if (terminal || running) {
    return {
      status: normalized.raw,
      category: normalized.category,
      terminal,
      running,
      ...(startedAt ? { startedAt } : {}),
    };
  }
  return null;
}

async function patchRunningProviderStatusPg(db: SouthstarDb, input: {
  resourceKey: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  observedAt: string;
  startedAt: string;
  torkObservedStatus: string;
}): Promise<boolean> {
  const patch = {
    status: "running",
    startedAt: input.startedAt,
    lastProviderObservedAt: input.observedAt,
    torkObservedStatus: input.torkObservedStatus,
  };
  const result = await db.query(
    `update southstar.runtime_resources
        set status = 'running',
            session_id = coalesce(session_id, $2),
            payload_json = payload_json || $3::jsonb,
            summary_json = summary_json || $4::jsonb,
            updated_at = now()
      where resource_type = 'hand_execution'
        and resource_key = $1
        and status = 'queued'`,
    [
      input.resourceKey,
      input.sessionId ?? null,
      JSON.stringify(patch),
      JSON.stringify({ status: "running", ...(input.attemptId ? { attemptId: input.attemptId } : {}) }),
    ],
  );
  if ((result.rowCount ?? 0) === 0) return false;
  if (input.taskId) {
    await db.query(
      "update southstar.workflow_tasks set status = 'running', updated_at = now() where run_id = $1 and id = $2 and status in ('queued', 'claimed')",
      [input.runId, input.taskId],
    );
  }
  return true;
}

function isTerminalProviderCategory(category: TorkStatusCategory): boolean {
  return category === "failed-like" || category === "cancelled-like" || category === "completed-like";
}

function extractProviderStartedAt(value: unknown): string | undefined {
  const record = asRecord(value);
  const raw = asRecord(record.raw);
  return firstStartedAtFromExecutions(record.execution)
    ?? firstStartedAtFromExecutions(raw.execution);
}

function firstStartedAtFromExecutions(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const execution = asRecord(item);
    const startedAt = stringValue(execution.startedAt);
    if (!startedAt) continue;
    const status = stringValue(execution.status) ?? stringValue(execution.state);
    const normalized = normalizeTorkStatus(status);
    if (isTerminalProviderCategory(normalized.category)) continue;
    if (stringValue(execution.completedAt) || stringValue(execution.finishedAt) || stringValue(execution.endedAt)) continue;
    return startedAt;
  }
  return undefined;
}

async function patchTerminalWithoutCallbackPg(db: SouthstarDb, input: {
  resourceKey: string;
  terminalStatus: "failed" | "cancelled" | "lost";
  observedAt: string;
  torkObservedStatus: string;
}): Promise<boolean> {
  const patch = {
    status: input.terminalStatus,
    terminalAt: input.observedAt,
    terminalReason: "tork_terminal_without_callback",
    terminalWithoutCallback: true,
    torkObservedStatus: input.torkObservedStatus,
  };
  const result = await db.query(
    `update southstar.runtime_resources
        set status = $2,
            payload_json = payload_json || $3::jsonb,
            updated_at = now()
      where resource_type = 'hand_execution'
        and resource_key = $1
        and status in ('queued', 'running')`,
    [input.resourceKey, input.terminalStatus, JSON.stringify(patch)],
  );
  return (result.rowCount ?? 0) > 0;
}

function terminalHandExecutionStatus(category: TorkStatusCategory): "failed" | "cancelled" | "lost" {
  if (category === "cancelled-like") return "cancelled";
  if (category === "completed-like") return "lost";
  return "failed";
}

function extractProviderStatus(value: unknown): string | undefined {
  const record = asRecord(value);
  return stringValue(record.status)
    ?? stringValue(record.state)
    ?? stringValue(asRecord(record.raw).status)
    ?? stringValue(asRecord(record.raw).state);
}

function isExpired(anchor: string, timeoutSeconds: number, nowMs: number): boolean {
  const anchorMs = Date.parse(anchor);
  return Number.isFinite(anchorMs) && anchorMs + timeoutSeconds * 1000 < nowMs;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
