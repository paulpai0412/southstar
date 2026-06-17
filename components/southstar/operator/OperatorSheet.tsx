export function OperatorSheet(props: { model: any; onClose: () => void }) {
  return (
    <aside className="ss-operator-sheet">
      <header><h2>Needs attention</h2><button type="button" onClick={props.onClose}>Close</button></header>
      {props.model?.items?.length ? props.model.items.map((item: any) => (
        <article key={item.id}><strong>{item.title}</strong><p>{item.suggestedActions?.join(" · ")}</p></article>
      )) : <p>No operator attention needed.</p>}
    </aside>
  );
}
