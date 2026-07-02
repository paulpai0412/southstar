import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function assertWorkspaceMountAllowed(hostMountPath: string): void {
  if (!isSouthstarProjectPath(hostMountPath)) return;
  throw new Error(`refusing to mount Southstar project as workspace repo: ${hostMountPath}`);
}

export function isSouthstarProjectPath(hostMountPath: string): boolean {
  if (!hostMountPath.trim() || !isAbsolute(hostMountPath)) return false;
  const candidate = normalizePath(hostMountPath);
  return protectedSouthstarRoots().some((root) => isSameOrChild(root, candidate));
}

export function protectedSouthstarRoots(): string[] {
  return uniquePaths([
    MODULE_PROJECT_ROOT,
    process.env.SOUTHSTAR_PROJECT_ROOT,
  ]);
}

function normalizePath(value: string): string {
  return resolve(value);
}

function uniquePaths(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter(isPresentString).map(normalizePath)));
}

function isPresentString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSameOrChild(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
