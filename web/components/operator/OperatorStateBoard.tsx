"use client";

import { bucketForRunStatus, operatorStateBuckets } from "@/lib/operator/progress";
import type { OperatorAttentionItem, OperatorRun } from "@/lib/operator/types";

export function OperatorStateBoard({
  runs,
  attentionItems,
  selectedRunId,
  onSelectRun,
}: {
  runs: OperatorRun[];
  attentionItems: OperatorAttentionItem[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  return (
    <section data-testid="operator-state-board" className="operator-panel">
      <header className="operator-panel-header">
        <h2>Runtime State Board</h2>
      </header>
      <div className="operator-state-grid">
        {operatorStateBuckets.map((bucket) => {
          const bucketRuns = runs.filter((run) => bucketForRunStatus(run.status) === bucket);
          return (
            <div key={bucket} className="operator-state-column">
              <div className="operator-state-title">
                <span>{bucket}</span>
                <span className="operator-state-count">{bucketRuns.length}</span>
              </div>
              {bucketRuns.map((run) => {
                const severity = highestAttentionSeverity(attentionItems.filter((item) => item.runId === run.runId));
                return (
                  <button
                    key={run.runId}
                    type="button"
                    className="operator-run-card"
                    aria-pressed={selectedRunId === run.runId}
                    onClick={() => onSelectRun(run.runId)}
                  >
                    <strong>{run.status}</strong>
                    <span>{run.title}</span>
                    <em>{formatRunAge(run.updatedAt)}</em>
                    {severity ? <small className="operator-run-severity">{severity}</small> : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function formatRunAge(updatedAt: string | undefined): string {
  if (!updatedAt) return "age unknown";
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "age unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function highestAttentionSeverity(items: OperatorAttentionItem[]): string | null {
  const order = new Map([
    ["blocked", 4],
    ["error", 3],
    ["warning", 2],
    ["info", 1],
  ]);
  return items.reduce<string | null>((highest, item) => {
    if (!highest) return item.severity;
    return (order.get(item.severity) || 0) > (order.get(highest) || 0) ? item.severity : highest;
  }, null);
}
