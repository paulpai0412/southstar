"use client";

import { useEffect, useMemo, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { Panel } from "../ui/Panel";
import { MetricCard } from "../ui/MetricCard";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

export function RuntimeMonitorPage() {
  const api = useMemo(() => createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" }), []);
  const [model, setModel] = useState<any | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get("runId"); setRunId(id); if (id) void api.getUiRuntimeMonitor(id).then(setModel); }, [api]);
  return (
    <SouthstarShell title="Runtime Monitor" runId={runId} status={model?.run?.status}>
      <div className="ss-page-grid">
        <Panel title="KPI Row"><div className="ss-metrics">{Object.values(model?.kpis ?? {}).map((kpi: any) => <MetricCard key={kpi.label} label={kpi.label} value={kpi.value} />)}</div></Panel>
        <Panel title="Event Stream">{model?.events?.map((event: any) => <p key={event.sequence}>{event.sequence}. {event.eventType}</p>)}</Panel>
        <Panel title="Executor Jobs">{model?.executorJobs?.map((job: any) => <p key={job.jobId}>{job.jobId}: {job.status}</p>)}</Panel>
        <Panel title="Artifact Progress">{model?.artifactProgress?.map((artifact: any) => <p key={artifact.id}>{artifact.title ?? artifact.id}: {artifact.status}</p>)}</Panel>
        <Panel title="Integration Health">{model?.integrationHealth?.map((row: any) => <p key={row.service}>{row.service}: {row.status}</p>)}</Panel>
        <Panel title="Stop Gate / Evaluator Pipeline"><p>{model?.stopGate?.status ?? "pending"}</p></Panel>
        <Panel title="Run Controls"><button>Pause</button><button>Resume</button><button>Cancel Run</button><button>Export Logs</button></Panel>
      </div>
    </SouthstarShell>
  );
}
