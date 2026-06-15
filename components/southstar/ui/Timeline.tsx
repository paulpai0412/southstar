export function Timeline(props: { items: Array<{ id: string; label: string; status?: string }> }) {
  return <ol className="ss-timeline">{props.items.map((item) => <li key={item.id}><strong>{item.label}</strong>{item.status ? <span>{item.status}</span> : null}</li>)}</ol>;
}
