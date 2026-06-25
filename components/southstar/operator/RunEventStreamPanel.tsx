"use client";

import { useEffect, useRef, useState } from "react";

type StreamEvent = {
  id: string;
  eventType: string;
  text: string;
};

export function RunEventStreamPanel(props: { runId: string | null }) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const runId = props.runId;
    if (!runId) {
      setEvents([]);
      setError(null);
      lastEventIdRef.current = null;
      return;
    }
    let activeStream: EventSource | null = null;
    let reconnectAttempt = 0;
    let isClosed = false;

    const closeActiveStream = () => {
      if (activeStream) {
        activeStream.close();
        activeStream = null;
      }
    };

    const openStream = (mode: "initial" | "reconnect") => {
      if (isClosed) return;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const cursor = lastEventIdRef.current;
      const cursorSuffix = cursor ? `&after=${encodeURIComponent(cursor)}` : "";
      const url = `/api/v2/runs/${encodeURIComponent(runId)}/events/stream?closeOnTerminal=false${cursorSuffix}`;
      const stream = new EventSource(url);
      activeStream = stream;
      stream.onopen = () => {
        reconnectAttempt = 0;
        setError(null);
      };
      stream.onmessage = (event) => {
        const data = parseEventData(event.data);
        const lastEventId = data.id ?? optionalString(event.lastEventId);
        if (lastEventId) lastEventIdRef.current = lastEventId;
        const id = lastEventId ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        setEvents((current) => [{ id, eventType: data.eventType, text: data.text }, ...current].slice(0, 20));
      };
      stream.onerror = () => {
        if (isClosed) return;
        setError("Event stream disconnected. Reconnecting...");
        closeActiveStream();
        reconnectAttempt += 1;
        const reconnectDelayMs = Math.min(4000, 800 * reconnectAttempt);
        reconnectTimerRef.current = setTimeout(() => openStream("reconnect"), reconnectDelayMs);
      };
      if (mode === "reconnect") {
        setError("Event stream reconnecting...");
      }
    };

    openStream("initial");
    return () => {
      isClosed = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      closeActiveStream();
    };
  }, [props.runId]);

  return (
    <section className="ss-runtime">
      <header>
        <h2>Run Event Stream</h2>
      </header>
      {props.runId ? null : <p className="ss-empty">Select a run to subscribe to events.</p>}
      {props.runId && events.length === 0 ? <p className="ss-empty">Waiting for runtime events.</p> : null}
      {events.length > 0 ? (
        <ul className="ss-timeline">
          {events.map((event) => (
            <li key={event.id}>
              <strong>{event.eventType}</strong> <span>{event.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="ss-empty">{error}</p> : null}
    </section>
  );
}

function parseEventData(raw: string): { id?: string; eventType: string; text: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      id: optionalString(parsed.id),
      eventType: optionalString(parsed.eventType) ?? optionalString(parsed.type) ?? "event",
      text: optionalString(parsed.message) ?? optionalString(parsed.summary) ?? raw,
    };
  } catch {
    return { eventType: "event", text: raw };
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
