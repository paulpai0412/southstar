export type NodeTone = {
  border: string;
  background: string;
  text: string;
  badge: string;
};

const tones: Record<string, NodeTone> = {
  pending: { border: "var(--border)", background: "var(--bg)", text: "var(--text-muted)", badge: "var(--bg-hover)" },
  created: { border: "var(--border)", background: "var(--bg)", text: "var(--text-muted)", badge: "var(--bg-hover)" },
  queued: { border: "#d97706", background: "#d9770614", text: "#d97706", badge: "#d9770620" },
  scheduling: { border: "#d97706", background: "#d9770614", text: "#d97706", badge: "#d9770620" },
  running: { border: "var(--accent)", background: "#2563eb14", text: "var(--accent)", badge: "#2563eb20" },
  completed: { border: "#16a34a", background: "#16a34a14", text: "#16a34a", badge: "#16a34a20" },
  passed: { border: "#16a34a", background: "#16a34a14", text: "#16a34a", badge: "#16a34a20" },
  paused: { border: "#b45309", background: "#b4530914", text: "#b45309", badge: "#b4530920" },
  blocked: { border: "#dc2626", background: "#dc262614", text: "#dc2626", badge: "#dc262620" },
  exception: { border: "#dc2626", background: "#dc262614", text: "#dc2626", badge: "#dc262620" },
  failed: { border: "#dc2626", background: "#dc262614", text: "#dc2626", badge: "#dc262620" },
  cancelled: { border: "#991b1b", background: "#991b1b10", text: "#991b1b", badge: "#991b1b20" },
};

export function toneForStatus(status: string): NodeTone {
  return tones[status] ?? tones.pending;
}

export function edgeClassForStatus(status: string): string {
  if (status === "satisfied") return "ss-flow-edge ss-flow-edge-satisfied";
  if (status === "active") return "ss-flow-edge ss-flow-edge-active blue animated";
  if (status === "blocked") return "ss-flow-edge ss-flow-edge-blocked";
  if (status === "ready") return "ss-flow-edge ss-flow-edge-ready";
  return "ss-flow-edge ss-flow-edge-pending";
}
