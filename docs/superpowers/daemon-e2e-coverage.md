# Northstar Daemon Supervision E2E Coverage

Source plan: `docs/superpowers/plans/2026-05-29-northstar-daemon-supervision-e2e-plan.md`

| Requirement | Quantified acceptance | Test files | Implementation files |
| --- | --- | --- | --- |
| Daemon process supervision | `daemon_processes_started >= 3`, `daemon_cycles_completed >= 5`, `daemon_restarts_completed >= 1`, `daemon_e2e_duration_seconds <= 120` | `tests/e2e-daemon/daemon-e2e.test.ts`, `tests/e2e-daemon/harness.ts`, `tests/cli/cli.test.ts` | `src/cli/entrypoint.ts`, `src/cli/watch-command.ts`, `src/runtime/watch.ts` |
| SQLite reconstruction | `daemon_active_issues_loaded >= 1`, `daemon_history_rows_reconstructed >= 1` after bounded runs and restarts | `tests/e2e-daemon/daemon-e2e.test.ts`, `tests/e2e-daemon/harness.ts`, `tests/runtime/watch.test.ts` | `src/cli/watch-command.ts`, `src/runtime/store.ts`, `src/runtime/watch.ts` |
| SIGTERM handling | `daemon_sigterms_handled >= 1`, `daemon_sigterm_exit_ms <= 5000` | `tests/e2e-daemon/daemon-e2e.test.ts`, `tests/e2e-daemon/harness.ts`, `tests/runtime/watch.test.ts` | `src/cli/watch-command.ts`, `src/runtime/watch.ts` |
| Writer lock collision | `daemon_writer_lock_collisions = 1`, `daemon_duplicate_child_runs = 0` | `tests/e2e-daemon/daemon-e2e.test.ts`, `tests/e2e-daemon/harness.ts`, `tests/runtime/watch.test.ts` | `src/runtime/watch-lock.ts`, `src/cli/watch-command.ts`, `src/runtime/watch.ts` |
| Compact safe logs | `daemon_log_lines >= 5`, `daemon_secret_leaks = 0` | `tests/e2e-daemon/daemon-e2e.test.ts`, `tests/e2e-daemon/harness.ts`, `tests/runtime/watch.test.ts` | `src/runtime/watch-logger.ts`, `src/cli/watch-command.ts` |
| CLI bounded watch entrypoint | `northstar watch --help` documents `--max-cycles`, `--interval-ms`, and `--log-json`; E2E starts real watch child processes with argv arrays | `tests/cli/cli.test.ts`, `tests/e2e-daemon/harness.ts` | `src/cli/northstar.ts`, `src/cli/entrypoint.ts`, `src/cli/watch-command.ts` |

The daemon E2E suite is intentionally local-only. It uses temporary project roots and SQLite stores, starts real `northstar watch` child processes, and keeps network, GitHub credentials, OpenCode credentials, and Codex credentials outside this test gate.
