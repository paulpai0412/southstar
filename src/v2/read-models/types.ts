export type ReadModelKind =
  | "run-inspection"
  | "runtime-monitor"
  | "workflow-canvas"
  | "executor-ops"
  | "task-detail"
  | "sessions-memory"
  | "vault-mcp"
  | "evolution-control-center";

export type ReadModelInput = {
  kind: ReadModelKind;
  runId: string;
  taskId?: string;
};
