"use client";

import type { OperatorResourceItem } from "@/lib/operator/types";

export function OperatorArtifactsPanel({ artifacts, resources }: { artifacts: OperatorResourceItem[]; resources: OperatorResourceItem[] }) {
  const rows = artifacts.length > 0 ? artifacts : resources;

  return (
    <section data-testid="operator-artifacts-panel" className="operator-debug-panel">
      {rows.length === 0 ? (
        <p className="operator-muted">No artifacts or task resources.</p>
      ) : (
        <ol className="operator-debug-list">
          {rows.map((item) => (
            <li key={`${item.resourceType}:${item.resourceKey}`}>
              <strong>{item.resourceType} · {item.status}</strong>
              <span>{item.title}</span>
              <pre>{JSON.stringify({ summary: item.summary, payload: item.payload }, null, 2)}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
