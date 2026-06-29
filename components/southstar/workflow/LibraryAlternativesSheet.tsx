import React from "react";

export function LibraryAlternativesSheet(props: { model: any | null; onClose: () => void }) {
  if (!props.model) return null;
  const selectedRefs = asRecord(props.model.selectedRefs);
  const alternatives = asRecord(props.model.alternatives);
  const roles = recordArray(alternatives?.roles ?? props.model.matchedTemplates);
  const profiles = recordArray(alternatives?.agentProfiles ?? props.model.agentProfiles);
  const skills = recordArray(alternatives?.skills ?? props.model.skills);
  const mcpServers = recordArray(alternatives?.mcpServers ?? props.model.mcpGrants);
  const tools = recordArray(alternatives?.tools ?? props.model.tools);
  const selectionReasons = stringArray(props.model.selectionReasons);

  return (
    <aside className="ss-library-sheet" role="dialog" aria-modal>
      <header><h2>Library alternatives</h2><button type="button" onClick={props.onClose}>Close</button></header>
      <section>
        <h3>Selected refs</h3>
        <p>{stringValue(selectedRefs?.roleRef) ?? "role:auto"} · {stringValue(selectedRefs?.agentProfileRef) ?? "profile:auto"}</p>
        <p>skills {csv(selectedRefs?.skillRefs)} · mcp {csv(selectedRefs?.mcpGrantRefs)} · tools {csv(selectedRefs?.toolGrantRefs)}</p>
      </section>
      <section>
        <h3>Selection reasons</h3>
        {selectionReasons.length === 0 ? <p>No selection reasons available.</p> : <ul>{selectionReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      </section>
      <section><h3>Role alternatives</h3>{renderRows(roles)}</section>
      <section><h3>Alternative profiles</h3>{renderRows(profiles)}</section>
      <section><h3>Skill requirements</h3>{renderRows(skills)}</section>
      <section><h3>MCP grants</h3>{renderRows(mcpServers)}</section>
      <section><h3>Tool grants</h3>{renderRows(tools)}</section>
      <section><h3>Rejected alternatives</h3>{renderRows(recordArray(props.model.rejectedAlternatives))}</section>
    </aside>
  );
}

function renderRows(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return <p>None available.</p>;
  return (
    <ul>
      {rows.map((item) => (
        <li key={rowId(item)}>
          <strong>{rowId(item)}</strong>
          {stringValue(item.name) ? <span> · {stringValue(item.name)}</span> : null}
          {stringValue(item.responsibility) ? <span> · {stringValue(item.responsibility)}</span> : null}
          {stringValue(item.reason) ? <span> · {stringValue(item.reason)}</span> : null}
          {stringArray(item.profileRefs).length > 0 ? <span> · profiles {csv(item.profileRefs)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rowId(row: Record<string, unknown>): string {
  return stringValue(row.id ?? row.ref) ?? "unknown";
}

function csv(value: unknown): string {
  const items = stringArray(value);
  return items.length > 0 ? items.join(", ") : "none";
}
