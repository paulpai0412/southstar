import test from "node:test";
import assert from "node:assert/strict";
import { formatDaemonSummary, runDaemonSupervisionE2E } from "./harness.ts";

test("real daemon supervision E2E reports quantified metrics", async (t) => {
  const metrics = await runDaemonSupervisionE2E();
  t.diagnostic(formatDaemonSummary(metrics));

  assert.ok(metrics.daemon_processes_started >= 3);
  assert.ok(metrics.daemon_cycles_completed >= 5);
  assert.ok(metrics.daemon_restarts_completed >= 1);
  assert.ok(metrics.daemon_active_issues_loaded >= 1);
  assert.ok(metrics.daemon_history_rows_reconstructed >= 1);
  assert.ok(metrics.daemon_sigterms_handled >= 1);
  assert.ok(metrics.daemon_sigterm_exit_ms <= 5000);
  assert.equal(metrics.daemon_writer_lock_collisions, 1);
  assert.equal(metrics.daemon_duplicate_child_runs, 0);
  assert.ok(metrics.daemon_log_lines >= 5);
  assert.equal(metrics.daemon_secret_leaks, 0);
  assert.ok(metrics.daemon_e2e_duration_seconds <= 120);
});
