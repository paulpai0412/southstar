import { createHash, randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
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
  failedArtifactRefs?: string[];
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
  const artifactBlobId = `${artifactRefId}:content`;
  const sortedContractRefs = [...input.contractRefs].sort();

  const resource = await db.tx(async (tx) => {
    await tx.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);

    const initialPayload = buildArtifactRefPayload(input, {
      artifactRefId,
      contentHash,
      artifactBlobId,
      contractRefs: sortedContractRefs,
      producedAt: input.producedAt ?? new Date().toISOString(),
    });
    const summary = artifactRefSummary(input, { artifactRefId, contentHash, contractRefs: sortedContractRefs });
    const inserted = await insertArtifactRefResource(tx, {
      artifactRefId,
      input,
      payload: initialPayload,
      summary,
    });
    if (inserted) {
      await upsertArtifactBlob(tx, { input, artifactBlobId, resourceId: inserted.id, contentHash });
      await appendArtifactHistoryOnce(tx, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        artifactRefId,
        status: input.status,
        payload: initialPayload,
        summary,
      });
      return inserted;
    }

    const existing = await selectArtifactRefResourceForUpdate(tx, artifactRefId);
    if (existing.status === input.status) {
      await upsertArtifactBlob(tx, { input, artifactBlobId, resourceId: existing.id, contentHash });
      return { id: existing.id };
    }

    const transitionPayload = buildArtifactRefPayload(input, {
      artifactRefId,
      contentHash,
      artifactBlobId,
      contractRefs: sortedContractRefs,
      producedAt: input.producedAt ?? existingProducedAt(existing.payload_json) ?? new Date().toISOString(),
    });
    const updated = await updateArtifactRefResource(tx, {
      artifactRefId,
      input,
      payload: transitionPayload,
      summary,
    });
    await upsertArtifactBlob(tx, { input, artifactBlobId, resourceId: updated.id, contentHash });

    await appendArtifactHistoryOnce(tx, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      artifactRefId,
      status: input.status,
      payload: transitionPayload,
      summary,
    });

    return updated;
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

type ArtifactRefResourceRow = {
  id: string;
  status: ArtifactRefStatus;
  payload_json: unknown;
};

function buildArtifactRefPayload(
  input: ArtifactRefWriteInput,
  values: { artifactRefId: string; contentHash: string; artifactBlobId: string; contractRefs: string[]; producedAt: string },
): ArtifactRefPayload {
  return {
    schemaVersion: ARTIFACT_EVIDENCE_SCHEMA_VERSION,
    artifactRefId: values.artifactRefId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    handExecutionId: input.handExecutionId,
    producer: input.producer,
    artifactType: input.artifactType,
    status: input.status,
    contentRef: {
      kind: "artifact_blob",
      ref: values.artifactBlobId,
      sha256: values.contentHash,
    },
    contractRefs: values.contractRefs,
    summary: input.summary,
    ...(input.failedArtifactRefs && input.failedArtifactRefs.length > 0 ? { failedArtifactRefs: [...input.failedArtifactRefs] } : {}),
    evidenceRefs: input.evidenceRefs ?? [],
    evaluatorResultRefs: input.evaluatorResultRefs ?? [],
    sourceEventRefs: input.sourceEventRefs ?? [],
    producedAt: values.producedAt,
  };
}

async function upsertArtifactBlob(
  db: SouthstarDb,
  input: {
    input: ArtifactRefWriteInput;
    artifactBlobId: string;
    resourceId: string;
    contentHash: string;
  },
): Promise<void> {
  const body = Buffer.from(stableJson(input.input.content), "utf8");
  await db.query(
    `insert into southstar.artifact_blobs (
       id, resource_id, run_id, task_id, session_id, artifact_type,
       content_type, size_bytes, sha256, body, metadata_json, created_at
     ) values ($1, $2, $3, $4, $5, $6, 'application/json', $7, $8, $9, $10::jsonb, now())
     on conflict (id) do update
       set resource_id = excluded.resource_id,
           metadata_json = excluded.metadata_json`,
    [
      input.artifactBlobId,
      input.resourceId,
      input.input.runId,
      input.input.taskId,
      input.input.sessionId,
      input.input.artifactType,
      body.byteLength,
      input.contentHash,
      body,
      JSON.stringify({
        artifactRefId: input.artifactBlobId.replace(/:content$/, ""),
        attemptId: input.input.attemptId,
        handExecutionId: input.input.handExecutionId,
      }),
    ],
  );
}

function artifactRefSummary(
  input: ArtifactRefWriteInput,
  values: { artifactRefId: string; contentHash: string; contractRefs: string[] },
): Record<string, unknown> {
  return {
    artifactRefId: values.artifactRefId,
    artifactType: input.artifactType,
    contractRefs: values.contractRefs,
    contentHash: values.contentHash,
  };
}

async function insertArtifactRefResource(
  db: SouthstarDb,
  input: {
    artifactRefId: string;
    input: ArtifactRefWriteInput;
    payload: ArtifactRefPayload;
    summary: Record<string, unknown>;
  },
): Promise<ArtifactRefResourceRow | null> {
  const result = await db.query<ArtifactRefResourceRow>(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, run_id, task_id, session_id, scope, status,
      title, payload_json, summary_json, metrics_json, created_at, updated_at, expires_at
    ) values ($1, $2, $3, $4, $5, $6, 'artifact', $7, $8, $9::jsonb, $10::jsonb, '{}'::jsonb, now(), now(), null)
    on conflict(resource_type, resource_key) do nothing
    returning id, status, payload_json`,
    [
      input.artifactRefId,
      ARTIFACT_REF_RESOURCE_TYPE,
      input.artifactRefId,
      input.input.runId,
      input.input.taskId,
      input.input.sessionId,
      input.input.status,
      `${input.input.artifactType} ${input.input.taskId}`,
      JSON.stringify(input.payload),
      JSON.stringify(input.summary),
    ],
  );
  return result.rows[0] ?? null;
}

async function selectArtifactRefResourceForUpdate(db: SouthstarDb, artifactRefId: string): Promise<ArtifactRefResourceRow> {
  return await db.one<ArtifactRefResourceRow>(
    `select id, status, payload_json
       from southstar.runtime_resources
      where resource_type = $1
        and resource_key = $2
      for update`,
    [ARTIFACT_REF_RESOURCE_TYPE, artifactRefId],
  );
}

async function updateArtifactRefResource(
  db: SouthstarDb,
  input: {
    artifactRefId: string;
    input: ArtifactRefWriteInput;
    payload: ArtifactRefPayload;
    summary: Record<string, unknown>;
  },
): Promise<ArtifactRefResourceRow> {
  return await db.one<ArtifactRefResourceRow>(
    `update southstar.runtime_resources
        set run_id = $1,
            task_id = $2,
            session_id = $3,
            scope = 'artifact',
            status = $4,
            title = $5,
            payload_json = $6::jsonb,
            summary_json = $7::jsonb,
            metrics_json = '{}'::jsonb,
            updated_at = now(),
            expires_at = null
      where resource_type = $8
        and resource_key = $9
      returning id, status, payload_json`,
    [
      input.input.runId,
      input.input.taskId,
      input.input.sessionId,
      input.input.status,
      `${input.input.artifactType} ${input.input.taskId}`,
      JSON.stringify(input.payload),
      JSON.stringify(input.summary),
      ARTIFACT_REF_RESOURCE_TYPE,
      input.artifactRefId,
    ],
  );
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
  const idempotencyKey = `${input.artifactRefId}:${input.status}`;
  await db.query(
    `insert into southstar.workflow_history (
      id, run_id, task_id, sequence, event_type, actor_type, session_id,
      idempotency_key, correlation_id, causation_id, payload_json, created_at
    ) values (
      $1, $2, $3,
      (select coalesce(max(sequence), 0) + 1 from southstar.workflow_history where run_id = $2),
      $4, $5, $6, $7, null, null, $8::jsonb, $9
    )
    on conflict (run_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      randomUUID(),
      input.runId,
      input.taskId,
      `artifact.${input.status}`,
      "orchestrator",
      input.sessionId,
      idempotencyKey,
      JSON.stringify({
        artifactRefId: input.artifactRefId,
        status: input.status,
        summary: input.summary,
        artifactRef: input.payload,
      }),
      new Date().toISOString(),
    ],
  );
}

function existingProducedAt(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const producedAt = (payload as { producedAt?: unknown }).producedAt;
  return typeof producedAt === "string" && producedAt.length > 0 ? producedAt : undefined;
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
