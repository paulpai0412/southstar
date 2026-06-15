export function StatusBadge(props: { status: string }) {
  return <span className={`ss-status-badge ss-status-${props.status.toLowerCase()}`}>{props.status}</span>;
}
