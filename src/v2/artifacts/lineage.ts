import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

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
  const sourceRefs = sortedUniqueStrings(input.sourceRefs);
  const markerId = artifactRepairMarkerId(input.runId, input.taskId, input.artifactRefId, markerKind, input.reason, sourceRefs);
  const payload = {
    ...objectPayload(input.payload),
    schemaVersion: "southstar.artifact.lineage.repair_marker.v1",
    markerId,
    markerKind,
    artifactRefId: input.artifactRefId,
    reason: input.reason,
    sourceRefs,
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
  const idempotencyKey = `${input.markerId}:repair-marker-recorded`;
  const existing = await db.maybeOne<{ id: string }>(
    "select id from southstar.workflow_history where run_id = $1 and idempotency_key = $2",
    [input.runId, idempotencyKey],
  );
  if (existing) return;

  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "artifact.repair_marker_recorded",
    actorType: "orchestrator",
    idempotencyKey,
    payload: input.payload,
  });
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

function sortedUniqueStrings(value: unknown): string[] {
  return [...new Set(stringArray(value))].sort();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
