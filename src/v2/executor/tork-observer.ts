import type { SouthstarDb } from "../db/postgres.ts";
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
import type { RuntimeExceptionKind } from "../exceptions/types.ts";

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
  input: { now?: string } = {},
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
  kind: "tork_queue_timeout" | "tork_running_hang";
  observedAt: string;
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
    },
  });
  const classification = await input.controller.classify(exception);
  await input.controller.decide(classification);
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
