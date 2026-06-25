"use client";

import { useMemo } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { useSouthstarPageModel } from "../hooks/useSouthstarPageModel";

type SessionResource = {
  id: string;
  status: string;
  taskId: string | undefined;
  payload: unknown;
};

type MemoryResource = {
  id: string;
  taskId: string | undefined;
  status: string;
  payload: unknown;
};

export function SouthstarChatFileViewerPanel(props: {
  api: SouthstarApiClient;
  selectedRunId: string | null;
  selectedSessionId: string | null;
}) {
  const model = useSouthstarPageModel(
    () => props.selectedRunId ? props.api.getUiSessionsMemory(props.selectedRunId) : Promise.resolve(null),
    [props.api, props.selectedRunId],
  );

  const sessions = useMemo(() => readSessions(model.model), [model.model]);
  const memoryRows = useMemo(() => readMemoryRows(model.model), [model.model]);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === props.selectedSessionId) ?? sessions[0] ?? null,
    [sessions, props.selectedSessionId],
  );
  const relatedMemory = useMemo(() => {
    if (!selectedSession) return [];
    return memoryRows.filter((item) => !item.taskId || item.taskId === selectedSession.taskId);
  }, [memoryRows, selectedSession]);
  const fileReferences = useMemo(() => {
    const refs = new Set<string>();
    if (selectedSession) collectFileRefs(selectedSession.payload, refs, 0);
    for (const row of relatedMemory) collectFileRefs(row.payload, refs, 0);
    return [...refs].sort();
  }, [selectedSession, relatedMemory]);

  return (
    <section className="ss-panel">
      <header>
        <h2>File Viewer</h2>
        <button type="button" onClick={() => void model.refresh()} disabled={!props.selectedRunId}>Refresh</button>
      </header>
      {!props.selectedRunId ? <p className="ss-empty">Select a run to inspect file references.</p> : null}
      {props.selectedRunId && model.pending ? <p className="ss-empty">Loading session payload and memory.</p> : null}
      {props.selectedRunId && !model.pending && !selectedSession ? <p className="ss-empty">No session payload available for this run.</p> : null}
      {selectedSession ? (
        <>
          <p><strong>Session:</strong> {selectedSession.id} · {selectedSession.status}</p>
          {selectedSession.taskId ? <p><strong>Task:</strong> {selectedSession.taskId}</p> : null}
          {fileReferences.length === 0 ? (
            <p className="ss-empty">No file paths were emitted by this session yet.</p>
          ) : (
            <>
              <h3>Referenced Files</h3>
              <ul className="ss-timeline">
                {fileReferences.map((path) => (
                  <li key={path}><span>{path}</span></li>
                ))}
              </ul>
            </>
          )}
          <details open>
            <summary>Session Payload</summary>
            <pre>{renderJson(selectedSession.payload)}</pre>
          </details>
          <details>
            <summary>Related Memory</summary>
            <pre>{renderJson(relatedMemory.map((item) => ({ id: item.id, status: item.status, taskId: item.taskId, payload: item.payload })))}</pre>
          </details>
        </>
      ) : null}
      {model.error ? <p className="ss-empty">{model.error}</p> : null}
    </section>
  );
}

function readSessions(model: any): SessionResource[] {
  const rows = asArray<any>(model?.data?.sessions ?? model?.sessions);
  return rows
    .map((row) => {
      const id = stringValue(row?.id);
      if (!id) return null;
      return {
        id,
        status: stringValue(row?.status) ?? "unknown",
        taskId: stringValue(row?.taskId),
        payload: row?.payload,
      };
    })
    .filter((row): row is SessionResource => row !== null);
}

function readMemoryRows(model: any): MemoryResource[] {
  const dataRows = asArray<any>(model?.data?.memory ?? model?.memory);
  return dataRows
    .map((row) => {
      const id = stringValue(row?.id);
      if (!id) return null;
      return {
        id,
        taskId: stringValue(row?.taskId),
        status: stringValue(row?.status) ?? "unknown",
        payload: row?.payload,
      };
    })
    .filter((row): row is MemoryResource => row !== null);
}

function collectFileRefs(value: unknown, refs: Set<string>, depth: number): void {
  if (depth > 5) return;
  if (typeof value === "string") {
    if (looksLikePath(value)) refs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFileRefs(item, refs, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, next] of Object.entries(value as Record<string, unknown>)) {
    if (typeof next === "string" && (key.toLowerCase().includes("path") || key.toLowerCase().includes("file"))) {
      if (looksLikePath(next)) refs.add(next);
      continue;
    }
    collectFileRefs(next, refs, depth + 1);
  }
}

function looksLikePath(value: string): boolean {
  if (value.length < 3) return false;
  return /[\\/]/.test(value) && /[A-Za-z0-9_-]+\.[A-Za-z0-9]+/.test(value);
}

function renderJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (!serialized) return "";
  return serialized.length > 4000 ? `${serialized.slice(0, 4000)}\n...` : serialized;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
