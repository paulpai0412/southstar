"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { CodeBlock } from "../ui/CodeBlock";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

export function SessionsMemoryPage() {
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);
  const [model, setModel] = useState<any | null>(null);
  useEffect(() => { const q = new URLSearchParams(window.location.search); void api.getUiSessionsMemory(q.get("runId") ?? undefined, q.get("sessionId") ?? undefined).then(setModel); }, [api]);
  return <SouthstarShell title="Sessions / Memory"><div className="ss-page-grid"><Panel title="Session Graph"><CodeBlock value={model?.lineage ?? []} /></Panel><Panel title="Checkpoint Timeline"><CodeBlock value={model?.checkpoints ?? []} /></Panel><Panel title="Memory Console"><CodeBlock value={model?.memoryRows ?? []} /></Panel><Panel title="Memory Detail Actions"><button>Approve</button><button>Reject</button><button>Do Not Inject</button></Panel><Panel title="Token Efficiency"><CodeBlock value={model?.tokenEfficiency ?? {}} /></Panel><Panel title="Memory Provider"><CodeBlock value={model?.providerBinding ?? {}} /></Panel></div></SouthstarShell>;
}
