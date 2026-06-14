import type { RuntimeMonitorView } from "./types";

export function RuntimeMonitor(props: { model?: RuntimeMonitorView }) {
  const rows = props.model ? [
    ["run.status", props.model.status],
    ["executor.jobs", props.model.executorJobIds.join(", ") || "none"],
    ["running.tasks", props.model.runningTaskIds.join(", ") || "none"],
    ["latest.progress", props.model.latestProgress ?? "none"],
    ["latest.steering", props.model.latestSteering ?? "none"],
  ] : [
    ["runtime.status", "Waiting for run"],
  ];
  return (
    <section className="ss-panel ss-runtime" data-panel="runtime-monitor" id="runtime-monitor">
      <header>
        <h2>Runtime Monitor</h2>
        <span>SSE + polling</span>
      </header>
      <table>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
