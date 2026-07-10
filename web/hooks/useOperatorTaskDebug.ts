"use client";

import { useEffect, useState } from "react";
import type { OperatorCommand, OperatorHistoryItem, OperatorResourceItem, OperatorTaskDebug, OperatorTaskDebugGroups } from "@/lib/operator/types";

export function useOperatorTaskDebug(runId: string | null, taskId: string | null) {
  const [model, setModel] = useState<OperatorTaskDebug | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId || !taskId) {
      setModel(null);
      setError(null);
      return;
    }
    setModel(null);
    setError(null);
    const controller = new AbortController();
    fetch(`/api/operator/task-debug?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(taskId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        setModel(normalizeOperatorTaskDebug(data.result || data));
        setError(null);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => controller.abort();
  }, [runId, taskId]);

  const matchingModel = model?.data.runId === runId && model.data.task.taskId === taskId ? model : null;
  return { model: matchingModel, error };
}

function normalizeOperatorTaskDebug(input: unknown): OperatorTaskDebug {
  const record = asRecord(input);
  const data = recordValue(record.data) ?? record;
  const task = asRecord(data.task);
  const runId = stringValue(data.runId) || "";
  const taskId = stringValue(task.taskId || task.id) || "";
  return {
    schemaVersion: "southstar.read_model.operator_task_debug.v1",
    kind: "operator-task-debug",
    data: {
      runId,
      task: {
        taskId,
        taskKey: stringValue(task.taskKey || task.task_key) || taskId,
        status: stringValue(task.status) || "unknown",
        sortOrder: numberValue(task.sortOrder) ?? 0,
        dependsOn: stringArray(task.dependsOn),
        rootSessionId: nullableString(task.rootSessionId),
        executorTaskId: nullableString(task.executorTaskId),
        snapshot: task.snapshot,
        metrics: task.metrics,
        updatedAt: stringValue(task.updatedAt),
      },
      history: arrayValue(data.history).map(readHistoryItem),
      resources: arrayValue(data.resources).map(readResourceItem),
      artifacts: arrayValue(data.artifacts || data.artifactRefs).map(readArtifactItem),
      debug: readDebugGroups(data.debug),
      actions: arrayValue(data.actions).map(readCommand),
    },
  };
}

function readDebugGroups(input: unknown): OperatorTaskDebugGroups | undefined {
  const row = recordValue(input);
  if (!row) return undefined;
  const session = asRecord(row.session);
  const context = asRecord(row.context);
  const envelope = asRecord(row.envelope);
  const memory = asRecord(row.memory);
  const artifacts = asRecord(row.artifacts);
  const resources = asRecord(row.resources);
  const raw = asRecord(row.raw);
  return {
    session: {
      rootSessionId: nullableString(session.rootSessionId),
      sessionIds: stringArray(session.sessionIds),
      checkpoints: arrayValue(session.checkpoints).map(readResourceItem),
      history: arrayValue(session.history).map(readHistoryItem),
      rawEventRefs: arrayValue(session.rawEventRefs),
    },
    context: {
      packets: arrayValue(context.packets).map(readResourceItem),
      latestPacket: recordValue(context.latestPacket) ? readResourceItem(context.latestPacket) : null,
      assemblyTraces: arrayValue(context.assemblyTraces).map(readResourceItem),
    },
    envelope: {
      envelopes: arrayValue(envelope.envelopes).map(readResourceItem),
      latestEnvelope: recordValue(envelope.latestEnvelope) ? readResourceItem(envelope.latestEnvelope) : null,
    },
    memory: {
      selectedMemories: arrayValue(memory.selectedMemories),
      items: arrayValue(memory.items).map(readResourceItem),
      deltas: arrayValue(memory.deltas).map(readResourceItem),
    },
    artifacts: {
      priorArtifacts: arrayValue(artifacts.priorArtifacts),
      refs: arrayValue(artifacts.refs).map(readArtifactItem),
    },
    resources: Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, arrayValue(value).map(readResourceItem)])),
    raw: { resources: arrayValue(raw.resources).map(readResourceItem) },
  };
}

function readHistoryItem(input: unknown): OperatorHistoryItem {
  const row = asRecord(input);
  return {
    sequence: numberValue(row.sequence) ?? 0,
    eventType: stringValue(row.eventType || row.event_type) || "unknown",
    actorType: stringValue(row.actorType || row.actor_type) || "unknown",
    runId: stringValue(row.runId || row.run_id),
    taskId: stringValue(row.taskId || row.task_id),
    sessionId: stringValue(row.sessionId || row.session_id),
    payload: row.payload ?? row.payload_json ?? {},
    createdAt: stringValue(row.createdAt || row.created_at) || "",
  };
}

function readResourceItem(input: unknown): OperatorResourceItem {
  const row = asRecord(input);
  return {
    resourceType: stringValue(row.resourceType || row.resource_type) || "resource",
    resourceKey: stringValue(row.resourceKey || row.resource_key || row.id) || "unknown",
    status: stringValue(row.status) || "unknown",
    title: stringValue(row.title),
    payload: row.payload ?? row.payload_json ?? {},
    summary: row.summary ?? row.summary_json ?? {},
    content: row.content,
    contentError: stringValue(row.contentError),
    artifactRefId: stringValue(row.artifactRefId),
    updatedAt: stringValue(row.updatedAt || row.updated_at) || "",
  };
}

function readArtifactItem(input: unknown): OperatorResourceItem {
  const row = readResourceItem(input);
  return { ...row, resourceType: row.resourceType === "resource" ? "artifact_ref" : row.resourceType };
}

function readCommand(input: unknown): OperatorCommand {
  const row = asRecord(input);
  return {
    id: stringValue(row.id) || "command",
    label: stringValue(row.label) || stringValue(row.id) || "Command",
    endpoint: stringValue(row.endpoint),
    method: stringValue(row.method) || "POST",
    enabled: Boolean(row.enabled),
    requiresConfirmation: Boolean(row.requiresConfirmation),
    disabledReason: stringValue(row.disabledReason),
    body: asRecord(row.body),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
