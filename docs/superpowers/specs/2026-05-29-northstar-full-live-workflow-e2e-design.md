# Northstar Full Live Workflow E2E Design

- Date: 2026-05-29
- Status: proposed
- Scope: full live GitHub issue to Codex implementation, verification, PR merge, and Northstar release completion
- Sandbox repository: `paulpai0412/northstar-live-sandbox`
- Out of scope: OpenCode full workflow E2E, destructive cleanup of audit traces, production OS service packaging, long-duration soak testing

## Purpose

Northstar already has deterministic offline E2E coverage for runtime correctness and separate live smoke coverage for GitHub projection and SDK session creation. This design adds the next validation layer: one real end-to-end workflow that starts from a live GitHub issue and completes through a real Codex implementation child, Codex verification child, real PR, real merge, and runtime `completed` lifecycle.

The first implementation must be intentionally narrow. It validates the product-shaped workflow without allowing the test to modify the main Northstar repository or depend on non-deterministic project tasks.

## Test Mode

Add a separate full live command:

```bash
npm run test:e2e:full-live
```

This command is never part of `npm test`, `npm run test:e2e`, or `npm run test:e2e:daemon`.

When `NORTHSTAR_FULL_LIVE` is not set, the suite may skip with a clear message. When `NORTHSTAR_FULL_LIVE=1`, missing required configuration must fail with an actionable error.

Required configuration:

```text
NORTHSTAR_FULL_LIVE=1
GITHUB_TOKEN
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox
```

Codex credentials and provider settings must come from environment variables or the local Codex credential store. Secrets must not be written to repository files, SQLite history, TAP diagnostics, or captured logs.

## Safety Model

The full live suite may create and merge real PRs only in `paulpai0412/northstar-live-sandbox`.

Each run uses a unique prefix:

```text
northstar-smoke-YYYYMMDD-HHMMSS-<shortid>
```

For each issue, the Codex implementation creates exactly one unique fixture path under:

```text
northstar-smoke/<run-id>/<issue-id>.json
```

The suite keeps audit traces. It does not delete issues, PRs, merge commits, or fixture files. It closes GitHub issues after successful release completion. Closed issues, merged PRs, and fixture files are the audit record.

## Architecture

The full live harness drives the real external workflow while keeping pass/fail deterministic.

1. Create one or more live GitHub issues in the sandbox repository.
2. Intake each issue into Northstar's SQLite control plane or create an equivalent runtime issue snapshot from the live issue packet.
3. Acquire the appropriate owner lease for the current workflow role.
4. Start a real Codex SDK root session and background child for implementation.
5. The Codex implement child creates a branch, writes the unique fixture file, commits, pushes, and opens a PR.
6. Start a real Codex verifier child.
7. The Codex verifier reads the PR and emits an evidence packet.
8. A deterministic gate verifies PR diff, fixture path, fixture content, branch, commit SHA, and PR state through GitHub API or git checkout.
9. A release step merges the PR into sandbox `main`.
10. Northstar records a confirmed merge fact and transitions the runtime issue to `completed`.
11. The harness closes the GitHub issue and emits metrics with issue URL, PR URL, merge SHA, and duration.

Codex agents participate in implementation and verification, but final test success does not depend on an agent claiming success. Deterministic gates decide pass/fail.

## Scenarios

### Scenario A: Single Issue Full Flow

This scenario proves one live issue can complete the whole workflow.

Quantitative acceptance:

| Metric | Required value |
| --- | --- |
| `full_live_issues_created` | `1` |
| `full_live_runtime_issues_completed` | `1` |
| `full_live_codex_root_sessions_started` | `>= 1` |
| `full_live_codex_child_runs_started` | `>= 2` |
| `full_live_branches_pushed` | `1` |
| `full_live_prs_created` | `1` |
| `full_live_prs_merged` | `1` |
| `full_live_confirmed_merge_facts` | `1` |
| `full_live_fixture_files_created` | `1` |
| `full_live_fixture_content_matches` | `1` |
| `full_live_github_issues_closed` | `1` |
| `full_live_secret_leaks` | `0` |
| `full_live_single_duration_seconds` | `<= 600` |

### Scenario B: Two Issues Sequential

This scenario proves two live issues can complete in order while capacity is constrained to one active implementation worker.

Quantitative acceptance:

| Metric | Required value |
| --- | --- |
| `full_live_sequential_issues_created` | `2` |
| `full_live_sequential_completed` | `2` |
| `full_live_sequential_prs_created` | `2` |
| `full_live_sequential_prs_merged` | `2` |
| `full_live_sequential_ordering_violations` | `0` |
| `full_live_sequential_max_active_issue_workers` | `1` |
| `full_live_sequential_fixture_files_created` | `2` |
| `full_live_sequential_cross_issue_contamination` | `0` |
| `full_live_sequential_duration_seconds` | `<= 1200` |

### Scenario C: Two Issues Parallel

This scenario proves two live issues can overlap execution without branch, PR, fixture, or release contamination.

Quantitative acceptance:

| Metric | Required value |
| --- | --- |
| `full_live_parallel_issues_created` | `2` |
| `full_live_parallel_completed` | `2` |
| `full_live_parallel_prs_created` | `2` |
| `full_live_parallel_prs_merged` | `2` |
| `full_live_parallel_overlap_seconds` | `>= 1` |
| `full_live_parallel_max_active_issue_workers` | `>= 2` |
| `full_live_parallel_fixture_files_created` | `2` |
| `full_live_parallel_cross_issue_contamination` | `0` |
| `full_live_parallel_merge_conflicts` | `0` |
| `full_live_parallel_duration_seconds` | `<= 900` |

## Suite-Level Acceptance

When all three scenarios run in one full live suite:

| Metric | Required value |
| --- | --- |
| `full_live_total_issues_created` | `5` |
| `full_live_total_completed` | `5` |
| `full_live_total_prs_merged` | `5` |
| `full_live_total_fixture_files_created` | `5` |
| `full_live_total_failed_releases` | `0` |
| `full_live_total_secret_leaks` | `0` |
| `full_live_total_duration_seconds` | `<= 2700` |

The suite must print compact metrics and the live issue/PR URLs for traceability.

## Components

Add full live E2E test files:

```text
tests/e2e-full-live/
  index.test.ts
  single-issue-full-live.test.ts
  sequential-issues-full-live.test.ts
  parallel-issues-full-live.test.ts
  env.ts
  harness.ts
  metrics.ts
```

The harness owns:

- live env validation
- sandbox issue creation and closure
- branch naming
- Codex SDK implementation and verification child prompts
- PR creation, diff reads, merge, and merge confirmation
- runtime event driving when needed
- deterministic gate checks
- compact metric output
- secret redaction and secret leak scans

Production additions should stay narrow:

- If the existing Codex adapter is insufficient for a full workflow, add a narrow Codex full-live worker wrapper instead of widening core runtime.
- If existing GitHub projection code does not support PR create, PR merge, and diff reads, add a sandbox-scoped GitHub PR helper rather than mixing PR release behavior into the projection adapter.
- If the daemon/engine cannot yet autonomously drive the whole live workflow, the first full live suite may have the harness drive runtime events explicitly. A later goal can move that driving into the daemon loop.

## Error Handling

Configuration:

- `NORTHSTAR_FULL_LIVE` absent: skip the full live suite with a clear message.
- `NORTHSTAR_FULL_LIVE=1` with missing required env or credentials: fail with a clear actionable error.

Runtime failures:

- Codex timeout increments the relevant timeout metric and fails the scenario.
- GitHub API failures preserve any created issue/PR audit trace and fail the scenario with compact URLs.
- PR merge conflicts fail the scenario and must keep `full_live_parallel_merge_conflicts = 0` as a hard passing requirement.
- GitHub issue close failures fail the scenario because closed issues are part of the audit completion contract.
- Any detected secret-shaped value in TAP diagnostics, captured logs, or compact SQLite payload fails the scenario.

## TDD And Goal Execution

The implementation goal must use TDD:

1. Add full live E2E shell and metrics contract.
2. Verify live flag off skips and live flag on with missing env fails.
3. Implement Scenario A with RED then GREEN.
4. Implement Scenario B with RED then GREEN.
5. Implement Scenario C with RED then GREEN.
6. Add a full live coverage matrix.
7. Run final verification:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
NORTHSTAR_FULL_LIVE=1 npm run test:e2e:full-live
node --run northstar -- watch --help
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
git status --short
```

The full live suite may require network access and GitHub/Codex credentials. It must not be silently counted as passing if credentials are missing.

## Deferred Work

- OpenCode full workflow E2E.
- Daemon-driven full live workflow without harness-injected runtime events.
- Destructive cleanup or retention policies for old sandbox smoke traces.
- Long-duration soak tests.
- Production service packaging and OS service integration.
