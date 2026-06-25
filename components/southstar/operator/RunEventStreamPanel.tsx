"use client";

import { useEffect, useState } from "react";

export function RunEventStreamPanel(props: { baseUrl: string; runId?: string | null }) {
  const [events, setEvents] = useState<any[]>([]);
  const [connection, setConnection] = useState("idle");

  useEffect(() => {
    if (!props.runId) return;
    setEvents([]);
    setConnection("connecting");
    const stream = new EventSource(`${props.baseUrl}/api/v2/runs/${encodeURIComponent(props.runId)}/events/stream?closeOnTerminal=false`);
    stream.onopen = () => setConnection("connected");
    stream.onerror = () => setConnection("reconnecting");
    stream.onmessage = (event) => {
      try {
        setEvents((current) => [JSON.parse(event.data), ...current].slice(0, 80));
      } catch {
        setEvents((current) => [{ eventType: "unparsed", payload: event.data }, ...current].slice(0, 80));
      }
    };
    return () => stream.close();
  }, [props.baseUrl, props.runId]);

  return (
    <section style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>Event Stream · {connection}</h3>
      <div style={{ maxHeight: 220, overflow: "auto", display: "grid", gap: 4 }}>
        {events.map((event, index) => (
          <pre key={`${event.sequence ?? index}:${event.eventType ?? "event"}`} style={{ margin: 0, fontSize: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, padding: 6, overflow: "auto" }}>
            {JSON.stringify(event, null, 2)}
          </pre>
        ))}
      </div>
    </section>
  );
}
