const guideSteps = ["Understand goal", "Select workflow", "Compose agent team", "Confirm profiles / tools", "Review DAG", "Run"];

export function GuidedPlannerChat(props: { value: string; planning: boolean; onChange: (value: string) => void; onPlan: () => void }) {
  return (
    <section className="ss-guided-chat">
      <header><h1>Guided workflow chat</h1><p>Southstar skill-guided planner helps confirm workflow, agents, profiles, and tools.</p></header>
      <ol>{guideSteps.map((step) => <li key={step}>{step}</li>)}</ol>
      <label htmlFor="workflow-goal">Workflow goal</label>
      <textarea id="workflow-goal" value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)} />
      <button type="button" onClick={props.onPlan} disabled={props.planning || props.value.trim().length === 0}>{props.planning ? "Planning…" : "Plan workflow"}</button>
    </section>
  );
}
