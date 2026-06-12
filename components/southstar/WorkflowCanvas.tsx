const nodes = [
  ["planner", "Completed"],
  ["implementer", "Running"],
  ["root-validator", "Pending"],
  ["summary", "Pending"],
  ["follow-up-verification", "Pending"],
] as const;

export function WorkflowCanvas() {
  return (
    <section className="ss-panel ss-canvas" data-panel="workflow-canvas" id="workflow-canvas">
      <header>
        <h2>Workflow Canvas</h2>
        <span>Auto-layout</span>
      </header>
      <div className="ss-dag">
        {nodes.map(([id, status]) => (
          <div className={`ss-node ss-node-${status.toLowerCase()}`} key={id}>
            <strong>{id}</strong>
            <span>{status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
