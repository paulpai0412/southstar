export type ReadModelKind =
  | "run-inspection"
  | "run-summary"
  | "executions"
  | "exceptions"
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
