# Northstar OpenCode Full Live E2E Design

- Date: 2026-05-29
- Status: approved for implementation planning
- Scope: OpenCode full live happy path and OpenCode exception flow E2E
- Sandbox repository: `paulpai0412/northstar-live-sandbox`
- Out of scope: replacing Codex full live E2E, production daemon-driven live execution, long-duration soak testing, destructive cleanup of audit records

## Purpose

Northstar already has a Codex full live workflow E2E and a Codex/GitHub/runtime full live exception E2E. The remaining provider gap is OpenCode: the project has an SDK-first `OpenCodeHostAdapter` and a live package load smoke, but it does not yet prove that OpenCode can participate in a real issue-to-PR-to-merge workflow or that OpenCode-specific failures are represented as recoverable runtime evidence.

This design adds a separate OpenCode live E2E layer. It must answer two questions with quantitative evidence:

1. Can a real OpenCode SDK implementation/verifier path complete one live GitHub issue through PR merge and runtime `completed`?
2. Can OpenCode boundary failures, child failures, bad artifacts, lost child runs, quarantine, resume, and retry recovery be validated without leaking secrets or shelling out to host CLIs?

## Test Mode

Add OpenCode-specific commands:

```bash
npm run test:e2e:full-live:opencode
npm run test:e2e:full-live:opencode:exceptions
npm run test:e2e:full-live:opencode:all
```

These commands must not run from `npm test`, `npm run test:e2e`, `npm run test:e2e:daemon`, `npm run test:e2e:exceptions`, `npm run test:coverage`, or existing Codex full live scripts.

When `NORTHSTAR_FULL_LIVE_OPENCODE` is absent, the OpenCode live commands clear-skip with an actionable message. When enabled, missing configuration fails with a compact actionable error.

Required configuration:

```text
NORTHSTAR_FULL_LIVE_OPENCODE=1
GITHUB_TOKEN
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox
```

OpenCode SDK credentials and provider configuration must come from environment variables or the local OpenCode credential store. Secrets must not be written to repository files, SQLite history payloads, TAP diagnostics, GitHub issues, PR bodies, comments, or captured worker responses.

## Architecture

Add a test-only package:

```text
tests/e2e-full-live-opencode/
  index.test.ts
  env.ts
  metrics.ts
  opencode-worker.ts
  opencode-full-live.test.ts
  opencode-exceptions.test.ts
  harness.ts
  faults.ts
  run-opencode-full-live-gates.ts
```

The suite should reuse existing full live patterns without merging provider behavior into the Codex tests:

- Reuse sandbox GitHub helpers and runtime driver patterns from `tests/e2e-full-live/`.
- Reuse exception metric and fault-injection patterns from `tests/e2e-full-live-exceptions/`.
- Add an OpenCode worker wrapper behind the existing SDK-first boundary.
- Keep runtime core and state-machine behavior unchanged unless a focused test exposes a real integration defect.
- Keep all external commands as argv arrays.

The OpenCode worker wrapper is test-only. It may adapt the concrete `@opencode-ai/sdk` shape into the project-level concepts used by the OpenCode host adapter:

- root session started
- background child started
- child result observed
- root/child status readable
- resume hint readable
- no shell fallback used

If the actual SDK API differs from the current adapter assumptions, implementation must first capture the mismatch in a failing loader/wrapper test, then add the narrowest wrapper update needed. The suite must remain SDK-first and must not call the `opencode` CLI.

## Happy Path Scenario

The happy path is one real issue through release:

1. Create one sandbox GitHub issue with a `northstar-opencode-smoke-*` prefix.
2. Seed or intake the issue into the Northstar runtime control plane.
3. Acquire an owner lease for the implementation role.
4. Start a real OpenCode SDK root session.
5. Start a real OpenCode SDK implementation child.
6. The implementation child creates a branch, writes one unique fixture file, commits, pushes, and opens a PR in `paulpai0412/northstar-live-sandbox`.
7. Start a real OpenCode SDK verifier child.
8. A deterministic gate validates the PR diff, fixture path, fixture content, branch, commit SHA, and PR state.
9. Merge the PR into sandbox `main`.
10. Record confirmed merge evidence and transition the runtime issue to `completed`.
11. Close the GitHub issue and print issue URL, PR URL, merge SHA, and compact metrics.

Agent self-report is not enough to pass. The deterministic gate decides success from GitHub/runtime evidence.

Happy path quantitative acceptance:

| Metric | Required Value |
| --- | --- |
| `opencode_full_live_issues_created` | `1` |
| `opencode_full_live_root_sessions_started` | `>= 1` |
| `opencode_full_live_child_runs_started` | `>= 2` |
| `opencode_full_live_prs_created` | `1` |
| `opencode_full_live_prs_merged` | `1` |
| `opencode_full_live_runtime_completed` | `1` |
| `opencode_full_live_confirmed_merge_facts` | `1` |
| `opencode_full_live_fixture_files_created` | `1` |
| `opencode_full_live_fixture_content_matches` | `1` |
| `opencode_full_live_github_issues_closed` | `1` |
| `opencode_full_live_shell_fallbacks` | `0` |
| `opencode_full_live_secret_leaks` | `0` |
| `opencode_full_live_duration_seconds` | `<= 900` |

## Exception Flow

The exception suite uses a hybrid strategy:

- True OpenCode SDK boundary cases validate root session, background child start, status reads, resume hints, and no shell fallback.
- Deterministic fault injection validates expensive or unstable failure behavior without relying on brittle live provider failures.

OpenCode exception requirements:

| ID | Requirement | Expected Durable Outcome |
| --- | --- | --- |
| OCX-01 | OpenCode SDK root session can start and status can be read. | Auditable live SDK boundary evidence |
| OCX-02 | OpenCode background child can start and status can be read. | Auditable child run evidence |
| OCX-03 | OpenCode resume hint is available for a live or known root session. | Auditable resume evidence |
| OCX-04 | OpenCode wrapper rejects unavailable or mismatched SDK capabilities with actionable errors. | Configuration or wrapper failure without lifecycle corruption |
| OCX-05 | OpenCode verifier failure is recorded as verification failure. | Failed or retryable verification evidence |
| OCX-06 | Verifier failure recovery reruns verification and reaches release. | Completed |
| OCX-07 | OpenCode malformed artifact is rejected and auditable. | Artifact rejection history |
| OCX-08 | OpenCode timeout records retryable child failure. | Retryable child failure history |
| OCX-09 | OpenCode empty response records retryable or blocked child result. | Retryable or blocked history |
| OCX-10 | Lost or unknown OpenCode child artifact is auditable without advancing lifecycle. | Auditable orphan/lost child evidence |
| OCX-11 | Active issue with missing or expired OpenCode owner lease is quarantined. | Quarantined |
| OCX-12 | Quarantined issue rejects unsafe resume and resumes with valid new or host-confirmed lease. | Resumed |
| OCX-13 | OpenCode implementation failure recovery reruns child, creates valid PR, and completes. | Completed |
| OCX-14 | No secrets appear in issue body, PR body, SQLite history, TAP diagnostics, worker responses, or cleanup comments. | Safety gate |

Exception quantitative acceptance:

| Metric | Required Value |
| --- | --- |
| `opencode_exception_requirements_total` | `14` |
| `opencode_exception_requirements_covered` | `>= 12` |
| `opencode_exception_requirement_coverage_percent` | `>= 85` |
| `opencode_exception_scenarios_passed` | equals total scenarios |
| `opencode_exception_sdk_boundary_cases` | `>= 4` |
| `opencode_exception_fault_injection_cases` | `>= 5` |
| `opencode_exception_retryable_failures` | `>= 3` |
| `opencode_exception_quarantined_cases` | `>= 1` |
| `opencode_exception_resume_successes` | `>= 1` |
| `opencode_exception_recovery_completed_cases` | `>= 2` |
| `opencode_exception_terminal_failures` | `>= 1` |
| `opencode_exception_shell_fallbacks` | `0` |
| `opencode_exception_secret_leaks` | `0` |
| `opencode_exception_duration_seconds` | `<= 1800` |

## Data Flow

Happy path and recovery-completed exception scenarios produce durable sandbox audit traces:

- closed GitHub issues
- PR URLs
- merge SHAs
- unique fixture files under `northstar-smoke/<run-id>/`
- compact runtime history rows
- confirmed merge facts

Retryable, failed, rejected, quarantined, and resumed scenarios must produce compact runtime or test harness evidence that includes the relevant issue id, root session id, child run id, lifecycle state, and redacted error category.

## Error Handling And Safety

Configuration failures must name missing fields and stop the live command. They must not look like a passing skip when `NORTHSTAR_FULL_LIVE_OPENCODE=1`.

Provider/API mismatches must be debugged systematically:

- capture observed SDK shape or thrown error in a focused failing test,
- update only the narrow wrapper boundary,
- keep core runtime pure,
- preserve no-shell-fallback assertions.

Secret safety is a hard gate. The suite scans compact summaries, TAP diagnostics, SQLite payloads, GitHub issue/PR/comment content created by the suite, and worker responses. Any secret-shaped value fails the relevant command.

## TDD And Verification

Implementation must use TDD:

1. Add OpenCode full-live command shell, env contract, metrics contract, and clear-skip behavior.
2. Add fake-SDK unit tests for the OpenCode worker wrapper and prove no shell fallback.
3. Add happy path live test, see RED, then implement the narrow OpenCode full-live worker path.
4. Add OCX coverage matrix and spec compliance checks.
5. Add exception flow tests with deterministic fault injection and live SDK boundary evidence.
6. Add aggregate runner and threshold assertions.
7. Run the final verification gate.

Fresh verification gate:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
npm run test:e2e:full-live:opencode
npm run test:e2e:full-live:opencode:exceptions
npm run test:e2e:full-live:opencode:all
NORTHSTAR_FULL_LIVE_OPENCODE=1 GITHUB_TOKEN="$GITHUB_TOKEN" NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:full-live:opencode:all
node --run northstar -- --help
node --run northstar -- --version
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
git status --short
```

For the forbidden `rg` scans, no matches is the passing result.

## Deferred Work

- Running the same OpenCode suite under a production daemon instead of a harness-driven runtime.
- Multi-issue sequential and parallel OpenCode full live workflows.
- Long-duration OpenCode live soak tests.
- OpenCode provider matrix across multiple models or agents.
- Retention policy for old sandbox smoke traces.
