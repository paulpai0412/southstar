"use client";

import { useEffect, useRef, useState } from "react";

type StreamEvent = {
  id: string;
  eventType: string;
  text: string;
};

type SseFrame = {
  id?: string;
  eventType: string;
  data: string;
};

export function RunEventStreamPanel(props: { runId: string | null; serverBaseUrl: string }) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastEventIdByRunRef = useRef<Record<string, string>>({});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const runId = props.runId;
    if (!runId) {
      setEvents([]);
      setError(null);
      return;
    }
    setEvents([]);
    let activeController: AbortController | null = null;
    let reconnectAttempt = 0;
    let isClosed = false;

    const closeActiveStream = () => {
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
    };

    const scheduleReconnect = () => {
      reconnectAttempt += 1;
      const reconnectDelayMs = Math.min(4000, 800 * reconnectAttempt);
      reconnectTimerRef.current = setTimeout(() => void openStream("reconnect"), reconnectDelayMs);
    };

    const openStream = async (mode: "initial" | "reconnect") => {
      if (isClosed) return;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const controller = new AbortController();
      activeController = controller;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let buffer = "";
      try {
        const url = runtimeEventStreamUrl(props.serverBaseUrl, runId, lastEventIdByRunRef.current[runId]);
        const response = await fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`event stream failed with ${response.status}`);
        if (!response.body) throw new Error("event stream response missing body");
        reconnectAttempt = 0;
        setError(null);
        if (mode === "reconnect") setError(null);
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (!isClosed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseBuffer(buffer);
          buffer = parsed.remaining;
          for (const frame of parsed.frames) {
            if (frame.id) lastEventIdByRunRef.current[runId] = frame.id;
            if (frame.eventType === "heartbeat") continue;
            const data = parseEventData(frame.data, frame.eventType, frame.id);
            const id = data.id ?? frame.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            setEvents((current) => [{ id, eventType: data.eventType, text: data.text }, ...current].slice(0, 20));
          }
        }
        if (isClosed) return;
        setError("Event stream disconnected. Reconnecting...");
        scheduleReconnect();
      } catch (caught) {
        if (isClosed || controller.signal.aborted) return;
        setError(`Event stream disconnected. Reconnecting... ${(caught as Error).message}`);
        scheduleReconnect();
      } finally {
        reader?.releaseLock();
      }
      if (mode === "reconnect" && !isClosed) {
        setError("Event stream reconnecting...");
      }
    };

    void openStream("initial");
    return () => {
      isClosed = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      closeActiveStream();
    };
  }, [props.runId, props.serverBaseUrl]);

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

export function runtimeEventStreamUrl(serverBaseUrl: string, runId: string, lastEventId?: string): string {
  const cursorSuffix = lastEventId ? `&after=${encodeURIComponent(lastEventId)}` : "";
  return `${serverBaseUrl.replace(/\/$/, "")}/api/v2/runs/${encodeURIComponent(runId)}/events/stream?closeOnTerminal=false${cursorSuffix}`;
}

export function parseSseBuffer(buffer: string): { frames: SseFrame[]; remaining: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remaining = parts.pop() ?? "";
  return {
    frames: parts.map(parseSseFrame).filter((frame): frame is SseFrame => frame !== null),
    remaining,
  };
}

function parseSseFrame(raw: string): SseFrame | null {
  let id: string | undefined;
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("event:")) eventType = line.slice(6).trimStart();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0 && eventType === "message" && !id) return null;
  return {
    ...(id ? { id } : {}),
    eventType,
    data: dataLines.join("\n"),
  };
}

function parseEventData(raw: string, fallbackEventType = "event", fallbackId?: string): { id?: string; eventType: string; text: string } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      id: optionalString(parsed.id) ?? fallbackId,
      eventType: optionalString(parsed.eventType) ?? optionalString(parsed.type) ?? fallbackEventType,
      text: optionalString(parsed.message) ?? optionalString(parsed.summary) ?? optionalString(parsed.text) ?? raw,
    };
  } catch {
    return { ...(fallbackId ? { id: fallbackId } : {}), eventType: fallbackEventType, text: raw };
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
