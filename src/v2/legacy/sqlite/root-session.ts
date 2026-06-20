// @legacy-sqlite-quarantine: DB-backed root session loop retained only for legacy SQLite tests/E2E. Active runtime uses pure task-runner plus Postgres callback ingestion.
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { appendHistoryEvent } from "../../stores/history-store.ts";
import { upsertRuntimeResource } from "../../stores/resource-store.ts";
import { recomputeManagementMetrics } from "../../stores/metrics-store.ts";
import { appendRuntimeEvent } from "../../signals/events.ts";
import { persistEvaluatorResult } from "../../evaluators/runner.ts";
import { recordProgressCommentary } from "../../signals/progress.ts";
import type { AnyTaskEnvelope } from "../../agent-runner/task-envelope.ts";
import type { AgentHarness } from "../../harness/types.ts";
import { evaluateArtifactGate, type ArtifactRepairContext } from "../../agent-runner/root-session.ts";

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
      repairContext: repairContextFromEnvelope(envelope),
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
