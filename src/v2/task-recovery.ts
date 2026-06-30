export type TaskRecoveryAction = "retry" | "fork-session" | "reset-session" | "rollback-session" | "request-revision";

export function isTaskRecoverableStatus(status: string): boolean {
  return status === "failed" || status === "blocked" || status === "running" || status === "queued";
}
