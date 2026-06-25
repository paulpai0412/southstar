"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";

type RuntimeEvent = {
  id: string;
  sequence: number;
  eventType: string;
  actorType: string;
  sessionId?: string;
  taskId?: string;
  text: string;
  createdAt?: string;
};

export function ChatTranscriptPanel(props: {
  api: SouthstarApiClient;
  serverBaseUrl: string;
  selectedRunId: string | null;
  selectedSessionId: string | null;
}) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "live" | "reconnecting">("idle");
  const [composerValue, setComposerValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refreshHistory = useCallback(async () => {
    if (!props.selectedRunId) {
      setEvents([]);
      setPending(false);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const rows = await readRunHistory(props.serverBaseUrl, props.selectedRunId);
      setEvents(rows);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setPending(false);
    }
  }, [props.serverBaseUrl, props.selectedRunId]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (!props.selectedRunId) {
      setStreamState("idle");
      return;
    }
    setStreamState("connecting");
    const stream = new EventSource(`${props.serverBaseUrl}/api/v2/runs/${encodeURIComponent(props.selectedRunId)}/events/stream?closeOnTerminal=false`);
    stream.onopen = () => setStreamState("live");
    stream.onmessage = (event) => {
      const parsed = parseStreamEvent(event.data);
      if (!parsed) return;
      setEvents((current) => upsertEvent(current, parsed));
    };
    stream.onerror = () => {
      setStreamState("reconnecting");
    };
    return () => {
      stream.close();
      setStreamState("idle");
    };
  }, [props.serverBaseUrl, props.selectedRunId]);

  const visibleEvents = useMemo(() => {
    if (!props.selectedSessionId) return events;
    const bySession = events.filter((event) => event.sessionId === props.selectedSessionId);
    return bySession.length > 0 ? bySession : events;
  }, [events, props.selectedSessionId]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = composerValue.trim();
    if (!props.selectedRunId || message.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await props.api.steer(props.selectedRunId, message);
      setComposerValue("");
      await refreshHistory();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="ss-chat-workspace">
      <header className="ss-topbar">
        <h2>Transcript</h2>
        <span>{statusLabel(streamState, props.selectedRunId, props.selectedSessionId)}</span>
      </header>
      {!props.selectedRunId ? <p className="ss-empty">Select a run from the sidebar to load transcript events.</p> : null}
      {props.selectedRunId && pending ? <p className="ss-empty">Loading transcript history.</p> : null}
      {props.selectedRunId && !pending && visibleEvents.length === 0 ? <p className="ss-empty">No transcript events yet for this run.</p> : null}
      {visibleEvents.length > 0 ? (
        <ul className="ss-timeline">
          {visibleEvents.map((item) => (
            <li key={item.id}>
              <strong>{item.eventType}</strong>
              <span>{item.text}</span>
              <span>{item.actorType}{item.sessionId ? ` · ${item.sessionId}` : ""}{item.createdAt ? ` · ${item.createdAt}` : ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="ss-guided-chat" onSubmit={onSubmit}>
        <label htmlFor="southstar-chat-message">Message</label>
        <textarea
          id="southstar-chat-message"
          value={composerValue}
          onChange={(event) => setComposerValue(event.target.value)}
          disabled={!props.selectedRunId || sending}
        />
        <div className="ss-actions">
          <button type="submit" disabled={!props.selectedRunId || sending || composerValue.trim().length === 0}>
            {sending ? "Sending..." : "Send"}
          </button>
          <button type="button" onClick={() => void refreshHistory()} disabled={!props.selectedRunId || pending}>
            Refresh history
          </button>
        </div>
      </form>
      {error ? <p className="ss-empty">{error}</p> : null}
    </div>
  );
}

async function readRunHistory(baseUrl: string, runId: string): Promise<RuntimeEvent[]> {
  const response = await fetch(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/events?after=0`);
  const payload = await response.json() as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `Failed to load events (${response.status})`);
  const rows = Array.isArray(payload.result) ? payload.result : [];
  return rows
    .map(toRuntimeEvent)
    .filter((row): row is RuntimeEvent => row !== null)
    .sort((left, right) => left.sequence - right.sequence);
}

function parseStreamEvent(raw: string): RuntimeEvent | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return toRuntimeEvent(parsed);
  } catch {
    return {
      id: `raw-${Date.now()}`,
      sequence: Number.MAX_SAFE_INTEGER,
      eventType: "event",
      actorType: "runtime",
      text: raw,
    };
  }
}

function toRuntimeEvent(value: unknown): RuntimeEvent | null {
  const row = asRecord(value);
  const sequence = numberValue(row.sequence);
  const eventType = stringValue(row.eventType ?? row.type);
  if (!eventType) return null;
  const payload = asRecord(row.payload);
  return {
    id: stringValue(row.id) ?? (sequence !== null ? String(sequence) : `${eventType}-${Date.now()}`),
    sequence: sequence ?? Number.MAX_SAFE_INTEGER,
    eventType,
    actorType: stringValue(row.actorType) ?? "runtime",
    sessionId: stringValue(row.sessionId),
    taskId: stringValue(row.taskId),
    text: payloadText(payload) ?? stringValue(row.message) ?? eventType,
    createdAt: stringValue(row.createdAt),
  };
}

function upsertEvent(current: RuntimeEvent[], next: RuntimeEvent): RuntimeEvent[] {
  const index = current.findIndex((item) => item.id === next.id || (item.sequence !== Number.MAX_SAFE_INTEGER && item.sequence === next.sequence));
  if (index >= 0) {
    const replaced = [...current];
    replaced[index] = next;
    return replaced;
  }
  return [...current, next].sort((left, right) => left.sequence - right.sequence);
}

function payloadText(payload: Record<string, unknown>): string | undefined {
  const preferred = stringValue(payload.message) ?? stringValue(payload.summary) ?? stringValue(payload.transcript) ?? stringValue(payload.text);
  if (preferred) return preferred;
  const serialized = JSON.stringify(payload);
  if (!serialized || serialized === "{}") return undefined;
  return serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized;
}

function statusLabel(
  streamState: "idle" | "connecting" | "live" | "reconnecting",
  runId: string | null,
  sessionId: string | null,
): string {
  if (!runId) return "No run selected";
  const base = streamState === "live"
    ? "Live stream connected"
    : streamState === "reconnecting"
      ? "Reconnecting stream"
      : streamState === "connecting"
        ? "Connecting stream"
        : "Stream idle";
  return sessionId ? `${base} · session ${sessionId}` : base;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
