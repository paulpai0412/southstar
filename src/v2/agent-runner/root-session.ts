import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import { recomputeManagementMetrics } from "../stores/metrics-store.ts";
import { appendRuntimeEvent } from "../signals/events.ts";
import { persistEvaluatorResult } from "../evaluators/runner.ts";
import { recordProgressCommentary } from "../signals/progress.ts";
import type { TaskEnvelope } from "./task-envelope.ts";
import type { AgentHarness } from "../harness/types.ts";

export type ArtifactGateInput = {
  artifact: Record<string, unknown>;
  requiredFields: string[];
  attempt: number;
  maxRepairAttempts: number;
};

export type ArtifactGateResult = {
  ok: boolean;
  missingFields: string[];
  decision: "pass" | "repair" | "fail";
  repairInstruction?: string;
};

export function evaluateArtifactGate(input: ArtifactGateInput): ArtifactGateResult {
  const missingFields = input.requiredFields.filter((field) => !hasValue(input.artifact[field]));
  if (missingFields.length === 0) {
    return { ok: true, missingFields: [], decision: "pass" };
  }
  if (input.attempt >= input.maxRepairAttempts) {
    return { ok: false, missingFields, decision: "fail" };
  }
  return {
    ok: false,
    missingFields,
    decision: "repair",
    repairInstruction: `Artifact is missing required fields: ${missingFields.join(", ")}. Re-run the subagent and return a complete artifact.`,
  };
}

export type RootSessionTaskInput = {
  envelope: TaskEnvelope;
  harness: AgentHarness;
  requiredFields: string[];
};

export type RootSessionTaskResult = {
  ok: boolean;
  attempts: number;
  artifactResourceId?: string;
  checkpointResourceId?: string;
};

export async function runRootSessionTask(
  db: SouthstarDb,
  input: RootSessionTaskInput,
): Promise<RootSessionTaskResult> {
  const { envelope, harness, requiredFields } = input;
  appendRuntimeEvent(db, {
    runId: envelope.runId,
    taskId: envelope.task.id,
    sessionId: envelope.rootSession.id,
    eventType: "session.entry",
    actorType: "root-session",
    payload: {
      rootSessionId: envelope.rootSession.id,
      taskId: envelope.task.id,
      memoryItemCount: envelope.memory.items.length,
    },
  });
  appendRuntimeEvent(db, {
    runId: envelope.runId,
    taskId: envelope.task.id,
    sessionId: envelope.rootSession.id,
    eventType: "task.started",
    actorType: "root-session",
    payload: { taskId: envelope.task.id, harnessId: harness.id },
  });

  let repairInstruction: string | undefined;
  for (let attempt = 1; attempt <= envelope.rootSession.maxRepairAttempts; attempt++) {
    const harnessResult = await harness.run({ envelope, attempt, repairInstruction });
    for (const message of harnessResult.progress) {
      recordProgressCommentary(db, {
        runId: envelope.runId,
        taskId: envelope.task.id,
        sessionId: envelope.rootSession.id,
        message,
      });
    }
    const artifactResourceId = `artifact-${envelope.runId}-${envelope.task.id}-attempt-${attempt}`;
    upsertRuntimeResource(db, {
      id: artifactResourceId,
      resourceType: "artifact",
      resourceKey: artifactResourceId,
      runId: envelope.runId,
      taskId: envelope.task.id,
      sessionId: envelope.rootSession.id,
      scope: "task",
      status: "created",
      title: `Artifact attempt ${attempt}`,
      payload: harnessResult.artifact,
      metrics: harnessResult.metrics ?? {},
    });
    appendRuntimeEvent(db, {
      runId: envelope.runId,
      taskId: envelope.task.id,
      sessionId: envelope.rootSession.id,
      eventType: "artifact.created",
      actorType: "subagent",
      payload: { artifactResourceId, attempt },
    });

    const gate = evaluateArtifactGate({
      artifact: harnessResult.artifact,
      requiredFields,
      attempt,
      maxRepairAttempts: envelope.rootSession.maxRepairAttempts,
    });
    persistEvaluatorResult(db, {
      runId: envelope.runId,
      taskId: envelope.task.id,
      ok: gate.ok,
      missingFields: gate.missingFields,
    });
    if (gate.ok) {
      appendRuntimeEvent(db, {
        runId: envelope.runId,
        taskId: envelope.task.id,
        sessionId: envelope.rootSession.id,
        eventType: "subagent.completed",
        actorType: "subagent",
        payload: { subagentIds: envelope.subagents.map((subagent) => subagent.id), attempt },
      });
      upsertRuntimeResource(db, {
        id: artifactResourceId,
        resourceType: "artifact",
        resourceKey: artifactResourceId,
        runId: envelope.runId,
        taskId: envelope.task.id,
        sessionId: envelope.rootSession.id,
        scope: "task",
        status: "accepted",
        title: `Accepted artifact attempt ${attempt}`,
        payload: harnessResult.artifact,
        metrics: harnessResult.metrics ?? {},
      });
      const checkpointResourceId = `checkpoint-${envelope.runId}-${envelope.task.id}`;
      upsertRuntimeResource(db, {
        id: checkpointResourceId,
        resourceType: "session_checkpoint",
        resourceKey: checkpointResourceId,
        runId: envelope.runId,
        taskId: envelope.task.id,
        sessionId: envelope.rootSession.id,
        scope: "task",
        status: "created",
        title: "Root session checkpoint",
        payload: { artifactResourceId, attempt },
      });
      appendRuntimeEvent(db, {
        runId: envelope.runId,
        taskId: envelope.task.id,
        sessionId: envelope.rootSession.id,
        eventType: "checkpoint.created",
        actorType: "root-session",
        payload: { checkpointResourceId, artifactResourceId, attempt },
      });
      recomputeManagementMetrics(db, envelope.runId);
      return { ok: true, attempts: attempt, artifactResourceId, checkpointResourceId };
    }

    if (gate.decision === "repair") {
      repairInstruction = gate.repairInstruction;
      appendHistoryEvent(db, {
        runId: envelope.runId,
        taskId: envelope.task.id,
        sessionId: envelope.rootSession.id,
        eventType: "repair.requested",
        actorType: "root-session",
        payload: { attempt, missingFields: gate.missingFields, repairInstruction },
      });
    }
  }

  recomputeManagementMetrics(db, envelope.runId);
  return { ok: false, attempts: envelope.rootSession.maxRepairAttempts };
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
