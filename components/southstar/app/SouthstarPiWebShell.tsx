"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";
import { WorkspaceTabs, type SouthstarWorkspaceViewId } from "../workspace/WorkspaceTabs";
import { SouthstarChatFileViewerPanel } from "../chat/SouthstarChatFileViewerPanel";
import { SouthstarChatSessionSidebar } from "../chat/SouthstarChatSessionSidebar";
import { SouthstarChatTab } from "../chat/SouthstarChatTab";
import { WorkflowWorkbench } from "../workflow/WorkflowWorkbench";
import { OperatorBoard } from "../operator/OperatorBoard";

export function SouthstarPiWebShell(props: { initialView?: SouthstarWorkspaceViewId }) {
  const router = useRouter();
  const baseUrl = useMemo(() => southstarServerUrl(), []);
  const api = useMemo(() => createSouthstarApiClient({ baseUrl }), [baseUrl]);
  const [view, setView] = useState<SouthstarWorkspaceViewId>(props.initialView ?? "workflow");
  const [chatRunId, setChatRunId] = useState<string | null>(null);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);

  useEffect(() => {
    setView(props.initialView ?? "workflow");
  }, [props.initialView]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setChatRunId(query.get("runId"));
    setChatSessionId(query.get("sessionId"));
  }, []);

  function onSelect(nextView: SouthstarWorkspaceViewId) {
    if (nextView === view) return;
    setView(nextView);
    router.push(pathForView(nextView));
  }

  return (
    <main className="ss-pi-shell">
      <aside className="ss-pi-sidebar">
        <SouthstarChatSessionSidebar
          api={api}
          selectedRunId={chatRunId}
          selectedSessionId={chatSessionId}
          onSelectRunId={setChatRunId}
          onSelectSessionId={setChatSessionId}
        />
      </aside>
      <section className="ss-pi-main">
        <header className="ss-pi-topbar">
          <WorkspaceTabs active={view} onSelect={onSelect} />
        </header>
        <section className="ss-pi-content">
          {view === "chat" ? <SouthstarChatTab api={api} serverBaseUrl={baseUrl} selectedRunId={chatRunId} selectedSessionId={chatSessionId} /> : null}
          {view === "workflow" ? <WorkflowWorkbench api={api} activeCwd={null} onOpenOperator={(runId) => {
            if (runId) setChatRunId(runId);
            onSelect("operator");
          }} /> : null}
          {view === "operator" ? <OperatorBoard api={api} activeCwd={null} /> : null}
        </section>
      </section>
      <aside className="ss-pi-file-viewer">
        <SouthstarChatFileViewerPanel api={api} selectedRunId={chatRunId} selectedSessionId={chatSessionId} />
      </aside>
    </main>
  );
}

export const SouthstarProductShell = SouthstarPiWebShell;

function pathForView(view: SouthstarWorkspaceViewId): string {
  if (view === "chat") return "/chat";
  if (view === "operator") return "/operations";
  return "/workflow";
}

function southstarServerUrl(): string {
  return process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL
    ?? process.env.SOUTHSTAR_SERVER_URL
    ?? "http://127.0.0.1:3001";
}
