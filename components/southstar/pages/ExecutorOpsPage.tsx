"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { CodeBlock } from "../ui/CodeBlock";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

export function ExecutorOpsPage() {
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);
  const [model, setModel] = useState<any | null>(null);
  useEffect(() => { const jobId = new URLSearchParams(window.location.search).get("jobId") ?? undefined; void api.getUiExecutor(jobId).then(setModel); }, [api]);
  return <SouthstarShell title="Executor Ops"><div className="ss-page-grid"><Panel title="Health Cards"><CodeBlock value={model?.integrationHealth ?? []} /></Panel><Panel title="Jobs Queue"><CodeBlock value={model?.jobs ?? []} /></Panel><Panel title="Selected Job Detail"><CodeBlock value={model?.selectedJob ?? {}} /></Panel><Panel title="Container Output"><p>Logs loaded through Tork client command API.</p></Panel><Panel title="Callback Payload"><p>Callback evidence remains Southstar runtime resource.</p></Panel><Panel title="Worker Pool"><CodeBlock value={model?.workerPool ?? []} /></Panel></div></SouthstarShell>;
}
