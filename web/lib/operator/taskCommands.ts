import type { OperatorCommand } from "./types";

export function mergeOperatorTaskCommands(attentionCommands: OperatorCommand[], taskActions: OperatorCommand[]): OperatorCommand[] {
  const merged = new Map<string, OperatorCommand>();
  for (const command of taskActions) merged.set(command.id, command);
  for (const command of attentionCommands) merged.set(command.id, command);
  return [...merged.values()];
}

