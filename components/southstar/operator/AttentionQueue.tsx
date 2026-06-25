export type OperatorAttentionItem = {
  id: string;
  severity: string;
  title: string;
  reason?: string;
  runId?: string;
  taskId?: string;
  suggestedCommandId?: string;
};

export function AttentionQueue(props: {
  items: OperatorAttentionItem[];
  selectedAttentionId?: string | null;
  onSelectAttention?: (item: OperatorAttentionItem) => void;
}) {
  return (
    <section className="ss-panel">
      <h2>Attention Queue</h2>
      {props.items.length > 0 ? (
        <ul className="ss-timeline">
          {props.items.map((item) => (
            <li key={item.id}>
              <strong className={severityClass(item.severity)}>{item.severity}</strong>
              <button
                type="button"
                onClick={() => props.onSelectAttention?.(item)}
                aria-pressed={props.selectedAttentionId === item.id}
              >
                {item.title}
                {item.reason ? ` · ${item.reason}` : ""}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ss-empty">No attention items.</p>
      )}
    </section>
  );
}

function severityClass(severity: string): string {
  if (severity === "blocked" || severity === "critical") return "ss-chip-risk";
  if (severity === "active" || severity === "running") return "ss-chip-active";
  if (severity === "idle") return "ss-chip-idle";
  return "ss-chip-info";
}
