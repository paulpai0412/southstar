import type { InspectionCause } from "./types.ts";

const priority: Record<InspectionCause["code"], number> = {
  run_missing: 10,
  task_failed: 20,
  executor_issue: 30,
  artifact_rejected: 40,
  artifact_needs_repair: 41,
  incomplete_evidence: 50,
  blocking_validator_failed: 60,
  stop_condition_failed: 70,
  stop_condition_missing: 71,
  design_library_lineage_unavailable: 80,
  task_stale_or_pending: 90,
};

export function explainRunFailure(causes: InspectionCause[]): {
  primaryCause: InspectionCause | null;
  contributingCauses: InspectionCause[];
} {
  const sorted = [...causes].sort((a, b) => {
    const byPriority = priority[a.code] - priority[b.code];
    if (byPriority !== 0) return byPriority;
    return (a.taskId ?? "").localeCompare(b.taskId ?? "") || (a.resourceRef ?? "").localeCompare(b.resourceRef ?? "");
  });
  const primaryCause = sorted.find((cause) => cause.severity === "blocking") ?? null;
  return {
    primaryCause,
    contributingCauses: primaryCause ? sorted.filter((cause) => cause !== primaryCause) : sorted,
  };
}
