export const recoveryStrategies = [
  "retry-same-agent",
  "fork-from-checkpoint",
  "reset-from-checkpoint",
  "host-native-rewind",
  "rollback-workspace",
  "request-workflow-revision",
  "ask-human",
] as const;

export type RecoveryStrategy = typeof recoveryStrategies[number];

export function isRecoveryStrategy(value: unknown): value is RecoveryStrategy {
  return typeof value === "string" && (recoveryStrategies as readonly string[]).includes(value);
}
