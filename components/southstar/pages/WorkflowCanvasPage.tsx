"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { GraphCanvas } from "../ui/GraphCanvas";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

export function WorkflowCanvasPage() {
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);
  const [model, setModel] = useState<any | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("runId");
    setRunId(id);
    if (id) void api.getUiWorkflowCanvas(id).then(setModel);
  }, [api]);
  return (
    <SouthstarShell title="Workflow Canvas" runId={runId} status={model?.status}>
      <div className="ss-page-grid">
        <Panel title="DAG Canvas"><GraphCanvas nodes={model?.nodes ?? []} /></Panel>
        <Panel title="Selected Node Actions">{model?.selectedNode?.actions?.map((action: any) => <button key={action.command}>{action.label}</button>)}</Panel>
        <Panel title="ContextPacket Trace">{model?.nodes?.map((node: any) => <p key={node.taskId}>{node.taskId}: {node.contextPacketId ?? "pending"}</p>)}</Panel>
        <Panel title="Root Session Decisions">{model?.rootSessionDecisions?.map((item: any, index: number) => <p key={index}>{item.eventType}: {item.summary}</p>)}</Panel>
        <Panel title="Workflow Revision Timeline">{model?.revisionTimeline?.map((item: any) => <p key={item.id}>{item.label ?? item.id}: {item.status}</p>)}</Panel>
      </div>
    </SouthstarShell>
  );
}
