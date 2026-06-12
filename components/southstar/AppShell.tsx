export function SouthstarOperationsApp() {
  return (
    <main className="ss-app-shell">
      <aside className="ss-rail">
        <div className="ss-brand">Southstar v2</div>
        <nav>
          <a>Planner Chat</a>
          <a>Workflow Canvas</a>
          <a>Runtime Monitor</a>
          <a>Task Detail</a>
        </nav>
      </aside>
      <section className="ss-workspace">
        <header className="ss-topbar">
          <strong>Pi Planner Orchestration</strong>
          <div>View: Simple | Full</div>
        </header>
        <div className="ss-placeholder">Operations console shell</div>
      </section>
    </main>
  );
}
