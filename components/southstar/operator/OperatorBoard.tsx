"use client";

import type { SouthstarApiClient } from "@/lib/southstar/api-client";

export function OperatorBoard(props: { api: SouthstarApiClient; activeCwd: string | null }) {
  void props.api;
  return (
    <section className="ss-operator-board">
      <article className="ss-panel">
        <h2>Attention Queue</h2>
        <p>Operator attention items will appear here.</p>
      </article>
      <article className="ss-panel">
        <h2>Active Runs</h2>
        <p>Runtime monitor scaffold for {props.activeCwd ?? "all workspaces"}.</p>
      </article>
    </section>
  );
}
