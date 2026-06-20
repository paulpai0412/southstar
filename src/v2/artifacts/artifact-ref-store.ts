import { createHash, randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
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
  const summary = {
    artifactRefId,
    artifactType: input.artifactType,
    contractRefs: sortedContractRefs,
    contentHash,
  };

  const resource = await db.tx(async (tx) => {
    const existing = await tx.maybeOne<{ payload_json: unknown }>(
      "select payload_json from southstar.runtime_resources where resource_type = $1 and resource_key = $2 for update",
      [ARTIFACT_REF_RESOURCE_TYPE, artifactRefId],
    );
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
      producedAt: input.producedAt ?? existingProducedAt(existing?.payload_json) ?? new Date().toISOString(),
    };

    const resource = await upsertRuntimeResourcePg(tx, {
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

    await appendArtifactHistoryOnce(tx, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      artifactRefId,
      status: input.status,
      payload,
      summary,
    });

    return resource;
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
  const idempotencyKey = `${input.artifactRefId}:${input.status}`;
  await db.query("select id from southstar.workflow_runs where id = $1 for update", [input.runId]);
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
