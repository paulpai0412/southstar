export type ReadModelKind =
  | "run-inspection"
  | "runtime-monitor"
  | "workflow-canvas"
  | "executor-ops"
  | "task-detail"
  | "sessions-memory"
  | "vault-mcp";

export type ReadModelInput = {
  kind: ReadModelKind;
  runId: string;
  taskId?: string;
};
