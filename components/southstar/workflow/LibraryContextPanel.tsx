export function LibraryContextPanel(props: { model: any | null; onOpenAlternatives: () => void }) {
  const summary = props.model?.draft?.summary;
  return (
    <aside className="ss-library-context">
      <h2>Library Context</h2>
      <section><h3>Matched Workflow</h3><p>{summary?.templateRefs?.join(", ") || "Waiting for prompt"}</p></section>
      <section><h3>Agent Team</h3><p>{props.model?.draft?.dag?.nodes?.map((node: any) => node.id).join(" · ") || "Southstar will select agents"}</p></section>
      <section><h3>Skills / MCP</h3><p>Shown after planning from selected agent profiles.</p></section>
      <button type="button" onClick={props.onOpenAlternatives}>View alternatives</button>
    </aside>
  );
}
