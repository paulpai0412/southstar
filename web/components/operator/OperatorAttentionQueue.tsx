"use client";

import type { OperatorIncident } from "@/lib/operator/types";

export function OperatorAttentionQueue({
  incidents,
  selectedIncidentId,
  onSelectIncident,
}: {
  incidents: OperatorIncident[];
  selectedIncidentId: string | null;
  onSelectIncident: (incident: OperatorIncident) => void;
}) {
  if (incidents.length === 0) {
    return <p className="operator-muted">No incidents need attention.</p>;
  }

  return (
    <div className="operator-attention-queue">
      {incidents.map((incident) => (
        <button
          key={incident.id}
          type="button"
          className="operator-list-row operator-incident-row"
          aria-pressed={selectedIncidentId === incident.id}
          onClick={() => onSelectIncident(incident)}
        >
          <strong>{incident.severity}</strong>
          <span>{incident.title}</span>
          <em>{incident.cause}</em>
          <small>{incident.sourceAttentionIds.length} events - {incident.ageLabel}</small>
          <small>{incident.nextAction}</small>
        </button>
      ))}
    </div>
  );
}
