import type { RunStatusView } from "./types";

const operationsPanels = [
  ["agent-definitions", "Agent Definitions"],
  ["sessions-memory", "Sessions/Memory"],
  ["vault-mcp", "Vault/MCP"],
  ["executor-ops", "Executor Ops"],
  ["approval-policy", "Approval Policy"],
] as const;

export function OperationsPanels(props: { status: RunStatusView | null }) {
  const { status } = props;
  return (
    <section className="ss-ops-panels">
      {operationsPanels.map(([id, title]) => (
        <article className="ss-panel ss-small-panel" data-panel={id} id={id} key={id}>
          <h2>{title}</h2>
          <p>{panelSummary(id, status)}</p>
        </article>
      ))}
    </section>
  );
}

function panelSummary(id: typeof operationsPanels[number][0], status: RunStatusView | null): string {
  if (!status) return "Waiting for run data";
  if (id === "sessions-memory") {
    return `${status.sessionsMemory.sessions.length} session records, ${status.sessionsMemory.memoryItems.length} memory records`;
  }
  if (id === "executor-ops") {
    return `${status.executor.bindings.length} executor bindings`;
  }
  if (id === "vault-mcp") {
    return `${status.vaultMcp.vaultLeases.length} vault leases, ${status.vaultMcp.mcpGrants.length} MCP grants`;
  }
  if (id === "agent-definitions") {
    return `${status.canvas.nodes.length} task agents in workflow`;
  }
  return `Run ${status.runtime.status}`;
}
