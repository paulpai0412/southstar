import { appendHistoryEvent } from "../stores/history-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import {
  listExecutorBindingsForRun,
  updateExecutorBindingStatus,
} from "./bindings.ts";
import type { RunnerPhase } from "./observability-types.ts";

export type ExecutorHeartbeatInput = {
  runId: string;
  taskId: string;
  attemptId: string;
  executorType: "tork";
  torkJobId: string;
  torkTaskId?: string;
  rootSessionId: string;
  heartbeatSeq: number;
  phase: RunnerPhase;
  message?: string;
  observedAt: string;
};

export function recordExecutorHeartbeat(db: SouthstarDb, input: ExecutorHeartbeatInput) {
  const binding = listExecutorBindingsForRun(db, input.runId).find((candidate) => {
    return candidate.taskId === input.taskId
      && candidate.payload.attemptId === input.attemptId
      && candidate.payload.torkJobId === input.torkJobId;
  });

  if (!binding) {
    throw new Error(`executor binding not found for heartbeat: ${input.runId}/${input.taskId}/${input.attemptId}`);
  }

  const heartbeatTimeoutAt = new Date(Date.parse(input.observedAt) + 45_000).toISOString();
  const updated = updateExecutorBindingStatus(db, {
    bindingId: binding.id,
    status: "running",
    eventType: "executor.observed",
    payloadPatch: {
      torkTaskId: input.torkTaskId ?? binding.payload.torkTaskId,
      lastHeartbeatAt: input.observedAt,
      heartbeatSeq: input.heartbeatSeq,
      runnerPhase: input.phase,
      heartbeatTimeoutAt,
      torkObservedStatus: binding.payload.torkObservedStatus ?? "RUNNING",
    },
    eventPayload: {
      reason: "heartbeat advanced runner liveness",
    },
  });

  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.rootSessionId,
    eventType: "executor.heartbeat",
    actorType: "agent-runner",
    idempotencyKey: `executor-heartbeat:${input.runId}:${input.taskId}:${input.attemptId}:${input.heartbeatSeq}`,
    payload: {
      bindingId: binding.id,
      heartbeatSeq: input.heartbeatSeq,
      phase: input.phase,
      message: input.message ?? "",
      observedAt: input.observedAt,
    },
  });

  return updated;
}
