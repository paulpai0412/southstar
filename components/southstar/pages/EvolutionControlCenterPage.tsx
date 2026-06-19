"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { CodeBlock } from "../ui/CodeBlock";
import { EvolutionGraphViewer } from "../evolution/EvolutionGraphViewer";
import { KnowledgeWikiPanel } from "../evolution/KnowledgeWikiPanel";

type EvolutionItem = { id?: string; status?: string; payload?: Record<string, unknown> } & Record<string, unknown>;
type EvolutionOverview = Record<string, unknown> & {
  graph?: any;
  selectedWikiNodeId?: string;
  cards?: EvolutionItem[];
  deltas?: EvolutionItem[];
  experiments?: EvolutionItem[];
  assets?: EvolutionItem[];
  regression?: EvolutionItem[];
};

export function EvolutionControlCenterPage() {
  const [model, setModel] = useState<EvolutionOverview | null>(null);
  const [selectedWikiNodeId, setSelectedWikiNodeId] = useState<string | undefined>(undefined);
  const [commandResult, setCommandResult] = useState<unknown>(null);
  const baseUrl = useMemo(() => process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001", []);

  const refresh = () => {
    fetch(`${baseUrl}/api/v2/read-models/evolution-control-center/_global`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("overview unavailable")))
      .then((envelope) => setModel(envelope.result.data))
      .catch(() => setModel({}));
  };

  useEffect(() => {
    refresh();
  }, [baseUrl]);

  const runCommand = async (path: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "operator-ui", reason: "Evolution Control Center command", ...body }),
    });
    const payload = await response.json();
    setCommandResult(payload);
    refresh();
  };

  const selectedCardId = firstId(model?.cards);
  const selectedDeltaId = firstId(model?.deltas);
  const selectedExperimentId = firstId(model?.experiments);
  const selectedAssetId = firstId(model?.assets);
  const selectedAlertId = firstId(model?.regression);
  const wikiNodeId = selectedWikiNodeId ?? model?.selectedWikiNodeId;

  return (
    <SouthstarShell title="Evolution Control Center">
      <div className="ss-page-grid ss-evolution-page">
        <Panel title="Evolution Health Overview">
          <p className="ss-muted">Observe → distill → improve → validate → promote → monitor → rollback.</p>
          <CodeBlock value={model?.health ?? { status: "waiting-for-runtime" }} />
        </Panel>
        <Panel title="Evolution Command Center">
          <div className="ss-command-row" role="toolbar" aria-label="Evolution commands">
            <button type="button" disabled={!selectedCardId} onClick={() => selectedCardId && runCommand(`/api/v2/evolution/cards/${encodeURIComponent(selectedCardId)}/approve`)}>Approve card</button>
            <button type="button" disabled={!selectedCardId} onClick={() => selectedCardId && runCommand(`/api/v2/evolution/cards/${encodeURIComponent(selectedCardId)}/reject`)}>Reject card</button>
            <button type="button" disabled={!selectedDeltaId} onClick={() => selectedDeltaId && runCommand(`/api/v2/evolution/deltas/${encodeURIComponent(selectedDeltaId)}/approve`)}>Approve delta</button>
            <button type="button" disabled={!selectedDeltaId} onClick={() => selectedDeltaId && runCommand(`/api/v2/evolution/deltas/${encodeURIComponent(selectedDeltaId)}/reject`)}>Reject delta</button>
            <button type="button" disabled={!selectedExperimentId} onClick={() => selectedExperimentId && runCommand(`/api/v2/evolution/experiments/${encodeURIComponent(selectedExperimentId)}/start`)}>Run sandbox</button>
            <button type="button" disabled={!selectedAssetId} onClick={() => selectedAssetId && runCommand(`/api/v2/evolution/assets/${encodeURIComponent(selectedAssetId)}/rollback`)}>Rollback asset</button>
            <button type="button" disabled={!selectedAlertId} onClick={() => selectedAlertId && runCommand(`/api/v2/evolution/regression-alerts/${encodeURIComponent(selectedAlertId)}/acknowledge`)}>Acknowledge alert</button>
            <button type="button" disabled={!selectedAlertId} onClick={() => selectedAlertId && runCommand(`/api/v2/evolution/regression-alerts/${encodeURIComponent(selectedAlertId)}/dismiss`)}>Dismiss alert</button>
          </div>
          <CodeBlock value={commandResult ?? { status: "waiting-for-command" }} />
        </Panel>
        <Panel title="Learning Signal Feed"><CodeBlock value={model?.signals ?? []} /></Panel>
        <Panel title="Knowledge Card Library"><CodeBlock value={model?.cards ?? []} /></Panel>
        <Panel title="Delta Proposal Queue"><CodeBlock value={model?.deltas ?? []} /></Panel>
        <Panel title="Sandbox Experiments"><CodeBlock value={model?.experiments ?? []} /></Panel>
        <Panel title="Asset Version Registry"><CodeBlock value={model?.assets ?? []} /></Panel>
        <Panel title="Canary / Regression Monitor"><CodeBlock value={model?.regression ?? []} /></Panel>
        <Panel title="Graph Viewer"><EvolutionGraphViewer graph={model?.graph ?? null} onSelectNode={setSelectedWikiNodeId} /></Panel>
      </div>
      <section aria-label="Knowledge Wiki">
        <KnowledgeWikiPanel nodeId={wikiNodeId} />
      </section>
    </SouthstarShell>
  );
}

function firstId(items: EvolutionItem[] | undefined): string | undefined {
  return items?.find((item) => typeof item.id === "string")?.id;
}
