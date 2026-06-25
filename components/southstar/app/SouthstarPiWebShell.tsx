"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";
import { WorkspaceTabs, type SouthstarWorkspaceViewId } from "../workspace/WorkspaceTabs";
import { renderWorkspaceView } from "../workspace/workspace-views";
import { WorkflowWorkbench } from "../workflow/WorkflowWorkbench";
import { OperatorBoard } from "../operator/OperatorBoard";

export function SouthstarPiWebShell(props: { initialView?: SouthstarWorkspaceViewId }) {
  const router = useRouter();
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: southstarServerUrl() }), []);
  const [view, setView] = useState<SouthstarWorkspaceViewId>(props.initialView ?? "workflow");
  const contractSymbols = { WorkflowWorkbench, OperatorBoard };
  void contractSymbols;

  useEffect(() => {
    setView(props.initialView ?? "workflow");
  }, [props.initialView]);

  function onSelect(nextView: SouthstarWorkspaceViewId) {
    setView(nextView);
    router.push(pathForView(nextView));
  }

  return (
    <main className="ss-pi-shell">
      <aside className="ss-pi-sidebar">
        <SessionSidebar />
      </aside>
      <section className="ss-pi-main">
        <header className="ss-pi-topbar">
          <WorkspaceTabs active={view} onSelect={onSelect} />
        </header>
        <section className="ss-pi-content">
          {view === "chat"
            ? <ChatWindow />
            : renderWorkspaceView(view, {
              activeCwd: null,
              api,
              onOpenOperator: () => onSelect("operator"),
            })}
        </section>
      </section>
      <aside className="ss-pi-file-viewer">
        <FileViewer />
      </aside>
    </main>
  );
}

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

function SessionSidebar() {
  return (
    <section className="ss-panel">
      <h2>SessionSidebar</h2>
      <p>Session/project selector placeholder.</p>
    </section>
  );
}

function ChatWindow() {
  return (
    <section className="ss-panel">
      <h2>ChatWindow</h2>
      <p>Chat transcript and prompt input placeholder.</p>
    </section>
  );
}

function FileViewer() {
  return (
    <section className="ss-panel">
      <h2>FileViewer</h2>
      <p>Opened file preview placeholder.</p>
    </section>
  );
}
