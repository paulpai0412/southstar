"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";
import { SouthstarTopBar } from "./SouthstarTopBar";
import { SouthstarTabRail, type SouthstarProductTab } from "./SouthstarTabRail";
import { SouthstarChatTab } from "../chat/SouthstarChatTab";
import { WorkflowTab } from "../workflow/WorkflowTab";
import { SouthstarOperationsTab } from "../operations/SouthstarOperationsTab";
import { OperatorDock } from "../operator/OperatorDock";
import { OperatorSheet } from "../operator/OperatorSheet";
import { useSouthstarPageModel } from "../hooks/useSouthstarPageModel";

export function SouthstarProductShell(props: { initialTab: SouthstarProductTab }) {
  const router = useRouter();
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: southstarServerUrl() }), []);
  const [activeTab, setActiveTab] = useState<SouthstarProductTab>(props.initialTab);
  const [operatorOpen, setOperatorOpen] = useState(false);
  const operator = useSouthstarPageModel(() => api.getUiOperatorAttention(), [api]);

  useEffect(() => { setActiveTab(props.initialTab); }, [props.initialTab]);

  function onTabChange(tab: SouthstarProductTab) {
    setActiveTab(tab);
    router.push(pathForTab(tab));
  }

  return (
    <main className="ss-product-shell">
      <SouthstarTabRail activeTab={activeTab} onChange={onTabChange} />
      <section className="ss-product-main">
        <SouthstarTopBar activeTab={activeTab} />
        <div className="ss-product-surface">
          {activeTab === "chat" ? <SouthstarChatTab /> : null}
          {activeTab === "workflow" ? <WorkflowTab api={api} onOpenOperator={() => setOperatorOpen(true)} /> : null}
          {activeTab === "operations" ? <SouthstarOperationsTab api={api} /> : null}
        </div>
      </section>
      <OperatorDock count={operator.model?.attentionCount ?? 0} onOpen={() => setOperatorOpen((open) => !open)} />
      {operatorOpen ? <OperatorSheet model={operator.model} onClose={() => setOperatorOpen(false)} /> : null}
    </main>
  );
}

function pathForTab(tab: SouthstarProductTab): string {
  if (tab === "chat") return "/chat";
  if (tab === "operations") return "/operations";
  return "/workflow";
}

function southstarServerUrl(): string {
  return process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL
    ?? process.env.SOUTHSTAR_SERVER_URL
    ?? "http://127.0.0.1:3001";
}
