import { Activity, Cpu, Radio, Route, Signal } from "lucide-react";
import type { RuntimeMonitorView } from "./types";

export function RuntimeMonitor(props: { model?: RuntimeMonitorView }) {
  const rows = props.model ? [
    { label: "run.status", value: props.model.status, tone: props.model.status === "running" ? "active" : "idle", icon: <Signal size={14} aria-hidden /> },
    { label: "executor.jobs", value: props.model.executorJobIds.join(", ") || "none", tone: props.model.executorJobIds.length > 0 ? "ready" : "idle", icon: <Cpu size={14} aria-hidden /> },
    { label: "running.tasks", value: props.model.runningTaskIds.join(", ") || "none", tone: props.model.runningTaskIds.length > 0 ? "active" : "idle", icon: <Activity size={14} aria-hidden /> },
    { label: "latest.progress", value: props.model.latestProgress ?? "none", tone: props.model.latestProgress ? "ready" : "idle", icon: <Route size={14} aria-hidden /> },
    { label: "latest.steering", value: props.model.latestSteering ?? "none", tone: props.model.latestSteering ? "ready" : "idle", icon: <Radio size={14} aria-hidden /> },
  ] : [
    { label: "runtime.status", value: "Waiting for run", tone: "idle", icon: <Signal size={14} aria-hidden /> },
  ];
  return (
    <section className="ss-panel ss-runtime" data-panel="runtime-monitor" id="runtime-monitor">
      <header>
        <h2><Activity size={15} aria-hidden /> Runtime Monitor</h2>
        <span className="ss-runtime-source">SSE + polling</span>
      </header>
      <div className="ss-runtime-list">
        {rows.map((row) => (
          <div key={row.label} className={`ss-runtime-row ss-tone-${row.tone}`}>
            <span className="ss-runtime-icon">{row.icon}</span>
            <span className="ss-runtime-label">{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
