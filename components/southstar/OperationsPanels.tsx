const operationsPanels = [
  ["agent-definitions", "Agent Definitions"],
  ["sessions-memory", "Sessions/Memory"],
  ["vault-mcp", "Vault/MCP"],
  ["executor-ops", "Executor Ops"],
  ["approval-policy", "Approval Policy"],
] as const;

export function OperationsPanels() {
  return (
    <section className="ss-ops-panels">
      {operationsPanels.map(([id, title]) => (
        <article className="ss-panel ss-small-panel" data-panel={id} id={id} key={id}>
          <h2>{title}</h2>
          <p>Ready</p>
        </article>
      ))}
    </section>
  );
}
