"use client";

import { useEffect, useState } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import { AgentLibraryPanel } from "./AgentLibraryPanel";
import { DefinitionInspector } from "./DefinitionInspector";

const DEFAULT_GOAL = "Design and run a software workflow with implementation and verification tasks.";

export function WorkflowWorkbench(props: {
  api: SouthstarApiClient;
  activeCwd: string | null;
  onOpenOperator: (runId?: string) => void;
}) {
  const [goalPrompt, setGoalPrompt] = useState(DEFAULT_GOAL);
  const [draftId, setDraftId] = useState<string | undefined>();
  const [runId, setRunId] = useState<string | undefined>();
  const [model, setModel] = useState<any | null>(null);
  const [library, setLibrary] = useState<any | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    props.api.getAgentLibrary({ domain: "software" }).then(setLibrary).catch((caught) => setError((caught as Error).message));
    props.api.getUiWorkflow({}).then(setModel).catch((caught) => setError((caught as Error).message));
  }, [props.api]);

  async function refresh(next: { draftId?: string; runId?: string; taskId?: string }) {
    const nextModel = await props.api.getUiWorkflow(next);
    setModel(nextModel);
    setSelectedNodeId(nextModel.canvasModel?.selectedNodeId ?? null);
  }

  async function generateWorkflow() {
    setPlanning(true);
    setError(null);
    try {
      const draft = await props.api.createDraft(goalPrompt);
      setDraftId(draft.draftId);
      setRunId(undefined);
      await refresh({ draftId: draft.draftId });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setPlanning(false);
    }
  }

  async function runWorkflow() {
    if (!draftId) return;
    setRunning(true);
    setError(null);
    try {
      const run = await props.api.runDraft(draftId);
      setRunId(run.runId);
      props.onOpenOperator(run.runId);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function selectNode(nodeId: string) {
    setSelectedNodeId(nodeId);
    await refresh({ draftId, runId, taskId: nodeId });
  }

  return (
    <section style={{ height: "100%", display: "grid", gridTemplateColumns: "300px minmax(0, 1fr) 380px", minWidth: 0 }}>
      <AgentLibraryPanel library={library} goalPrompt={goalPrompt} planning={planning} onGoalPromptChange={setGoalPrompt} onGenerate={generateWorkflow} />
      <div style={{ minWidth: 0, minHeight: 0 }}>
        <SouthstarWorkflowCanvas model={model?.canvasModel ?? null} selectedNodeId={selectedNodeId} onSelectNode={selectNode} />
      </div>
      <DefinitionInspector selectedDefinition={model?.selectedDefinition} onRunWorkflow={runWorkflow} runDisabled={!draftId} running={running} />
      {error ? <div style={{ position: "fixed", left: 280, bottom: 16, color: "#dc2626", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>{error}</div> : null}
    </section>
  );
}
