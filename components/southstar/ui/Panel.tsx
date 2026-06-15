export function Panel(props: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`ss-panel ${props.className ?? ""}`}>
      {props.title ? <h2>{props.title}</h2> : null}
      {props.children}
    </section>
  );
}
