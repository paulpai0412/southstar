"use client";

type ActiveRun = {
  runId: string;
  status: string;
  title: string;
};

export function ActiveRunStrip(props: {
  runs: ActiveRun[];
  selectedRunId: string | null;
  activeCwd: string | null;
  onSelectRun: (runId: string) => void;
}) {
  return (
    <section className="ss-panel">
      <header>
        <h2>Active Runs</h2>
      </header>
      {props.runs.length > 0 ? (
        <ul className="ss-timeline">
          {props.runs.map((run) => (
            <li key={run.runId}>
              <button
                type="button"
                onClick={() => props.onSelectRun(run.runId)}
                aria-pressed={props.selectedRunId === run.runId}
              >
                <strong>{run.status}</strong> {run.title}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ss-empty">No active runs for {props.activeCwd ?? "all workspaces"}.</p>
      )}
    </section>
  );
}
