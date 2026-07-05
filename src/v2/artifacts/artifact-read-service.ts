import type { SouthstarDb } from "../db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "./types.ts";

export type ArtifactReadResult = {
  artifactRef: string;
  status: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  artifactType?: string;
  summary?: string;
  contentRef?: unknown;
  content?: unknown;
  producer?: unknown;
  producedAt?: string;
};

type ArtifactResourceRow = {
  resource_key: string;
  status: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  payload_json: unknown;
  summary_json: unknown;
};

export async function getArtifactRefContentPg(
  db: SouthstarDb,
  input: { artifactRef: string },
): Promise<ArtifactReadResult> {
  const row = await db.maybeOne<ArtifactResourceRow>(
    `select resource_key, status, run_id, task_id, session_id, payload_json, summary_json
       from southstar.runtime_resources
      where resource_type = $1
        and resource_key = $2`,
    [ARTIFACT_REF_RESOURCE_TYPE, input.artifactRef],
  );
  if (!row) throw new Error(`Artifact not found: ${input.artifactRef}`);
  const payload = asRecord(row.payload_json);
  const summary = asRecord(row.summary_json);
  const contentRef = asRecord(payload.contentRef);
  return {
    artifactRef: row.resource_key,
    status: row.status,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(stringValue(payload.artifactType) ? { artifactType: stringValue(payload.artifactType)! } : {}),
    ...(stringValue(payload.summary) ?? stringValue(summary.summary)
      ? { summary: (stringValue(payload.summary) ?? stringValue(summary.summary))! }
      : {}),
    ...(payload.contentRef !== undefined ? { contentRef: payload.contentRef } : {}),
    ...(await readArtifactContent(db, contentRef)),
    ...(payload.producer !== undefined ? { producer: payload.producer } : {}),
    ...(stringValue(payload.producedAt) ? { producedAt: stringValue(payload.producedAt)! } : {}),
  };
}

async function readArtifactContent(
  db: SouthstarDb,
  contentRef: Record<string, unknown>,
): Promise<{ content?: unknown }> {
  if (contentRef.kind !== "artifact_blob") return {};
  const blobId = stringValue(contentRef.ref);
  if (!blobId) return {};
  const row = await db.maybeOne<{ body: Buffer }>(
    "select body from southstar.artifact_blobs where id = $1",
    [blobId],
  );
  if (!row) return {};
  return { content: JSON.parse(row.body.toString("utf8")) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
