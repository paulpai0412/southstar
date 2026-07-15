export const PI_RUNTIME_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

const PI_RUNTIME_TOOL_NAME_SET: ReadonlySet<string> = new Set(PI_RUNTIME_TOOL_NAMES);

export function unsupportedPiRuntimeToolNames(toolNames: readonly string[]): string[] {
  return [...new Set(toolNames.filter((toolName) => !PI_RUNTIME_TOOL_NAME_SET.has(toolName)))].sort();
}
