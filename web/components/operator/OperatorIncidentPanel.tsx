"use client";

import type { OperatorIncident } from "@/lib/operator/types";

export function OperatorIncidentPanel({ incident }: { incident: OperatorIncident | null }) {
  if (!incident) {
    return (
      <section className="operator-panel operator-incident-panel">
        <header className="operator-panel-header"><h2>Incident Summary</h2></header>
        <p className="operator-muted">Select an incident to see cause, impact, evidence, and next action.</p>
      </section>
    );
  }

  return (
    <section className="operator-panel operator-incident-panel">
      <header className="operator-panel-header">
        <h2>{incident.title}</h2>
        <strong className="operator-run-severity">{incident.severity}</strong>
      </header>
      <dl className="operator-summary-grid">
        <dt>Cause</dt><dd>{incident.cause}</dd>
        <dt>Impact</dt><dd>{incident.impact}</dd>
        <dt>Recommended next action</dt><dd>{incident.nextAction}</dd>
        <dt>Age</dt><dd>{incident.ageLabel}</dd>
      </dl>
    </section>
  );
}
