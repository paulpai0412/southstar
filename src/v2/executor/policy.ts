export type ExecutorPolicyAction =
  | "observe"
  | "fetch-logs"
  | "cancel-executor"
  | "retry-attempt"
  | "alert-operator";

export function actionsForExecutorClassification(classification: string): ExecutorPolicyAction[] {
  if (classification === "orphaned") return ["cancel-executor", "alert-operator"];
  if (classification === "callback-missing") return ["fetch-logs", "retry-attempt"];
  if (classification === "heartbeat-lost") return ["fetch-logs", "cancel-executor", "retry-attempt"];
  if (classification === "queue-timeout") return ["alert-operator"];
  if (classification === "hard-timeout") return ["cancel-executor", "retry-attempt"];
  if (classification === "lost") return ["retry-attempt", "alert-operator"];
  if (classification === "failed") return ["fetch-logs", "retry-attempt"];
  return ["observe"];
}
