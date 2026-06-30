"use client";

export function WorkflowNodeProfileRecommendations({
  candidates,
  selectedDefinition,
  editable,
}: {
  candidates: unknown;
  selectedDefinition: unknown;
  editable: boolean;
}) {
  const candidateRecord = recordValue(candidates);
  const alternatives = recordValue(candidateRecord?.alternatives);
  const selected = recordValue(selectedDefinition);
  const profileCount = recordArray(alternatives?.agentProfiles).length;
  const skillCount = recordArray(alternatives?.skills).length;
  const mcpCount = recordArray(alternatives?.mcpServers).length;
  const selectionReasons = stringArray(
    candidateRecord?.selectionReasons
    ?? candidateRecord?.candidateReasons
    ?? alternatives?.selectionReasons
    ?? alternatives?.candidateReasons
    ?? selected?.selectionReasons
    ?? selected?.candidateReasons,
  );
  const guidance = [
    editable ? "Changes remain in the planner draft until you save and revalidate." : "Runtime nodes are inspect-only; revise the Workflow draft to change future runs.",
    profileCount > 0 ? `${profileCount} alternative profiles are available for comparison.` : "No alternative profiles returned for this task.",
    skillCount + mcpCount > 0 ? `${skillCount} skill candidates and ${mcpCount} MCP grant candidates are available.` : "No capability candidates returned yet.",
  ];

  return (
    <section data-testid="workflow-node-profile-recommendations" style={cardStyle}>
      <h2 style={titleStyle}>Recommendations</h2>
      <ul style={listStyle}>
        {guidance.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <div style={labelStyle}>Candidate reasons</div>
      {selectionReasons.length === 0 ? (
        <p style={mutedStyle}>No selectionReasons or candidateReasons in the read model yet.</p>
      ) : (
        <ul style={listStyle}>
          {selectionReasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
    </section>
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(recordValue(item))) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const cardStyle = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg)",
  padding: 10,
} as const;

const titleStyle = {
  margin: "0 0 8px",
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 650,
} as const;

const listStyle = {
  margin: 0,
  paddingLeft: 16,
  color: "var(--text-muted)",
  fontSize: 12,
  display: "grid",
  gap: 5,
} as const;

const labelStyle = {
  marginTop: 10,
  marginBottom: 5,
  color: "var(--text-dim)",
  fontSize: 11,
  fontWeight: 650,
} as const;

const mutedStyle = {
  margin: 0,
  color: "var(--text-dim)",
  fontSize: 12,
} as const;
