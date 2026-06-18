import type { AgentHarness, HarnessRunResult } from "../harness/types.ts";
import { evaluateArtifactGate } from "./root-session.ts";
import type { ArtifactRepairContext } from "./root-session.ts";
import type { AnyTaskEnvelope } from "./task-envelope.ts";

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
  attemptId?: string;
  artifact: Record<string, unknown>;
  metrics: TaskRunMetrics;
  events: TaskRunnerEvent[];
  materializationRoot?: string;
};

export async function runTaskEnvelope(
  envelope: AnyTaskEnvelope,
  harness: AgentHarness,
  input: { requiredFields: string[] },
): Promise<TaskRunResult> {
  const startedAt = Date.now();
  const rootSessionId = envelopeRootSessionId(envelope);
  const taskId = envelopeTaskId(envelope);
  const maxRepairAttempts = envelopeMaxRepairAttempts(envelope);
  const events: TaskRunnerEvent[] = [{
    eventType: "session.entry",
    actorType: "root-session",
    sessionId: rootSessionId,
    payload: {
      rootSessionId,
      taskId,
      memoryItemCount: envelope.schemaVersion === "southstar.task-envelope.v2"
        ? envelope.contextPacket.selectedMemories.length
        : envelope.memory.items.length,
    },
  }, {
    eventType: "task.started",
    actorType: "root-session",
    sessionId: rootSessionId,
    payload: { taskId, harnessId: harness.id },
  }];
  const metrics = emptyMetrics();
  let repairInstruction: string | undefined;
  let latestArtifact: Record<string, unknown> = {};

  for (let attempt = 1; attempt <= maxRepairAttempts; attempt++) {
    const harnessResult = await harness.run({ envelope, attempt, repairInstruction });
    addMetrics(metrics, harnessResult.metrics);
    latestArtifact = harnessResult.artifact;
    for (const message of harnessResult.progress) {
      events.push({
        eventType: "progress.commentary",
        actorType: "subagent",
        sessionId: rootSessionId,
        payload: { message, attempt },
      });
    }
    events.push({
      eventType: "artifact.created",
      actorType: "subagent",
      sessionId: rootSessionId,
      payload: { attempt, artifact: harnessResult.artifact },
    });

    const gate = evaluateArtifactGate({
      artifact: harnessResult.artifact,
      requiredFields: input.requiredFields,
      attempt,
      maxRepairAttempts,
      repairContext: repairContextFromEnvelope(envelope),
    });
    events.push({
      eventType: "evaluator.completed",
      actorType: "evaluator",
      sessionId: rootSessionId,
      payload: { ok: gate.ok, missingFields: gate.missingFields, attempt },
    });
    if (gate.ok) {
      latestArtifact = gate.normalizedArtifact;
      events.push({
        eventType: "subagent.completed",
        actorType: "subagent",
        sessionId: rootSessionId,
        payload: { subagentIds: envelopeSubagentIds(envelope), attempt },
      });
      return {
        runId: envelope.runId,
        taskId,
        rootSessionId,
        ok: true,
        attempts: attempt,
        artifact: latestArtifact,
        metrics: finalizeRuntimeMetrics(metrics, envelope, startedAt),
        events,
      };
    }
    if (gate.decision === "repair") {
      repairInstruction = gate.repairInstruction;
      events.push({
        eventType: "repair.requested",
        actorType: "root-session",
        sessionId: rootSessionId,
        payload: { attempt, missingFields: gate.missingFields, repairInstruction },
      });
    }
  }

  return {
    runId: envelope.runId,
    taskId,
    rootSessionId,
    ok: false,
    attempts: maxRepairAttempts,
    artifact: latestArtifact,
    metrics: finalizeRuntimeMetrics(metrics, envelope, startedAt),
    events,
  };
}

function envelopeTaskId(envelope: AnyTaskEnvelope): string {
  return envelope.schemaVersion === "southstar.task-envelope.v2" ? envelope.taskId : envelope.task.id;
}

function envelopeRootSessionId(envelope: AnyTaskEnvelope): string {
  return envelope.schemaVersion === "southstar.task-envelope.v2" ? envelope.session.sessionId : envelope.rootSession.id;
}

function envelopeMaxRepairAttempts(envelope: AnyTaskEnvelope): number {
  return envelope.schemaVersion === "southstar.task-envelope.v2" ? envelope.session.maxRepairAttempts ?? 1 : envelope.rootSession.maxRepairAttempts;
}

function envelopeSubagentIds(envelope: AnyTaskEnvelope): string[] {
  return envelope.schemaVersion === "southstar.task-envelope.v2"
    ? [envelope.agentProfile.id]
    : envelope.subagents.map((subagent) => subagent.id);
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

function finalizeRuntimeMetrics(metrics: TaskRunMetrics, envelope: AnyTaskEnvelope, startedAt: number): TaskRunMetrics {
  const finalized = { ...metrics };
  finalized.durationMs = Math.max(finalized.durationMs, Date.now() - startedAt, 1);
  if (finalized.tokens <= 0) {
    finalized.tokens = envelopeInputTokenEstimate(envelope);
  }
  return finalized;
}

function envelopeInputTokenEstimate(envelope: AnyTaskEnvelope): number {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return 0;
  return Math.max(0, numberValue(envelope.contextPacket.tokenEstimate.total));
}

function repairContextFromEnvelope(envelope: AnyTaskEnvelope): ArtifactRepairContext | undefined {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return undefined;
  const contract = envelope.artifactContracts[0];
  if (!contract) return undefined;

  const specialized = [...envelope.skills]
    .reverse()
    .find((skill) => skill.fieldGuidance && Object.keys(skill.fieldGuidance).length > 0);
  if (!specialized?.fieldGuidance) return undefined;

  return {
    contractId: contract.id,
    fieldGuidance: specialized.fieldGuidance,
    repairGuidance: specialized.repairGuidance,
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
