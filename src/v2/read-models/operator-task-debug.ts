import type { SouthstarDb } from "../db/postgres.ts";
import { getArtifactRefContentPg } from "../artifacts/artifact-read-service.ts";
import { isTaskRecoverableStatus } from "../task-recovery.ts";
import { usableWorkspaceSnapshotRefs } from "../session-recovery/workspace-snapshot.ts";

export const OPERATOR_TASK_DEBUG_SCHEMA_VERSION = "southstar.read_model.operator_task_debug.v1";

type OperatorCommand = {
  id: string;
  label: string;
  endpoint?: string;
  method: "GET" | "POST";
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
  body?: Record<string, unknown>;
  inputOptions?: {
    checkpointRefs?: string[];
    workspaceSnapshotRefs?: string[];
  };
};

export async function buildOperatorTaskDebugReadModelPg(db: SouthstarDb, input: { runId: string; taskId: string }) {
  const task = await db.maybeOne<{
    id: string;
    run_id: string;
    task_key: string;
    status: string;
    sort_order: number;
    depends_on_json: unknown;
    root_session_id: string | null;
    subagent_session_ids_json: unknown;
    executor_task_id: string | null;
    snapshot_json: unknown;
    metrics_json: unknown;
    created_at: Date;
    updated_at: Date;
    completed_at: Date | null;
  }>(
    `select id, run_id, task_key, status, sort_order, depends_on_json, root_session_id,
            subagent_session_ids_json, executor_task_id, snapshot_json, metrics_json,
            created_at, updated_at, completed_at
       from southstar.workflow_tasks
      where run_id = $1 and id = $2`,
    [input.runId, input.taskId],
  );
  if (!task) throw new Error(`workflow task not found: ${input.runId}/${input.taskId}`);

  const sessionIds = [
    task.root_session_id,
    ...stringArray(task.subagent_session_ids_json),
  ].filter((id): id is string => Boolean(id));

  const [historyRows, sessionHistoryRows, resourceRows] = await Promise.all([
    db.query<{
      id: string;
      sequence: number;
      event_type: string;
      actor_type: string;
      session_id: string | null;
      payload_json: unknown;
      created_at: Date;
    }>(
      `select id, sequence, event_type, actor_type, session_id, payload_json, created_at
         from southstar.workflow_history
        where run_id = $1 and task_id = $2
        order by sequence desc`,
      [input.runId, input.taskId],
    ),
    db.query<{
      id: string;
      sequence: number;
      event_type: string;
      actor_type: string;
      task_id: string | null;
      session_id: string | null;
      payload_json: unknown;
      created_at: Date;
    }>(
      `select id, sequence, event_type, actor_type, task_id, session_id, payload_json, created_at
         from southstar.workflow_history
        where run_id = $1
          and (task_id = $2 or ($3::text[] <> '{}'::text[] and session_id = any($3::text[])))
        order by sequence desc`,
      [input.runId, input.taskId, sessionIds],
    ),
    db.query<{
      id: string;
      resource_type: string;
      resource_key: string;
      session_id: string | null;
      scope: string;
      status: string;
      title: string | null;
      payload_json: unknown;
      summary_json: unknown;
      metrics_json: unknown;
      created_at: Date;
      updated_at: Date;
      expires_at: Date | null;
    }>(
      `select id, resource_type, resource_key, session_id, scope, status, title,
              payload_json, summary_json, metrics_json, created_at, updated_at, expires_at
         from southstar.runtime_resources
        where run_id = $1
          and (
            task_id = $2
            or resource_type in ('artifact_ref', 'memory_item', 'memory_delta', 'session_checkpoint')
            or ($3::text[] <> '{}'::text[] and session_id = any($3::text[]))
          )
        order by updated_at desc, resource_type, resource_key`,
      [input.runId, input.taskId, sessionIds],
    ),
  ]);

  const resources = resourceRows.rows.map((row) => ({
    id: row.id,
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    scope: row.scope,
    status: row.status,
    ...(row.title ? { title: row.title } : {}),
    payload: row.payload_json,
    summary: row.summary_json,
    metrics: row.metrics_json,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
  }));

  const artifacts = await artifactRowsWithContent(db, resources.filter((resource) => resource.resourceType === "artifact_ref"));
  const contextPackets = resources.filter((resource) => resource.resourceType === "context_packet");
  const latestContextPacket = contextPackets[0];
  const contextPayload = asRecord(latestContextPacket?.payload);
  const checkpointRefs = resources
    .filter((resource) => resource.resourceType === "session_checkpoint")
    .map((resource) => resource.resourceKey);
  const workspaceSnapshotRefs = usableWorkspaceSnapshotRefs(resources);

  return {
    schemaVersion: OPERATOR_TASK_DEBUG_SCHEMA_VERSION,
    runId: input.runId,
    task: {
      taskId: task.id,
      taskKey: task.task_key,
      status: task.status,
      sortOrder: task.sort_order,
      dependsOn: stringArray(task.depends_on_json),
      ...(task.root_session_id ? { rootSessionId: task.root_session_id } : {}),
      subagentSessionIds: stringArray(task.subagent_session_ids_json),
      ...(task.executor_task_id ? { executorTaskId: task.executor_task_id } : {}),
      snapshot: asRecord(task.snapshot_json),
      metrics: asRecord(task.metrics_json),
      createdAt: task.created_at.toISOString(),
      updatedAt: task.updated_at.toISOString(),
      ...(task.completed_at ? { completedAt: task.completed_at.toISOString() } : {}),
    },
    history: historyRows.rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      eventType: row.event_type,
      runId: input.runId,
      taskId: input.taskId,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      actorType: row.actor_type,
      payload: row.payload_json,
      createdAt: row.created_at.toISOString(),
    })),
    resources,
    artifactRefs: resources
      .filter((resource) => resource.resourceType === "artifact_ref")
      .map((resource) => ({
        id: resource.id,
        resourceKey: resource.resourceKey,
        status: resource.status,
        ...(resource.title ? { title: resource.title } : {}),
        ...(artifactRefId(resource.payload) ? { artifactRefId: artifactRefId(resource.payload) } : {}),
        payload: resource.payload,
        summary: resource.summary,
        updatedAt: resource.updatedAt,
      })),
    debug: {
      session: {
        rootSessionId: task.root_session_id,
        sessionIds,
        checkpoints: resources.filter((resource) => resource.resourceType === "session_checkpoint"),
        history: sessionHistoryRows.rows.map((row) => mapHistoryRow(row, input.runId, row.task_id ?? input.taskId)),
        rawEventRefs: arrayValue(asRecord(contextPayload.managedSourceRefs).rawEventRefs),
      },
      context: {
        packets: contextPackets,
        latestPacket: latestContextPacket ?? null,
        assemblyTraces: resources.filter((resource) => resource.resourceType === "context_assembly_trace"),
      },
      envelope: {
        envelopes: resources.filter((resource) => resource.resourceType === "task_envelope"),
        latestEnvelope: resources.find((resource) => resource.resourceType === "task_envelope") ?? null,
      },
      memory: {
        selectedMemories: arrayValue(contextPayload.selectedMemories).map((memory) => withSessionSource(memory)),
        items: resources.filter((resource) => resource.resourceType === "memory_item"),
        deltas: resources.filter((resource) => resource.resourceType === "memory_delta"),
        invalidatedSourceRefs: arrayValue(asRecord(contextPayload.managedSourceRefs).rollbackMarkerRefs),
      },
      artifacts: {
        priorArtifacts: arrayValue(contextPayload.priorArtifacts),
        refs: artifacts,
      },
      resources: {
        brainBindings: resources.filter((resource) => resource.resourceType === "brain_binding"),
        handBindings: resources.filter((resource) => resource.resourceType === "hand_binding"),
        handExecutions: resources.filter((resource) => resource.resourceType === "hand_execution"),
        evaluatorResults: resources.filter((resource) => resource.resourceType === "evaluator_result"),
        recoveryDecisions: resources.filter((resource) => resource.resourceType === "recovery_decision"),
        recoveryExecutions: resources.filter((resource) => resource.resourceType === "recovery_execution"),
        approvals: resources.filter((resource) => resource.resourceType === "approval"),
        workspaceSnapshots: resources.filter((resource) => resource.resourceType === "workspace_snapshot"),
        toolProxyViolations: resources.filter((resource) => resource.resourceType === "tool_proxy_violation"),
        vaultLeases: resources.filter((resource) => resource.resourceType === "vault_lease"),
        toolGrants: resources.filter((resource) => resource.resourceType === "tool_grant"),
        other: resources.filter((resource) => ![
          "artifact_ref",
          "brain_binding",
          "context_assembly_trace",
          "context_packet",
          "evaluator_result",
          "hand_binding",
          "hand_execution",
          "memory_delta",
          "memory_item",
          "recovery_decision",
          "recovery_execution",
          "session_checkpoint",
          "task_envelope",
          "tool_grant",
          "tool_proxy_violation",
          "vault_lease",
          "workspace_snapshot",
        ].includes(resource.resourceType)),
      },
      recovery: {
        items: resources.filter((resource) => ["recovery_decision", "recovery_execution", "approval"].includes(resource.resourceType)),
        commands: recoveryActions(input.runId, resources),
      },
      raw: { resources },
    },
    actions: taskActions(input.runId, input.taskId, task.status, { checkpointRefs, workspaceSnapshotRefs }),
  };
}

async function artifactRowsWithContent(db: SouthstarDb, rows: Array<{ resourceType: string; resourceKey: string; payload: unknown }>) {
  return Promise.all(rows.map(async (row) => {
    try {
      return {
        ...row,
        artifactRefId: artifactRefId(row.payload) ?? row.resourceKey,
        content: await getArtifactRefContentPg(db, { artifactRef: row.resourceKey }),
      };
    } catch (caught) {
      return {
        ...row,
        artifactRefId: artifactRefId(row.payload) ?? row.resourceKey,
        contentError: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }));
}

function mapHistoryRow(
  row: { id: string; sequence: number; event_type: string; actor_type: string; task_id?: string | null; session_id: string | null; payload_json: unknown; created_at: Date },
  runId: string,
  taskId: string,
) {
  return {
    id: row.id,
    sequence: row.sequence,
    eventType: row.event_type,
    runId,
    taskId,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    actorType: row.actor_type,
    payload: row.payload_json,
    createdAt: row.created_at.toISOString(),
  };
}

function taskActions(
  runId: string,
  taskId: string,
  status: string,
  options: { checkpointRefs: string[]; workspaceSnapshotRefs: string[] },
): OperatorCommand[] {
  const encodedRunId = encodeURIComponent(runId);
  const encodedTaskId = encodeURIComponent(taskId);
  const recoverable = isTaskRecoverableStatus(status);
  const hasWorkspaceSnapshot = options.workspaceSnapshotRefs.length > 0;
  return [
    command("task.retry", "Retry Task", `/api/v2/runs/${encodedRunId}/tasks/${encodedTaskId}/retry`, {
      enabled: recoverable,
      requiresConfirmation: true,
    }),
    command("task.fork-session", "Fork Session", `/api/v2/runs/${encodedRunId}/tasks/${encodedTaskId}/fork-session`, {
      enabled: recoverable,
      requiresConfirmation: true,
      inputOptions: { checkpointRefs: options.checkpointRefs },
    }),
    command("task.reset-session", "Reset Session", `/api/v2/runs/${encodedRunId}/tasks/${encodedTaskId}/reset-session`, {
      enabled: recoverable,
      requiresConfirmation: true,
      inputOptions: { checkpointRefs: options.checkpointRefs },
    }),
    command("task.rollback-session", "Rollback Session", `/api/v2/runs/${encodedRunId}/tasks/${encodedTaskId}/rollback-session`, {
      enabled: recoverable && hasWorkspaceSnapshot,
      requiresConfirmation: true,
      disabledReason: hasWorkspaceSnapshot ? undefined : "rollback requires a usable workspace snapshot",
      inputOptions: { checkpointRefs: options.checkpointRefs, workspaceSnapshotRefs: options.workspaceSnapshotRefs },
    }),
    command("task.request-revision", "Request Workflow Revision", `/api/v2/runs/${encodedRunId}/tasks/${encodedTaskId}/request-revision`, {
      enabled: recoverable,
      requiresConfirmation: true,
    }),
  ];
}

function recoveryActions(runId: string, resources: Array<{ resourceType: string; resourceKey: string; status: string; payload: unknown }>): OperatorCommand[] {
  return resources.flatMap((resource) => {
    if (resource.resourceType === "recovery_decision") return recoveryCommands(runId, recoveryDecisionId(resource.payload, resource.resourceKey), resource.status);
    if (resource.resourceType === "approval") return approvalCommands(runId, approvalId(resource.payload, resource.resourceKey));
    return [];
  });
}

function recoveryCommands(runId: string, decisionId: string | undefined, status: string): OperatorCommand[] {
  const endpoint = decisionId ? `/api/v2/runs/${encodeURIComponent(runId)}/recovery-decisions/${encodeURIComponent(decisionId)}` : undefined;
  const waiting = status === "waiting_operator_approval";
  const approved = status === "approved" || status === "recorded";
  return [
    command("recovery.approve", "Approve Recovery", endpoint ? `${endpoint}/approval` : "", {
      enabled: Boolean(endpoint) && waiting,
      requiresConfirmation: true,
      body: { decision: "approved" },
    }),
    command("recovery.reject", "Reject Recovery", endpoint ? `${endpoint}/approval` : "", {
      enabled: Boolean(endpoint) && waiting,
      requiresConfirmation: true,
      body: { decision: "rejected" },
    }),
    command("recovery.apply", "Apply Recovery", endpoint ? `${endpoint}/apply` : "", {
      enabled: Boolean(endpoint) && approved,
      requiresConfirmation: true,
    }),
  ];
}

function approvalCommands(runId: string, approvalIdValue: string | undefined): OperatorCommand[] {
  const endpoint = approvalIdValue ? `/api/v2/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalIdValue)}/decision` : "";
  return [
    command("approval.approve", "Approve", endpoint, {
      enabled: Boolean(approvalIdValue),
      requiresConfirmation: true,
      body: { decision: "approved" },
    }),
    command("approval.reject", "Reject", endpoint, {
      enabled: Boolean(approvalIdValue),
      requiresConfirmation: true,
      body: { decision: "rejected" },
    }),
  ];
}

function command(
  id: string,
  label: string,
  endpoint: string,
  options: { enabled: boolean; requiresConfirmation: boolean; disabledReason?: string; body?: Record<string, unknown>; inputOptions?: OperatorCommand["inputOptions"] },
): OperatorCommand {
  return {
    id,
    label,
    endpoint,
    method: "POST",
    enabled: options.enabled,
    requiresConfirmation: options.requiresConfirmation,
    ...(options.disabledReason ? { disabledReason: options.disabledReason } : {}),
    ...(options.body ? { body: options.body } : {}),
    ...(options.inputOptions ? { inputOptions: options.inputOptions } : {}),
  };
}

function recoveryDecisionId(payload: unknown, fallback: string): string | undefined {
  const record = asRecord(payload);
  return stringValue(record.decisionId) ?? fallback.replace(/^recovery_decision:/, "");
}

function approvalId(payload: unknown, fallback: string): string | undefined {
  const record = asRecord(payload);
  return stringValue(record.approvalId) ?? fallback.replace(/^approval:/, "");
}

function artifactRefId(payload: unknown): string | undefined {
  const record = asRecord(payload);
  return stringValue(record.artifactRefId) ?? stringValue(record.artifactRef);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function withSessionSource(value: unknown): unknown {
  const record = asRecord(value);
  if (!record.source) return value;
  const source = asRecord(record.source);
  return { ...record, sourceSessionId: source.sessionId };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
