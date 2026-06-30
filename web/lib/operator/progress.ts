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
  return run.cwd === cwd || run.projectRoot === cwd || Boolean(run.cwd?.startsWith(`${cwd}/`));
}

export function attentionMatchesRuns(item: OperatorAttentionItem, runs: OperatorRun[]): boolean {
  if (!item.runId) return true;
  return runs.some((run) => run.runId === item.runId);
}
