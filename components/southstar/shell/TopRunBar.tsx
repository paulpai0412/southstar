export function TopRunBar(props: { title: string; runId?: string | null; status?: string | null }) {
  return (
    <header className="ss-shell-topbar">
      <strong>{props.title}</strong>
      <span>{props.runId ? `Run ${props.runId}` : "No run selected"}</span>
      <span>{props.status ?? "idle"}</span>
    </header>
  );
}
