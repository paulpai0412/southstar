"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { CodeBlock } from "../ui/CodeBlock";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

export function TaskDetailPage() {
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);
  const [model, setModel] = useState<any | null>(null);
  useEffect(() => { const q = new URLSearchParams(window.location.search); const runId = q.get("runId"); const taskId = q.get("taskId"); if (runId && taskId) void api.getUiTaskDetail(runId, taskId).then(setModel); }, [api]);
  return (
    <SouthstarShell title="Task Detail" runId={model?.envelope?.runId} status={model?.task?.status}>
      <div className="ss-page-grid">
        <Panel title="TaskEnvelopeV2"><CodeBlock value={model?.envelope ?? "Select a task."} /></Panel>
        <Panel title="ContextPacket"><CodeBlock value={model?.contextPacket ?? {}} /></Panel>
        <Panel title="Memory Injection Trace"><CodeBlock value={model?.memoryTrace ?? {}} /></Panel>
        <Panel title="Artifacts"><CodeBlock value={model?.artifacts ?? []} /></Panel>
        <Panel title="Evaluator Result"><CodeBlock value={model?.evaluator ?? {}} /></Panel>
        <Panel title="Events & Logs"><CodeBlock value={model?.logs ?? []} /></Panel>
        <Panel title="Actions">{model?.actions?.map((action: any) => <button key={action.command}>{action.label}</button>)}</Panel>
      </div>
    </SouthstarShell>
  );
}
