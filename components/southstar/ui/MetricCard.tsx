export function MetricCard(props: { label: string; value: string | number; note?: string }) {
  return <div className="ss-metric-card"><span>{props.label}</span><strong>{props.value}</strong>{props.note ? <small>{props.note}</small> : null}</div>;
}
