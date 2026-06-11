import path from "node:path";

export function normalizeRuntimePath(projectRoot: string, runtimePath: string): string {
  const adapter = isWindowsPath(projectRoot) || isWindowsPath(runtimePath) ? path.win32 : path.posix;
  if (isAbsoluteForAdapter(runtimePath, adapter)) {
    return adapter.normalize(runtimePath);
  }
  return adapter.normalize(adapter.join(projectRoot, runtimePath));
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");
}

function isAbsoluteForAdapter(value: string, adapter: typeof path.posix | typeof path.win32): boolean {
  return adapter.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}
