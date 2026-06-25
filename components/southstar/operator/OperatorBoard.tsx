"use client";

import { useEffect, useMemo, useState } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import { ActiveRunStrip } from "./ActiveRunStrip";
import { AttentionQueue } from "./AttentionQueue";
import { InterventionPanel } from "./InterventionPanel";

export function OperatorBoard(props: { api: SouthstarApiClient; activeCwd: string | null }) {
  void props.activeCwd;
  const [overview, setOverview] = useState<any | null>(null);
  const [workflowModel, setWorkflowModel] = useState<any | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const baseUrl = useMemo(() => southstarServerUrl(), []);

  useEffect(() => {
    void refreshOverview();
  }, []);

  async function refreshOverview() {
    try {
      const next = await props.api.getUiOperatorOverview();
      setOverview(next);
      const runId = next.defaultSelection?.runId ?? next.activeRuns?.[0]?.runId ?? null;
      if (runId) await selectRun(runId);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function selectRun(runId: string, taskId?: string) {
    setSelectedRunId(runId);
    const model = await props.api.getUiWorkflow({ runId, taskId });
    setWorkflowModel(model);
    setSelectedNodeId(model.canvasModel?.selectedNodeId ?? null);
  }

  async function selectItem(item: any) {
    setSelectedItem(item);
    if (item.runId) await selectRun(item.runId, item.taskId);
  }

  async function runCommand(endpoint: string, commandId: string, requiresConfirmation?: boolean) {
    if (requiresConfirmation && !window.confirm(`Run ${commandId}?`)) return;
    await props.api.command(endpoint, {
      commandId: `${commandId}:${crypto.randomUUID()}`,
      actor: { type: "user", id: "southstar-operator-ui" },
      reason: "operator ui command",
    });
    await refreshOverview();
  }

  return (
    <section style={{ height: "100%", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minWidth: 0 }}>
      <div aria-label="Active Runs">
        <ActiveRunStrip runs={overview?.activeRuns ?? []} selectedRunId={selectedRunId} onSelectRun={(runId) => void selectRun(runId).catch((caught) => setError((caught as Error).message))} />
      </div>
      <div style={{ minHeight: 0, display: "grid", gridTemplateColumns: "300px minmax(0, 1fr) 420px" }}>
        <div aria-label="Attention Queue">
          <AttentionQueue items={overview?.attentionItems ?? []} selectedItemId={selectedItem?.id} onSelectItem={(item) => void selectItem(item).catch((caught) => setError((caught as Error).message))} />
        </div>
        <div style={{ minWidth: 0, minHeight: 0 }}>
          <SouthstarWorkflowCanvas model={workflowModel?.canvasModel ?? null} selectedNodeId={selectedNodeId} onSelectNode={(nodeId) => {
            setSelectedNodeId(nodeId);
            if (selectedRunId) void selectRun(selectedRunId, nodeId).catch((caught) => setError((caught as Error).message));
          }} />
        </div>
        <InterventionPanel baseUrl={baseUrl} runId={selectedRunId} selectedItem={selectedItem} workflowModel={workflowModel} onCommand={runCommand} />
      </div>
      {error ? <div style={{ position: "fixed", right: 16, bottom: 16, color: "#dc2626", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>{error}</div> : null}
    </section>
  );
}

function southstarServerUrl(): string {
  return process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL
    ?? process.env.SOUTHSTAR_SERVER_URL
    ?? "http://127.0.0.1:3001";
}
