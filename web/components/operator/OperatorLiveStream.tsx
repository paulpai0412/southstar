"use client";

import { useState } from "react";
import { useRuntimeEventStream } from "@/hooks/useRuntimeEventStream";

export function OperatorLiveStream({ runId, taskId }: { runId: string | null; taskId: string | null }) {
  const [scope, setScope] = useState<"task" | "run">("task");
  const { events, error } = useRuntimeEventStream({ runId, taskId, scope });

  return (
    <section data-testid="operator-live-stream" className="operator-debug-panel">
      <header className="operator-panel-header">
        <h2>{scope === "task" ? "Task stream" : "Run stream"}</h2>
        <div className="operator-segmented">
          <button type="button" aria-pressed={scope === "task"} onClick={() => setScope("task")} disabled={!taskId}>Task stream</button>
          <button type="button" aria-pressed={scope === "run"} onClick={() => setScope("run")}>Run stream</button>
        </div>
      </header>
      {error ? <p className="operator-muted operator-danger">{error}</p> : null}
      {events.length === 0 ? (
        <p className="operator-muted">Waiting for runtime events.</p>
      ) : (
        <ol className="operator-debug-list">
          {events.map((event) => (
            <li key={event.id}>
              <strong>{event.sequence ? `#${event.sequence} ` : ""}{event.eventType}</strong>
              <span>{event.taskId || "run"} · {event.createdAt || ""}</span>
              <pre>{event.text}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
