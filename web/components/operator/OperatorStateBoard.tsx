"use client";

import { bucketForRunStatus, operatorStateBuckets } from "@/lib/operator/progress";
import type { OperatorRun } from "@/lib/operator/types";

export function OperatorStateBoard({
  runs,
  selectedRunId,
  onSelectRun,
}: {
  runs: OperatorRun[];
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
              <div className="operator-state-title">{bucket}</div>
              {bucketRuns.map((run) => (
                <button
                  key={run.runId}
                  type="button"
                  className="operator-run-card"
                  aria-pressed={selectedRunId === run.runId}
                  onClick={() => onSelectRun(run.runId)}
                >
                  <strong>{run.status}</strong>
                  <span>{run.title}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
