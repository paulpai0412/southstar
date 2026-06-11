import type { IssueSnapshot } from "../types/control-plane.ts";
import { redactSecrets } from "./redaction.ts";
import { inspectInvariantViolations } from "./state-machine.ts";

export function inspectSnapshot(snapshot: IssueSnapshot, now: string): string {
  const lease = snapshot.runtime_context_json.owner_lease;
  const childRuns = snapshot.runtime_context_json.child_runs ?? [];
  const projectionSync = snapshot.runtime_context_json.projection_sync ?? [];
  const violations = inspectInvariantViolations(snapshot, now);

  return [
    "Lifecycle",
    `  state: ${snapshot.lifecycle_state}`,
    `  stage: ${snapshot.runtime_context_json.stage_cursor ?? "none"}`,
    "",
    "Lease",
    `  lease_id: ${lease?.lease_id ?? "none"}`,
    `  root_session_id: ${lease?.root_session_id ?? "none"}`,
    `  expires_at: ${lease?.expires_at ?? "none"}`,
    "",
    "Child Runs",
    ...childRuns.map((run) => {
      const rootSessionId = run.root_session_id ?? (run.lease_id === lease?.lease_id ? lease.root_session_id : "unknown");
      return `  ${run.child_run_id}: ${run.role} ${run.status} root=${rootSessionId} lease=${run.lease_id}`;
    }),
    ...(childRuns.length === 0 ? ["  none"] : []),
    "",
    "Projection Sync",
    ...projectionSync.map((item) => {
      const lastError = String(redactSecrets(item.last_error ?? ""));
      return `  ${String(item.projection_target)}: ${String(item.status)} ${lastError}`.trimEnd();
    }),
    ...(projectionSync.length === 0 ? ["  none"] : []),
    "",
    "Invariant Violations",
    ...(violations.length === 0 ? ["  none"] : violations.map((violation) => `  ${violation}`)),
  ].join("\n");
}
