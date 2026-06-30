"use client";

import type { OperatorHistoryItem } from "@/lib/operator/types";

export function OperatorHistoryPanel({ history }: { history: OperatorHistoryItem[] }) {
  return (
    <section data-testid="operator-history-panel" className="operator-debug-panel">
      {history.length === 0 ? (
        <p className="operator-muted">No history for this task.</p>
      ) : (
        <ol className="operator-debug-list">
          {history.map((item) => (
            <li key={item.sequence}>
              <strong>#{item.sequence} {item.eventType}</strong>
              <span>{item.actorType} · {item.createdAt}</span>
              <pre>{JSON.stringify(item.payload, null, 2)}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
