import type { SouthstarDb } from "../db/postgres.ts";
import { searchMemoryForContextPg } from "../memory/postgres-memory-service.ts";
import { buildManagedContextSourceRefs } from "./event-slicing.ts";
import type { ContextBlockCandidate, ManagedContextSourceRefs } from "./types.ts";

export type CollectContextSourcesInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  dependsOn: string[];
  query: string;
  memoryScopes: string[];
  allowedMemoryKinds: string[];
  maxMemoryCandidates: number;
  checkpointRefs: string[];
};

export type CollectContextSourcesResult = {
  candidates: ContextBlockCandidate[];
  sourceRefs: ManagedContextSourceRefs;
  pendingMemoryRefs: string[];
  invalidatedSourceRefs: string[];
};

type ResourceRow = {
  resource_key: string;
  resource_type: string;
  status: string;
  task_id: string | null;
  session_id: string | null;
  payload_json: unknown;
  summary_json: unknown;
  created_at: Date | string;
};

type EventRow = {
  id: string;
  run_id: string;
  task_id: string | null;
  session_id: string | null;
  sequence: number;
};

export async function collectContextSourcesPg(
  db: SouthstarDb,
  input: CollectContextSourcesInput,
): Promise<CollectContextSourcesResult> {
  const [
    artifactCandidates,
    rawEventRefs,
    checkpointCandidates,
    memoryCandidates,
    rollbackInvalidation,
    pendingMemoryRefs,
  ] = await Promise.all([
    acceptedArtifactCandidates(db, input),
    sessionEventRefs(db, input),
    checkpointCandidatesForRefs(db, input),
    memoryCandidatesForInput(db, input),
    rollbackInvalidatedSourceRefs(db, input.runId),
    pendingMemoryDeltaRefs(db, input.runId),
  ]);

  const sourceRefs = buildManagedContextSourceRefs({
    rawEventRefs,
    omittedEventRanges: [],
    transformRefs: [],
    checkpointRefs: input.checkpointRefs,
    artifactRefs: sourceRefsFromCandidates(artifactCandidates),
    memoryRefs: sourceRefsFromCandidates(memoryCandidates),
    rollbackMarkerRefs: rollbackInvalidation.markerRefs,
  });

  return {
    candidates: [...artifactCandidates, ...checkpointCandidates, ...memoryCandidates],
    sourceRefs,
    pendingMemoryRefs,
    invalidatedSourceRefs: rollbackInvalidation.invalidatedSourceRefs,
  };
}

async function acceptedArtifactCandidates(
  db: SouthstarDb,
  input: CollectContextSourcesInput,
): Promise<ContextBlockCandidate[]> {
  if (input.dependsOn.length === 0) return [];
  const rows = await db.query<ResourceRow>(
    `select resource_key, resource_type, status, task_id, session_id, payload_json, summary_json, created_at
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'artifact_ref'
        and status = 'accepted'
        and task_id = any($2::text[])
      order by created_at, resource_key`,
    [input.runId, input.dependsOn],
  );
  return rows.rows.map((row) => {
    const payload = asRecord(row.payload_json);
    const summary = asRecord(row.summary_json);
    const text = stringValue(payload.summary) || stringValue(summary.summary) || `Accepted artifact ${row.resource_key}`;
    const title = stringValue(payload.artifactType) || "Accepted artifact";
    return candidate("artifact", row.resource_key, title, text, row.resource_key, 1, {
      runId: input.runId,
      taskId: row.task_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      attemptId: stringValue(payload.attemptId) || undefined,
      handExecutionId: stringValue(payload.handExecutionId) || undefined,
      artifactRefIds: [row.resource_key],
    });
  });
}

async function checkpointCandidatesForRefs(
  db: SouthstarDb,
  input: CollectContextSourcesInput,
): Promise<ContextBlockCandidate[]> {
  if (input.checkpointRefs.length === 0) return [];
  const rows = await db.query<ResourceRow>(
    `select resource_key, resource_type, status, task_id, session_id, payload_json, summary_json, created_at
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'session_checkpoint'
        and resource_key = any($2::text[])
      order by created_at, resource_key`,
    [input.runId, input.checkpointRefs],
  );
  return rows.rows.map((row) => {
    const payload = asRecord(row.payload_json);
    const text = stringValue(payload.summary) || `Checkpoint ${row.resource_key}`;
    const checkpointType = stringValue(payload.checkpointType) || "checkpoint";
    return candidate("checkpoint", row.resource_key, checkpointType, text, row.resource_key, 0.95, {
      runId: input.runId,
      taskId: row.task_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      checkpointId: row.resource_key,
    });
  });
}

async function memoryCandidatesForInput(
  db: SouthstarDb,
  input: CollectContextSourcesInput,
): Promise<ContextBlockCandidate[]> {
  const memories = await searchMemoryForContextPg(db, {
    runId: input.runId,
    query: input.query,
    scopes: input.memoryScopes,
    allowedKinds: input.allowedMemoryKinds,
    maxCandidates: input.maxMemoryCandidates,
  });
  return memories.map((memory) => candidate(
    "memory",
    memory.id,
    memory.kind,
    memory.text,
    memory.sourceRef ?? `memory_item:${memory.id}`,
    memory.score,
    {
      runId: memory.runId ?? input.runId,
      taskId: memory.taskId,
      sessionId: memory.sessionId,
    },
    {
      confidence: memory.confidence,
      successScore: memory.successScore,
      tokenEstimate: memory.tokenEstimate,
    },
  ));
}

async function sessionEventRefs(
  db: SouthstarDb,
  input: CollectContextSourcesInput,
): Promise<ManagedContextSourceRefs["rawEventRefs"]> {
  const rows = await db.query<EventRow>(
    `select id, run_id, task_id, session_id, sequence
       from southstar.workflow_history
      where run_id = $1
        and (session_id = $2 or task_id = any($3::text[]))
        and session_id is not null
      order by sequence
      limit 50`,
    [input.runId, input.sessionId, input.dependsOn],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id ?? input.sessionId,
    sequence: row.sequence,
  }));
}

async function rollbackInvalidatedSourceRefs(
  db: SouthstarDb,
  runId: string,
): Promise<{ markerRefs: string[]; invalidatedSourceRefs: string[] }> {
  const rows = await db.query<{ resource_key: string; payload_json: unknown }>(
    `select resource_key, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'rollback_marker'
        and status in ('created', 'recorded')
      order by created_at, resource_key`,
    [runId],
  );
  return {
    markerRefs: rows.rows.map((row) => row.resource_key),
    invalidatedSourceRefs: uniqueSorted(rows.rows.flatMap((row) => stringArray(asRecord(row.payload_json).invalidatedSourceRefs))),
  };
}

async function pendingMemoryDeltaRefs(db: SouthstarDb, runId: string): Promise<string[]> {
  const rows = await db.query<{ resource_key: string }>(
    `select resource_key
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'memory_delta'
        and status = 'pending_approval'
      order by created_at, resource_key`,
    [runId],
  );
  return rows.rows.map((row) => `memory_delta:${row.resource_key}`);
}

function candidate(
  sourceType: ContextBlockCandidate["sourceType"],
  id: string,
  title: string,
  text: string,
  sourceRef: string,
  score: number,
  lineage: ContextBlockCandidate["lineage"],
  overrides: Partial<Pick<ContextBlockCandidate, "confidence" | "successScore" | "tokenEstimate">> = {},
): ContextBlockCandidate {
  return {
    id: `${sourceType}-${id}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
    sourceType,
    title,
    text,
    sourceRef,
    tokenEstimate: overrides.tokenEstimate ?? estimateTokens(text),
    score,
    confidence: overrides.confidence,
    successScore: overrides.successScore,
    lineage,
  };
}

function sourceRefsFromCandidates(candidates: ContextBlockCandidate[]): string[] {
  return candidates.map((item) => item.sourceRef).filter((value): value is string => Boolean(value));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}
