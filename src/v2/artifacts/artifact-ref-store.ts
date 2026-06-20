import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import {
  ARTIFACT_EVIDENCE_SCHEMA_VERSION,
  ARTIFACT_REF_RESOURCE_TYPE,
  type ArtifactRefPayload,
  type ArtifactRefProducer,
  type ArtifactRefStatus,
} from "./types.ts";

export type ArtifactRefWriteInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  producer: ArtifactRefProducer;
  artifactType: string;
  status: ArtifactRefStatus;
  content: unknown;
  contractRefs: string[];
  summary: string;
  evidenceRefs?: string[];
  evaluatorResultRefs?: string[];
  sourceEventRefs?: string[];
  producedAt?: string;
};

export type ArtifactRefWriteResult = {
  resourceId: string;
  artifactRefId: string;
  contentHash: string;
};

export async function acceptOrRejectArtifactRefPg(
  db: SouthstarDb,
  input: ArtifactRefWriteInput,
): Promise<ArtifactRefWriteResult> {
  const contentHash = sha256Stable(input.content);
  const artifactRefId = `artifact_ref:${input.runId}:${input.taskId}:${input.attemptId}:${contentHash}`;
  const sortedContractRefs = [...input.contractRefs].sort();
  const payload: ArtifactRefPayload = {
    schemaVersion: ARTIFACT_EVIDENCE_SCHEMA_VERSION,
    artifactRefId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    handExecutionId: input.handExecutionId,
    producer: input.producer,
    artifactType: input.artifactType,
    status: input.status,
    contentRef: {
      kind: "inline_digest",
      ref: contentHash,
      sha256: contentHash,
    },
    contractRefs: sortedContractRefs,
    summary: input.summary,
    evidenceRefs: input.evidenceRefs ?? [],
    evaluatorResultRefs: input.evaluatorResultRefs ?? [],
    sourceEventRefs: input.sourceEventRefs ?? [],
    producedAt: input.producedAt ?? new Date().toISOString(),
  };
  const summary = {
    artifactRefId,
    artifactType: input.artifactType,
    contractRefs: sortedContractRefs,
    contentHash,
  };

  const resource = await upsertRuntimeResourcePg(db, {
    id: artifactRefId,
    resourceType: ARTIFACT_REF_RESOURCE_TYPE,
    resourceKey: artifactRefId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "artifact",
    status: input.status,
    title: `${input.artifactType} ${input.taskId}`,
    payload,
    summary,
  });

  await appendArtifactHistoryOnce(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    artifactRefId,
    status: input.status,
    payload,
    summary,
  });

  return { resourceId: resource.id, artifactRefId, contentHash };
}

export async function acceptedArtifactTaskIdsForRunPg(db: SouthstarDb, runId: string): Promise<Set<string>> {
  const rows = await db.query<{ task_id: string }>(
    `select distinct task_id
       from southstar.runtime_resources
      where run_id = $1
        and task_id is not null
        and resource_type = $2
        and status = 'accepted'
      order by task_id`,
    [runId, ARTIFACT_REF_RESOURCE_TYPE],
  );
  return new Set(rows.rows.map((row) => row.task_id));
}

export function sha256Stable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function appendArtifactHistoryOnce(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    artifactRefId: string;
    status: ArtifactRefStatus;
    payload: ArtifactRefPayload;
    summary: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await appendHistoryEventPg(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      eventType: `artifact.${input.status}`,
      actorType: "orchestrator",
      idempotencyKey: `${input.artifactRefId}:${input.status}`,
      payload: {
        artifactRefId: input.artifactRefId,
        status: input.status,
        summary: input.summary,
        artifactRef: input.payload,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return;
    throw error;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

function toStableJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => {
    const stable = toStableJsonValue(item);
    return stable === undefined ? null : stable;
  });
  if (typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return toStableJsonValue((value as { toJSON: () => unknown }).toJSON());
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const stable = toStableJsonValue(record[key]);
      if (stable !== undefined) output[key] = stable;
    }
    return output;
  }
  return undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}
