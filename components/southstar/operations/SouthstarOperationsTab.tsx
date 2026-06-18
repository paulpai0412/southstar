"use client";

import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { useSouthstarPageModel } from "../hooks/useSouthstarPageModel";

export function SouthstarOperationsTab(props: { api: SouthstarApiClient }) {
  const page = useSouthstarPageModel(() => props.api.getUiOperationsTab(), [props.api]);
  const model = page.model;

  return (
    <section className="ss-operations-tab">
      <header>
        <h1>Southstar Control Center</h1>
        <p>Monitor workflow runs, approvals, executor health, release lanes, and automation watch.</p>
      </header>
      <div className="ss-operations-grid">
        <article>
          <h2>workflow runs</h2>
          <ul>{model?.runs?.map((run: any) => <li key={run.runId}><strong>{run.status}</strong> {run.title}</li>) ?? []}</ul>
        </article>
        <article>
          <h2>Approvals</h2>
          <ul>{model?.approvals?.map((approval: any) => <li key={approval.id}>{approval.title} · {approval.status}</li>) ?? []}</ul>
        </article>
        <article>
          <h2>Executor health</h2>
          <ul>{model?.executorHealth?.map((health: any) => <li key={health.service}>{health.service} · {health.status}</li>) ?? []}</ul>
        </article>
        <article>
          <h2>Release lanes</h2>
          <ul>{model?.releaseLanes?.map((lane: any, index: number) => <li key={`${lane.runId ?? "lane"}-${index}`}>{lane.summary} · {lane.status}</li>) ?? []}</ul>
        </article>
      </div>
      {page.error ? <p className="ss-error">{page.error}</p> : null}
    </section>
  );
}
