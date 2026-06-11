# Northstar Live Integrations And Daemon E2E Design

- Date: 2026-05-29
- Status: proposed
- Scope: live GitHub/SDK E2E and real daemon supervision E2E
- Out of scope: production service packaging, OS service installers, long-duration soak tests, and unbounded host-agent work

## Purpose

Northstar now has deterministic offline E2E coverage for workflow completion, recovery, artifact rejection, projection/effect failures, and domain-general workflows. The next validation layer proves the two deferred E2E surfaces:

- real external integrations with GitHub, GitHub Project v2, OpenCode SDK, and Codex SDK
- real daemon/watch supervision through an actual CLI child process

These surfaces share one design spec so they use the same evidence style, but they must be implemented as two separate goals. Live network/credential failures must not block local daemon supervision validation, and daemon process bugs must not hide live integration failures.

## Test Modes

The existing deterministic commands remain unchanged:

```bash
npm test
npm run test:e2e
```

Neither command may require network access, GitHub credentials, OpenCode credentials, Codex credentials, or live host sessions.

Add two separate E2E commands:

```bash
npm run test:e2e:live
npm run test:e2e:daemon
```

`npm run test:e2e:live` may skip tests by default when no live mode is enabled. Once a live mode flag is enabled, missing required configuration must fail with a clear actionable error.

`npm run test:e2e:daemon` must be local-only and credential-free. It must start a real CLI child process rather than directly calling the in-process watch loop.

## Live GitHub/SDK E2E

### GitHub Target

The live GitHub E2E target is a dedicated sandbox repository:

```text
paulpai0412/northstar-live-sandbox
```

This keeps temporary issues, labels, comments, and project items away from the main `paulpai0412/northstar` repository.

When `NORTHSTAR_LIVE_GITHUB=1`, these values are required:

```text
GITHUB_TOKEN
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox
NORTHSTAR_LIVE_GITHUB_PROJECT_ID
```

GitHub Project v2 sync is required for the live GitHub E2E. If `NORTHSTAR_LIVE_GITHUB=1` is set and `NORTHSTAR_LIVE_GITHUB_PROJECT_ID` is missing, the suite must fail rather than skip project sync.

### GitHub Scenario

The live GitHub E2E must:

1. Create one temporary issue with a title prefix `northstar-smoke-*`.
2. Print the temporary issue number and URL in TAP diagnostics.
3. Apply at least one traceable label with a `northstar-smoke-*` prefix.
4. Add or update one compact body/comment projection.
5. Add the temporary issue to GitHub Project v2 using `NORTHSTAR_LIVE_GITHUB_PROJECT_ID`.
6. Close the temporary issue.
7. Exercise a retryable projection failure path through an injected failing adapter or deliberate bad target.
8. Avoid printing tokens, Authorization headers, full environments, or raw API payloads containing secrets.

The temporary issue may remain closed as an audit trace. If cleanup is implemented, cleanup failures must be counted and reported.

### GitHub Quantitative Metrics

`npm run test:e2e:live` must assert and print these GitHub metrics when `NORTHSTAR_LIVE_GITHUB=1`:

| Metric | Required Value |
| --- | --- |
| GitHub temporary issues created | `1` |
| GitHub labels synced | `>= 1` |
| GitHub comments/body projections synced | `>= 1` |
| GitHub Project v2 items synced | `1` |
| GitHub issues closed | `1` |
| GitHub retryable projection failures | `>= 1` |
| GitHub live cleanup errors | `0` unless cleanup is unsupported, in which case closed issue audit trace must be reported |

The summary line must include these keys with actual measured values. This example shows the minimum passing values:

```text
github_temporary_issues_created=1
github_labels_synced=1
github_comments_synced=1
github_project_items_synced=1
github_issues_closed=1
github_retryable_projection_failures=1
github_live_cleanup_errors=0
```

### OpenCode And Codex SDK Scenarios

When enabled, the live SDK E2E must use real SDK-backed adapter boundaries. It must not shell out to the `opencode` or `codex` CLIs.

Required live flags:

```text
NORTHSTAR_LIVE_OPENCODE=1
NORTHSTAR_LIVE_CODEX=1
```

SDK-specific credentials or provider settings must be read from environment variables or local credential stores only. They must never be written to repository files, SQLite history, logs, TAP diagnostics, or docs.

Each SDK scenario must:

1. Load the real SDK package through the existing narrow SDK loader boundary.
2. Construct the SDK-backed adapter/client.
3. Start one root session with a no-op/echo sandbox role.
4. Start one background child run from that root session.
5. Read root and child status, or the SDK's nearest equivalent liveness/capability signal.
6. Use a no-op prompt that asks for a fixed compact response and explicitly forbids file edits, git operations, network calls, and external command execution.
7. Enforce a timeout of `<= 120` seconds per SDK.
8. Record compact trace identifiers only: SDK name, root session id, child run id, status, and elapsed time.

The no-op child run must not mutate the repository, create worktrees, push commits, or call external tools.

### SDK Quantitative Metrics

When both `NORTHSTAR_LIVE_OPENCODE=1` and `NORTHSTAR_LIVE_CODEX=1` are enabled, `npm run test:e2e:live` must assert and print:

| Metric | Required Value |
| --- | --- |
| SDK packages loaded | `2/2` |
| SDK root sessions started | `2/2` |
| SDK background children started | `2/2` |
| SDK status reads | `>= 2` |
| SDK shell fallbacks | `0` |
| SDK live timeouts | `0` |
| SDK live duration seconds | `<= 240` |

The summary line must include these keys with actual measured values. This example shows a passing run:

```text
sdk_packages_loaded=2/2
sdk_root_sessions_started=2/2
sdk_background_children_started=2/2
sdk_status_reads=2
sdk_shell_fallbacks=0
sdk_live_timeouts=0
sdk_live_duration_seconds=42
```

## Real Daemon Supervision E2E

`npm run test:e2e:daemon` validates real process supervision. It is local-only, deterministic, and does not use GitHub, OpenCode, Codex, or live credentials.

### Daemon Harness

The daemon E2E harness must create a temporary project root containing:

- `.northstar.yaml`
- `.northstar/runtime/control-plane.sqlite3`
- one or more seeded local issue packets
- a configured workflow fixture
- captured daemon stdout/stderr

The harness must start the actual CLI entrypoint as a child process with a command equivalent to:

```bash
node --run northstar -- watch --config /tmp/northstar-daemon-e2e/.northstar.yaml
```

The implementation may add test-safe watch flags:

For example, a bounded test command may pass `--max-cycles 5 --interval-ms 50 --log-json`.

These flags must be documented in `northstar watch --help` and must be safe for local deterministic testing.

### Daemon Scenarios

The daemon E2E must cover five behaviors.

1. Bounded cycles:
   - Start a real daemon child process.
   - Run at least five watch/engine cycles.
   - Exit normally in bounded mode.
   - Emit compact cycle logs.

2. Restart reconstruction:
   - Start daemon for at least two cycles.
   - Stop it.
   - Restart from the same temp SQLite database.
   - Verify active work, leases, retryable projections, and history are reconstructed from SQLite rather than in-memory state.
   - Verify child runs are not duplicated without a new stage start.

3. Graceful SIGTERM:
   - Start daemon.
   - Send SIGTERM.
   - Verify exit within five seconds.
   - Verify no new effects are started after shutdown begins.

4. Writer lock collision:
   - Start daemon A and hold the writer lease.
   - Start daemon B on the same project DB.
   - Verify daemon B exits or skips with `writer_lock_unavailable`.
   - Verify daemon A exits cleanly or continues until bounded completion.

5. Compact log and secret guard:
   - Logs include cycle summaries.
   - Logs do not include raw transcripts, token-shaped secrets, Authorization headers, or full environment dumps.

### Daemon Quantitative Metrics

`npm run test:e2e:daemon` must assert and print:

| Metric | Required Value |
| --- | --- |
| Daemon processes started | `>= 3` |
| Daemon cycles completed | `>= 5` |
| Daemon restarts completed | `>= 1` |
| Daemon SIGTERMs handled | `>= 1` |
| Daemon SIGTERM exit ms | `<= 5000` |
| Daemon writer lock collisions | `1` |
| Daemon duplicate child runs | `0` |
| Daemon log lines | `>= 5` |
| Daemon secret leaks | `0` |
| Daemon E2E duration seconds | `<= 120` |

The summary line must include these keys with actual measured values. This example shows the minimum passing values:

```text
daemon_processes_started=3
daemon_cycles_completed=5
daemon_restarts_completed=1
daemon_sigterms_handled=1
daemon_sigterm_exit_ms=5000
daemon_writer_lock_collisions=1
daemon_duplicate_child_runs=0
daemon_log_lines=5
daemon_secret_leaks=0
daemon_e2e_duration_seconds=120
```

## Implementation Goal Split

### Goal 1: Live GitHub/SDK E2E

Goal 1 owns:

- `npm run test:e2e:live`
- live GitHub sandbox repository checks
- required GitHub Project v2 sync
- real OpenCode SDK no-op root and child run
- real Codex SDK no-op root and child run
- live E2E coverage matrix

Fresh verification:

```bash
npm test
npm run test:e2e
npm run test:e2e:live
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(&&|\\|\\||;)" src/adapters src/runtime src/cli
git status --short
```

`npm run test:e2e:live` may skip only when live mode flags are disabled. If `NORTHSTAR_LIVE_GITHUB=1`, `NORTHSTAR_LIVE_OPENCODE=1`, or `NORTHSTAR_LIVE_CODEX=1` is enabled, missing required configuration must fail.

### Goal 2: Real Daemon Supervision E2E

Goal 2 owns:

- `npm run test:e2e:daemon`
- real CLI child process execution for `northstar watch`
- bounded cycles
- restart reconstruction
- SIGTERM graceful shutdown
- writer lock collision
- compact logs and secret guards
- daemon E2E coverage matrix

Fresh verification:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
node --run northstar -- watch --help
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(&&|\\|\\||;)" src/adapters src/runtime src/cli
git status --short
```

## Shared Completion Rules

- Both goals must use TDD.
- Both goals must preserve deterministic `npm test` and `npm run test:e2e`.
- Both goals must print compact quantified TAP diagnostic summary lines.
- Both goals must update a coverage matrix mapping requirement, test file, and implementation file.
- External commands must use argv arrays.
- Runtime core must not depend on `/home/timmypai/apps/autodev/scripts` or Python runtime.
- Secrets must not be written to repository files, SQLite history, logs, TAP diagnostics, or docs.
- Live credentials may be read only by live tests or adapter-specific credential providers.
- Daemon E2E must not require live credentials.
