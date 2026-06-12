import type { AgentHarness, HarnessRunResult } from "../harness/types.ts";
import { evaluateArtifactGate } from "./root-session.ts";
import type { TaskEnvelope } from "./task-envelope.ts";

export type TaskRunnerEvent = {
  eventType: string;
  actorType: string;
  sessionId?: string;
  payload: unknown;
};

export type TaskRunMetrics = {
  durationMs: number;
  toolCalls: number;
  retryCount: number;
  tokens: number;
  costMicrosUsd: number;
};

export type TaskRunResult = {
  runId: string;
  taskId: string;
  rootSessionId: string;
  ok: boolean;
  attempts: number;
  artifact: Record<string, unknown>;
  metrics: TaskRunMetrics;
  events: TaskRunnerEvent[];
  materializationRoot?: string;
};

export async function runTaskEnvelope(
  envelope: TaskEnvelope,
  harness: AgentHarness,
  input: { requiredFields: string[] },
): Promise<TaskRunResult> {
  const events: TaskRunnerEvent[] = [{
    eventType: "session.entry",
    actorType: "root-session",
    sessionId: envelope.rootSession.id,
    payload: {
      rootSessionId: envelope.rootSession.id,
      taskId: envelope.task.id,
      memoryItemCount: envelope.memory.items.length,
    },
  }, {
    eventType: "task.started",
    actorType: "root-session",
    sessionId: envelope.rootSession.id,
    payload: { taskId: envelope.task.id, harnessId: harness.id },
  }];
  const metrics = emptyMetrics();
  let repairInstruction: string | undefined;
  let latestArtifact: Record<string, unknown> = {};

  for (let attempt = 1; attempt <= envelope.rootSession.maxRepairAttempts; attempt++) {
    const harnessResult = await harness.run({ envelope, attempt, repairInstruction });
    addMetrics(metrics, harnessResult.metrics);
    latestArtifact = harnessResult.artifact;
    for (const message of harnessResult.progress) {
      events.push({
        eventType: "progress.commentary",
        actorType: "subagent",
        sessionId: envelope.rootSession.id,
        payload: { message, attempt },
      });
    }
    events.push({
      eventType: "artifact.created",
      actorType: "subagent",
      sessionId: envelope.rootSession.id,
      payload: { attempt, artifact: harnessResult.artifact },
    });

    const gate = evaluateArtifactGate({
      artifact: harnessResult.artifact,
      requiredFields: input.requiredFields,
      attempt,
      maxRepairAttempts: envelope.rootSession.maxRepairAttempts,
    });
    events.push({
      eventType: "evaluator.completed",
      actorType: "evaluator",
      sessionId: envelope.rootSession.id,
      payload: { ok: gate.ok, missingFields: gate.missingFields, attempt },
    });
    if (gate.ok) {
      events.push({
        eventType: "subagent.completed",
        actorType: "subagent",
        sessionId: envelope.rootSession.id,
        payload: { subagentIds: envelope.subagents.map((subagent) => subagent.id), attempt },
      });
      return {
        runId: envelope.runId,
        taskId: envelope.task.id,
        rootSessionId: envelope.rootSession.id,
        ok: true,
        attempts: attempt,
        artifact: latestArtifact,
        metrics,
        events,
      };
    }
    if (gate.decision === "repair") {
      repairInstruction = gate.repairInstruction;
      events.push({
        eventType: "repair.requested",
        actorType: "root-session",
        sessionId: envelope.rootSession.id,
        payload: { attempt, missingFields: gate.missingFields, repairInstruction },
      });
    }
  }

  return {
    runId: envelope.runId,
    taskId: envelope.task.id,
    rootSessionId: envelope.rootSession.id,
    ok: false,
    attempts: envelope.rootSession.maxRepairAttempts,
    artifact: latestArtifact,
    metrics,
    events,
  };
}

function emptyMetrics(): TaskRunMetrics {
  return { durationMs: 0, toolCalls: 0, retryCount: 0, tokens: 0, costMicrosUsd: 0 };
}

function addMetrics(target: TaskRunMetrics, next: HarnessRunResult["metrics"]): void {
  if (!next) return;
  target.durationMs += numberValue(next.durationMs);
  target.toolCalls += numberValue(next.toolCalls);
  target.retryCount += numberValue(next.retryCount);
  target.tokens += numberValue(next.tokens);
  target.costMicrosUsd += numberValue(next.costMicrosUsd);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
