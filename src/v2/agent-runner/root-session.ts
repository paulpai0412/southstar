import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import { recomputeManagementMetrics } from "../stores/metrics-store.ts";
import { appendRuntimeEvent } from "../signals/events.ts";
import { persistEvaluatorResult } from "../evaluators/runner.ts";
import { recordProgressCommentary } from "../signals/progress.ts";
import type { AnyTaskEnvelope } from "./task-envelope.ts";
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
  normalizedArtifact: Record<string, unknown>;
};

export function evaluateArtifactGate(input: ArtifactGateInput): ArtifactGateResult {
  const normalizedArtifact = normalizeArtifactForRequiredFields(input.artifact, input.requiredFields);
  const missingFields = input.requiredFields.filter((field) => !hasValue(normalizedArtifact[field]));
  if (missingFields.length === 0) {
    return { ok: true, missingFields: [], decision: "pass", normalizedArtifact };
  }
  if (input.attempt >= input.maxRepairAttempts) {
    return { ok: false, missingFields, decision: "fail", normalizedArtifact };
  }
  return {
    ok: false,
    missingFields,
    decision: "repair",
    repairInstruction: `Artifact is missing required fields: ${missingFields.join(", ")}. Re-run the subagent and return a complete artifact.`,
    normalizedArtifact,
  };
}

export type RootSessionTaskInput = {
  envelope: AnyTaskEnvelope;
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
  const runtime = normalizeRootSessionEnvelope(envelope);
  appendRuntimeEvent(db, {
    runId: envelope.runId,
    taskId: runtime.taskId,
    sessionId: runtime.rootSessionId,
    eventType: "session.entry",
    actorType: "root-session",
    payload: {
      rootSessionId: runtime.rootSessionId,
      taskId: runtime.taskId,
      memoryItemCount: runtime.memoryItemCount,
    },
  });
  appendRuntimeEvent(db, {
    runId: envelope.runId,
    taskId: runtime.taskId,
    sessionId: runtime.rootSessionId,
    eventType: "task.started",
    actorType: "root-session",
    payload: { taskId: runtime.taskId, harnessId: harness.id },
  });

  let repairInstruction: string | undefined;
  for (let attempt = 1; attempt <= runtime.maxRepairAttempts; attempt++) {
    const harnessResult = await harness.run({ envelope, attempt, repairInstruction });
    for (const message of harnessResult.progress) {
      recordProgressCommentary(db, {
        runId: envelope.runId,
        taskId: runtime.taskId,
        sessionId: runtime.rootSessionId,
        message,
      });
    }
    const artifactResourceId = `artifact-${envelope.runId}-${runtime.taskId}-attempt-${attempt}`;
    upsertRuntimeResource(db, {
      id: artifactResourceId,
      resourceType: "artifact",
      resourceKey: artifactResourceId,
      runId: envelope.runId,
      taskId: runtime.taskId,
      sessionId: runtime.rootSessionId,
      scope: "task",
      status: "created",
      title: `Artifact attempt ${attempt}`,
      payload: harnessResult.artifact,
      metrics: harnessResult.metrics ?? {},
    });
    appendRuntimeEvent(db, {
      runId: envelope.runId,
      taskId: runtime.taskId,
      sessionId: runtime.rootSessionId,
      eventType: "artifact.created",
      actorType: "subagent",
      payload: { artifactResourceId, attempt },
    });

    const gate = evaluateArtifactGate({
      artifact: harnessResult.artifact,
      requiredFields,
      attempt,
      maxRepairAttempts: runtime.maxRepairAttempts,
    });
    persistEvaluatorResult(db, {
      runId: envelope.runId,
      taskId: runtime.taskId,
      ok: gate.ok,
      missingFields: gate.missingFields,
    });
    if (gate.ok) {
      appendRuntimeEvent(db, {
        runId: envelope.runId,
        taskId: runtime.taskId,
        sessionId: runtime.rootSessionId,
        eventType: "subagent.completed",
        actorType: "subagent",
        payload: { subagentIds: runtime.subagentIds, attempt },
      });
      upsertRuntimeResource(db, {
        id: artifactResourceId,
        resourceType: "artifact",
        resourceKey: artifactResourceId,
        runId: envelope.runId,
        taskId: runtime.taskId,
        sessionId: runtime.rootSessionId,
        scope: "task",
        status: "accepted",
        title: `Accepted artifact attempt ${attempt}`,
        payload: gate.normalizedArtifact,
        metrics: harnessResult.metrics ?? {},
      });
      const checkpointResourceId = `checkpoint-${envelope.runId}-${runtime.taskId}`;
      upsertRuntimeResource(db, {
        id: checkpointResourceId,
        resourceType: "session_checkpoint",
        resourceKey: checkpointResourceId,
        runId: envelope.runId,
        taskId: runtime.taskId,
        sessionId: runtime.rootSessionId,
        scope: "task",
        status: "created",
        title: "Root session checkpoint",
        payload: { artifactResourceId, attempt },
      });
      appendRuntimeEvent(db, {
        runId: envelope.runId,
        taskId: runtime.taskId,
        sessionId: runtime.rootSessionId,
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
        taskId: runtime.taskId,
        sessionId: runtime.rootSessionId,
        eventType: "repair.requested",
        actorType: "root-session",
        payload: { attempt, missingFields: gate.missingFields, repairInstruction },
      });
    }
  }

  recomputeManagementMetrics(db, envelope.runId);
  return { ok: false, attempts: runtime.maxRepairAttempts };
}

function normalizeRootSessionEnvelope(envelope: AnyTaskEnvelope): {
  taskId: string;
  rootSessionId: string;
  maxRepairAttempts: number;
  memoryItemCount: number;
  subagentIds: string[];
} {
  if (envelope.schemaVersion === "southstar.task-envelope.v2") {
    return {
      taskId: envelope.taskId,
      rootSessionId: envelope.session.sessionId,
      maxRepairAttempts: envelope.session.maxRepairAttempts ?? 1,
      memoryItemCount: envelope.contextPacket.selectedMemories.length,
      subagentIds: [envelope.agentProfile.id],
    };
  }
  return {
    taskId: envelope.task.id,
    rootSessionId: envelope.rootSession.id,
    maxRepairAttempts: envelope.rootSession.maxRepairAttempts,
    memoryItemCount: envelope.memory.items.length,
    subagentIds: envelope.subagents.map((subagent) => subagent.id),
  };
}

function normalizeArtifactForRequiredFields(
  artifact: Record<string, unknown>,
  requiredFields: string[],
): Record<string, unknown> {
  if (requiredFields.length === 0) return artifact;
  if (requiredFields.some((field) => hasValue(artifact[field]))) return artifact;
  for (const candidate of Object.values(artifact)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const nested = candidate as Record<string, unknown>;
    if (requiredFields.some((field) => hasValue(nested[field]))) {
      return nested;
    }
  }
  return artifact;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
