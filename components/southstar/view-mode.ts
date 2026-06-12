export type SouthstarViewMode = "simple" | "full";

export type SouthstarPanelId =
  | "planner-chat"
  | "workflow-canvas"
  | "runtime-monitor"
  | "task-detail"
  | "agent-definitions"
  | "sessions-memory"
  | "vault-mcp"
  | "executor-ops"
  | "approval-policy";

const simplePanels: SouthstarPanelId[] = [
  "planner-chat",
  "workflow-canvas",
  "runtime-monitor",
  "task-detail",
];

const fullPanels: SouthstarPanelId[] = [
  ...simplePanels,
  "agent-definitions",
  "sessions-memory",
  "vault-mcp",
  "executor-ops",
  "approval-policy",
];

export function visiblePanelsForMode(mode: SouthstarViewMode): SouthstarPanelId[] {
  return mode === "simple" ? [...simplePanels] : [...fullPanels];
}
