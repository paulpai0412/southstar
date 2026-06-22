import type { SouthstarDb } from "../db/postgres.ts";

type ResourceRow = {
  id: string;
  resource_type: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  scope: string;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
  updated_at: Date | string;
};

export type ManagedAgentRunReadModel = {
  runId: string;
  brainBindings: Array<{ id: string; taskId?: string; sessionId?: string; status: string; payload: unknown }>;
  handBindings: Array<{ id: string; taskId?: string; sessionId?: string; status: string; payload: unknown }>;
  checkpoints: Array<{ id: string; taskId?: string; sessionId?: string; status: string; payload: unknown }>;
  toolGrants: Array<{ id: string; sessionId?: string; status: string; payload: unknown }>;
  resources: ManagedRuntimeResourceReadModel[];
};

export type ManagedRuntimeResourceReadModel = {
  id: string;
  resourceType: string;
  taskId?: string;
  sessionId?: string;
  status: string;
  scope: string;
  title?: string;
  payload: unknown;
  summary: unknown;
};

export async function getManagedAgentRunReadModelPg(db: SouthstarDb, runId: string): Promise<ManagedAgentRunReadModel> {
  const rows = await db.query<ResourceRow>(
    `select * from southstar.runtime_resources
     where run_id = $1 and resource_type = any($2::text[])
     order by updated_at, resource_type, resource_key`,
    [runId, [...managedResourceTypes]],
  );
  return {
    runId,
    brainBindings: rows.rows.filter((row) => row.resource_type === "brain_binding").map(mapBinding),
    handBindings: rows.rows.filter((row) => row.resource_type === "hand_binding").map(mapBinding),
    checkpoints: rows.rows.filter((row) => row.resource_type === "session_checkpoint").map(mapBinding),
    toolGrants: rows.rows.filter((row) => row.resource_type === "vault_lease" || row.resource_type === "tool_grant").map(mapGrant),
    resources: rows.rows.filter((row) => managedContractResourceTypes.has(row.resource_type)).map(mapResource),
  };
}

const managedContractResourceTypes = new Set([
  "artifact_ref",
  "brain_binding",
  "context_assembly_trace",
  "context_packet",
  "hand_binding",
  "hand_execution",
  "task_envelope",
  "task_execution_intent",
  "evaluator_result",
  "memory_item",
  "memory_delta",
  "rollback_marker",
  "artifact_repair_marker",
  "tool_proxy_policy",
  "tool_proxy_violation",
  "recovery_decision",
  "recovery_execution",
]);

const managedResourceTypes = new Set([
  ...managedContractResourceTypes,
  "session_checkpoint",
  "vault_lease",
  "tool_grant",
]);

function mapBinding(row: ResourceRow) {
  return {
    id: row.resource_key,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    payload: row.payload_json,
  };
}

function mapGrant(row: ResourceRow) {
  return {
    id: row.resource_key,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    payload: row.payload_json,
  };
}

function mapResource(row: ResourceRow): ManagedRuntimeResourceReadModel {
  const payload = mapResourcePayload(row);
  return {
    id: row.resource_key,
    resourceType: row.resource_type,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    scope: row.scope,
    title: row.title ?? undefined,
    payload,
    summary: mapResourceSummary(row, payload),
  };
}

function mapResourcePayload(row: ResourceRow): unknown {
  if (row.resource_type === "recovery_execution") return mapRecoveryExecutionPayload(row.payload_json);
  if (row.resource_type === "task_envelope") return mapTaskEnvelopePayload(row);
  return row.payload_json;
}

function mapResourceSummary(row: ResourceRow, payload: unknown): unknown {
  if (row.resource_type === "recovery_execution") return mapRecoveryExecutionSummary(payload);
  if (row.resource_type === "task_envelope") return mapTaskEnvelopeSummary(row, payload);
  return row.summary_json;
}

function mapRecoveryExecutionPayload(payload: unknown): Record<string, string | number> {
  const source = asRecord(payload);
  const projected: Record<string, string | number> = {};
  const stringFields = [
    "schemaVersion",
    "executionId",
    "decisionId",
    "exceptionId",
    "runId",
    "taskId",
    "path",
    "status",
    "createdAt",
    "completedAt",
  ];

  for (const field of stringFields) {
    const value = stringValue(source[field]);
    if (value !== undefined) projected[field] = value;
  }

  if (Array.isArray(source.providerActions)) projected.providerActionCount = source.providerActions.length;
  if (Array.isArray(source.stateChanges)) projected.stateChangeCount = source.stateChanges.length;

  return projected;
}

function mapRecoveryExecutionSummary(payload: unknown): { providerActionCount?: number; stateChangeCount?: number } | null {
  const source = asRecord(payload);
  const summary: { providerActionCount?: number; stateChangeCount?: number } = {};

  if (typeof source.providerActionCount === "number") summary.providerActionCount = source.providerActionCount;
  if (typeof source.stateChangeCount === "number") summary.stateChangeCount = source.stateChangeCount;

  return Object.keys(summary).length > 0 ? summary : null;
}

function mapTaskEnvelopePayload(row: ResourceRow): Record<string, string | number> {
  const payload = asRecord(row.payload_json);
  const envelope = asRecord(payload.envelope);
  const source = Object.keys(envelope).length > 0 ? envelope : payload;
  const session = asRecord(source.session);
  const contextPacket = asRecord(source.contextPacket);
  const tokenEstimate = asRecord(contextPacket.tokenEstimate);
  const summary = asRecord(row.summary_json);

  const projected: Record<string, string | number> = {};
  setString(projected, "schemaVersion", source.schemaVersion ?? summary.schemaVersion);
  setString(projected, "envelopeId", source.envelopeId ?? source.id ?? row.resource_key);
  setString(projected, "runId", source.runId ?? row.run_id);
  setString(projected, "taskId", source.taskId ?? row.task_id);
  setString(projected, "sessionId", session.sessionId ?? source.sessionId ?? row.session_id);
  setString(projected, "attemptId", session.attemptId ?? source.attemptId ?? summary.attemptId);
  setString(projected, "status", source.status ?? row.status);
  setString(projected, "contextPacketId", contextPacket.id ?? source.contextPacketId ?? summary.contextPacketId);

  const selectedMemoryCount = arrayLength(contextPacket.selectedMemories);
  const selectedKnowledgeCardCount = arrayLength(contextPacket.selectedKnowledgeCards);
  const priorArtifactCount = arrayLength(contextPacket.priorArtifacts);
  const sourceCount = selectedMemoryCount + selectedKnowledgeCardCount + priorArtifactCount;

  if (selectedMemoryCount > 0) projected.selectedMemoryCount = selectedMemoryCount;
  if (selectedKnowledgeCardCount > 0) projected.selectedKnowledgeCardCount = selectedKnowledgeCardCount;
  if (priorArtifactCount > 0) projected.priorArtifactCount = priorArtifactCount;
  if (sourceCount > 0) projected.sourceCount = sourceCount;
  if (typeof tokenEstimate.total === "number") projected.tokenEstimateTotal = tokenEstimate.total;

  return projected;
}

function mapTaskEnvelopeSummary(row: ResourceRow, payload: unknown): Record<string, string | number> {
  const summary = asRecord(row.summary_json);
  const projected = { ...(payload as Record<string, string | number>) };
  setString(projected, "schemaVersion", summary.schemaVersion ?? projected.schemaVersion);
  setString(projected, "contextPacketId", summary.contextPacketId ?? projected.contextPacketId);
  setString(projected, "attemptId", summary.attemptId ?? projected.attemptId);
  return projected;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function setString(target: Record<string, string | number>, field: string, value: unknown): void {
  const parsed = stringValue(value);
  if (parsed !== undefined) target[field] = parsed;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
