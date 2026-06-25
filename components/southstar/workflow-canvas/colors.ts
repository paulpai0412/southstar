import type { WorkflowStatusToken } from "./types";

export const workflowStatusColors: Record<WorkflowStatusToken, { border: string; fill: string; edge: string; text: string }> = {
  pending: { border: "#b45309", fill: "#fff7ed", edge: "#b45309", text: "#9a3412" },
  queued: { border: "#475569", fill: "#f8fafc", edge: "#64748b", text: "#334155" },
  scheduling: { border: "#0369a1", fill: "#f0f9ff", edge: "#0284c7", text: "#075985" },
  running: { border: "#2563eb", fill: "#eff6ff", edge: "#2563eb", text: "#1d4ed8" },
  completed: { border: "#15803d", fill: "#f0fdf4", edge: "#16a34a", text: "#166534" },
  passed: { border: "#15803d", fill: "#f0fdf4", edge: "#16a34a", text: "#166534" },
  paused: { border: "#7c3aed", fill: "#f5f3ff", edge: "#8b5cf6", text: "#6d28d9" },
  blocked: { border: "#b45309", fill: "#fffbeb", edge: "#d97706", text: "#92400e" },
  exception: { border: "#be123c", fill: "#fff1f2", edge: "#e11d48", text: "#9f1239" },
  failed: { border: "#b91c1c", fill: "#fef2f2", edge: "#dc2626", text: "#991b1b" },
  cancelled: { border: "#475569", fill: "#f8fafc", edge: "#64748b", text: "#334155" },
};

export function normalizeWorkflowStatus(status: string | null | undefined): WorkflowStatusToken {
  const normalized = (status ?? "pending").toLowerCase();
  if (normalized in workflowStatusColors) return normalized as WorkflowStatusToken;
  return "pending";
}

export function statusColorFor(status: string | null | undefined) {
  return workflowStatusColors[normalizeWorkflowStatus(status)];
}
