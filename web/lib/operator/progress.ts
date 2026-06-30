import type { OperatorAttentionItem, OperatorRun } from "./types";

export const operatorStateBuckets = ["created", "scheduling", "running", "verifying", "blocked", "paused"] as const;
export type OperatorStateBucket = (typeof operatorStateBuckets)[number];

export function bucketForRunStatus(status: string): OperatorStateBucket {
  if (status === "created" || status === "ready" || status === "validated") return "created";
  if (status === "scheduling" || status === "queued") return "scheduling";
  if (status === "verifying" || status === "release_pending") return "verifying";
  if (status === "blocked" || status === "exception" || status === "failed" || status === "quarantined") return "blocked";
  if (status === "paused") return "paused";
  return "running";
}

export function runMatchesCwd(run: OperatorRun, cwd: string | null): boolean {
  if (!cwd) return true;
  const selected = normalizePath(cwd);
  return [run.cwd, run.projectRoot].some((candidate) => pathsOverlap(selected, normalizePath(candidate)));
}

export function attentionMatchesRuns(item: OperatorAttentionItem, runs: OperatorRun[]): boolean {
  if (!item.runId) return true;
  return runs.some((run) => run.runId === item.runId);
}

function normalizePath(path: string | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized || "/";
}

function pathsOverlap(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
