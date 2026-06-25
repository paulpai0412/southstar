"use client";

export function AttentionQueue(props: {
  items: any[];
  selectedItemId?: string | null;
  onSelectItem: (item: any) => void;
}) {
  return (
    <aside style={{ borderRight: "1px solid var(--border)", background: "var(--bg-panel)", overflow: "auto", padding: 10 }}>
      <h2 style={{ margin: "0 0 10px", fontSize: 12, color: "var(--text-muted)", textTransform: "uppercase" }}>Attention Queue</h2>
      {props.items.length === 0 ? <p style={{ color: "var(--text-dim)", fontSize: 12 }}>No operator attention needed.</p> : null}
      <div style={{ display: "grid", gap: 8 }}>
        {props.items.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={props.selectedItemId === item.id}
            onClick={() => props.onSelectItem(item)}
            style={{
              textAlign: "left",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: props.selectedItemId === item.id ? "var(--bg-selected)" : "var(--bg)",
              color: "var(--text)",
              padding: 8,
              fontSize: 12,
            }}
          >
            <strong>{item.title}</strong>
            <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 11 }}>{item.severity} · {item.status}</div>
            <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 11 }}>{item.reason}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}
