"use client";

import type { OperatorIncident, OperatorOverview } from "@/lib/operator/types";

export function OperatorHealthStrip({
  overview,
  incidents,
  error,
}: {
  overview: OperatorOverview;
  incidents: OperatorIncident[];
  error: string | null;
}) {
  const blocked = incidents.filter((incident) => incident.status === "needs_action").length;
  const atRisk = incidents.filter((incident) => incident.status === "observing").length;

  return (
    <section className="operator-health-strip" aria-label="Operator runtime health">
      <div><strong>{overview.runtimeHealth.activeRunCount}</strong><span>active runs</span></div>
      <div><strong>{blocked}</strong><span>blocked incidents</span></div>
      <div><strong>{atRisk}</strong><span>at risk</span></div>
      <div><strong>{overview.runtimeHealth.attentionCount}</strong><span>attention events</span></div>
      {error ? <p className="operator-muted operator-danger">Operator overview error: {error}</p> : null}
    </section>
  );
}
