"use client";

export function ActiveRunStrip(props: {
  runs: any[];
  selectedRunId?: string | null;
  onSelectRun: (runId: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 38, borderBottom: "1px solid var(--border)", padding: "0 10px", overflowX: "auto", background: "var(--bg-panel)" }}>
      <strong style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>Active Runs</strong>
      {props.runs.map((run) => (
        <button
          key={run.runId}
          type="button"
          aria-pressed={props.selectedRunId === run.runId}
          onClick={() => props.onSelectRun(run.runId)}
          style={{
            height: 24,
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: props.selectedRunId === run.runId ? "var(--bg-selected)" : "var(--bg)",
            color: "var(--text)",
            fontSize: 11,
            whiteSpace: "nowrap",
          }}
        >
          {run.runId} · {run.status}
        </button>
      ))}
    </div>
  );
}
