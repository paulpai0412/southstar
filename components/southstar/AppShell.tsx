"use client";

import { useState } from "react";
import { OperationsPanels } from "./OperationsPanels";
import { PlannerChat } from "./PlannerChat";
import { RuntimeMonitor } from "./RuntimeMonitor";
import { TaskDetail } from "./TaskDetail";
import type { SouthstarViewMode } from "./view-mode";
import { WorkflowCanvas } from "./WorkflowCanvas";

export function SouthstarOperationsApp() {
  const [mode, setMode] = useState<SouthstarViewMode>("simple");

  return (
    <main className={`ss-app-shell ss-mode-${mode}`}>
      <aside className="ss-rail">
        <div className="ss-brand">Southstar v2</div>
        <nav>
          <a href="#planner-chat">Planner Chat</a>
          <a href="#workflow-canvas">Workflow Canvas</a>
          <a href="#runtime-monitor">Runtime Monitor</a>
          <a href="#task-detail">Task Detail</a>
          <a href="#executor-ops">Executor Ops</a>
        </nav>
      </aside>
      <section className="ss-workspace">
        <header className="ss-topbar">
          <strong>Pi Planner Orchestration</strong>
          <div className="ss-toggle" aria-label="view mode">
            <button type="button" onClick={() => setMode("simple")} aria-pressed={mode === "simple"}>
              Simple
            </button>
            <button type="button" onClick={() => setMode("full")} aria-pressed={mode === "full"}>
              Full
            </button>
          </div>
        </header>
        <div className="ss-grid">
          <PlannerChat />
          <WorkflowCanvas />
          <RuntimeMonitor />
          <TaskDetail />
        </div>
        {mode === "full" ? <OperationsPanels /> : null}
      </section>
    </main>
  );
}
