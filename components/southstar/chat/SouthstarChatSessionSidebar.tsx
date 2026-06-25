"use client";

import { useEffect, useMemo } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { useSouthstarPageModel } from "../hooks/useSouthstarPageModel";

type RunItem = {
  runId: string;
  status: string;
  title: string;
};

type SessionItem = {
  id: string;
  status: string;
  taskId: string | undefined;
  summary: string | undefined;
};

export function SouthstarChatSessionSidebar(props: {
  api: SouthstarApiClient;
  selectedRunId: string | null;
  selectedSessionId: string | null;
  onSelectRunId: (runId: string | null) => void;
  onSelectSessionId: (sessionId: string | null) => void;
}) {
  const overview = useSouthstarPageModel(() => props.api.getUiOperatorOverview(), [props.api]);
  const runItems = useMemo(() => readRunItems(overview.model), [overview.model]);

  useEffect(() => {
    if (runItems.length === 0) {
      if (props.selectedRunId !== null) props.onSelectRunId(null);
      if (props.selectedSessionId !== null) props.onSelectSessionId(null);
      return;
    }
    if (props.selectedRunId && runItems.some((item) => item.runId === props.selectedRunId)) return;
    props.onSelectRunId(runItems[0]!.runId);
  }, [runItems, props.selectedRunId, props.selectedSessionId, props.onSelectRunId, props.onSelectSessionId]);

  const sessionsModel = useSouthstarPageModel(
    () => props.selectedRunId ? props.api.getUiSessionsMemory(props.selectedRunId) : Promise.resolve(null),
    [props.api, props.selectedRunId],
  );
  const sessionItems = useMemo(() => readSessionItems(sessionsModel.model), [sessionsModel.model]);

  useEffect(() => {
    if (sessionItems.length === 0) {
      if (props.selectedSessionId !== null) props.onSelectSessionId(null);
      return;
    }
    if (props.selectedSessionId && sessionItems.some((item) => item.id === props.selectedSessionId)) return;
    props.onSelectSessionId(sessionItems[0]!.id);
  }, [sessionItems, props.selectedSessionId, props.onSelectSessionId]);

  return (
    <div className="ss-sidebar-stack">
      <section className="ss-panel">
        <header>
          <h2>Runs</h2>
          <button type="button" onClick={() => void overview.refresh()}>Refresh</button>
        </header>
        {overview.pending ? <p className="ss-empty">Loading active runs.</p> : null}
        {runItems.length === 0 && !overview.pending ? <p className="ss-empty">No active runs.</p> : null}
        {runItems.length > 0 ? (
          <ul className="ss-timeline">
            {runItems.map((run) => (
              <li key={run.runId}>
                <button
                  type="button"
                  aria-pressed={run.runId === props.selectedRunId}
                  onClick={() => props.onSelectRunId(run.runId)}
                >
                  <strong>{shortLabel(run.title, 70)}</strong>
                  <span>{run.runId} · {run.status}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="ss-panel">
        <header>
          <h2>Sessions</h2>
          <button type="button" onClick={() => void sessionsModel.refresh()} disabled={!props.selectedRunId}>Refresh</button>
        </header>
        {!props.selectedRunId ? <p className="ss-empty">Select a run to load sessions.</p> : null}
        {props.selectedRunId && sessionsModel.pending ? <p className="ss-empty">Loading sessions.</p> : null}
        {props.selectedRunId && sessionItems.length === 0 && !sessionsModel.pending ? <p className="ss-empty">No sessions published for this run.</p> : null}
        {sessionItems.length > 0 ? (
          <ul className="ss-timeline">
            {sessionItems.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  aria-pressed={session.id === props.selectedSessionId}
                  onClick={() => props.onSelectSessionId(session.id)}
                >
                  <strong>{shortLabel(session.summary ?? session.id, 70)}</strong>
                  <span>{session.id} · {session.status}{session.taskId ? ` · task ${session.taskId}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {sessionsModel.error ? <p className="ss-empty">{sessionsModel.error}</p> : null}
      </section>
    </div>
  );
}

function readRunItems(model: any): RunItem[] {
  const activeRows = asArray<any>(model?.activeRuns ?? model?.runs ?? model?.data?.activeRuns ?? model?.data?.runs);
  return activeRows
    .map((row) => {
      const runId = stringValue(row?.runId ?? row?.id);
      if (!runId) return null;
      return {
        runId,
        status: stringValue(row?.status) ?? "unknown",
        title: stringValue(row?.title ?? row?.goalPrompt) ?? runId,
      };
    })
    .filter((item): item is RunItem => item !== null);
}

function readSessionItems(model: any): SessionItem[] {
  const rows = asArray<any>(model?.data?.sessions ?? model?.sessions);
  return rows
    .map((row) => {
      const id = stringValue(row?.id ?? row?.resourceKey);
      if (!id) return null;
      const payload = asRecord(row?.payload);
      return {
        id,
        status: stringValue(row?.status) ?? "unknown",
        taskId: stringValue(row?.taskId ?? payload.taskId),
        summary: stringValue(payload.transcriptSummary ?? payload.summary ?? payload.title ?? payload.intent),
      };
    })
    .filter((item): item is SessionItem => item !== null);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function shortLabel(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
