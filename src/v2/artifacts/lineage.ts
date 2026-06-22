import { createHash, randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export type RecordArtifactRepairMarkerInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  artifactRefId: string;
  reason: string;
  sourceRefs?: string[];
  markerKind?: string;
  status?: "open" | "resolved" | "ignored";
  payload?: Record<string, unknown>;
};

export type RecordArtifactRepairMarkerResult = {
  markerId: string;
};

export async function recordArtifactRepairMarkerPg(
  db: SouthstarDb,
  input: RecordArtifactRepairMarkerInput,
): Promise<RecordArtifactRepairMarkerResult> {
  const markerKind = nonEmptyString(input.markerKind) ?? "artifact_repair";
  const status = input.status ?? "open";
  const sourceRefs = stringArray(input.sourceRefs);
  const markerId = artifactRepairMarkerId(input.runId, input.taskId, input.artifactRefId, markerKind, input.reason, sourceRefs);
  const payload = {
    schemaVersion: "southstar.artifact.lineage.repair_marker.v1",
    markerId,
    markerKind,
    artifactRefId: input.artifactRefId,
    reason: input.reason,
    sourceRefs,
    ...objectPayload(input.payload),
  };

  await upsertRuntimeResourcePg(db, {
    id: markerId,
    resourceType: "artifact_repair_marker",
    resourceKey: markerId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "artifact",
    status,
    title: markerKind,
    payload,
    summary: {
      markerKind,
      artifactRefId: input.artifactRefId,
      reason: input.reason,
      sourceRefs,
    },
  });
  await appendRepairMarkerRecordedOncePg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    markerId,
    payload,
  });
  return { markerId };
}

async function appendRepairMarkerRecordedOncePg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId?: string;
    sessionId?: string;
    markerId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `insert into southstar.workflow_history (
      id, run_id, task_id, sequence, event_type, actor_type, session_id,
      idempotency_key, correlation_id, causation_id, payload_json, created_at
    ) values (
      $1, $2, $3,
      (select coalesce(max(sequence), 0) + 1 from southstar.workflow_history where run_id = $2),
      'artifact.repair_marker_recorded', 'orchestrator', $4, $5, null, null, $6::jsonb, $7
    )
    on conflict (run_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      randomUUID(),
      input.runId,
      input.taskId ?? null,
      input.sessionId ?? null,
      `${input.markerId}:repair-marker-recorded`,
      JSON.stringify({ markerId: input.markerId, ...input.payload }),
      new Date().toISOString(),
    ],
  );
}

function artifactRepairMarkerId(...parts: unknown[]): string {
  return `artifact-repair-marker-${sha256(parts).slice(0, 24)}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
