# Northstar Full Live Exception E2E Design

- Date: 2026-05-29
- Status: approved for implementation planning
- Scope: full live exception E2E for GitHub, Codex, release, quarantine, and recovery behavior
- Sandbox repository: `paulpai0412/northstar-live-sandbox`
- Out of scope: OpenCode full exception E2E, production OS service packaging, long-duration soak testing, and destructive cleanup of audit records

## Purpose

Northstar already has deterministic offline exception E2E coverage and a Codex-only happy-path full live workflow E2E. The remaining validation gap is live exception behavior: real GitHub issues, real Codex SDK boundaries, real PR/release failures, and recovery flows that prove the runtime remains auditable and recoverable under failure.

This suite must answer one question with quantitative evidence:

> Can Northstar handle live issue execution failures across GitHub, Codex, release, lease, quarantine, and cleanup boundaries without leaking secrets, losing audit history, or falsely marking failed work as complete?

## Test Mode

Add a separate full live exception layer. It must never run as part of `npm test`, deterministic offline E2E, daemon E2E, offline exception E2E, or code coverage gates.

Commands:

```bash
npm run test:e2e:full-live:exceptions:github
npm run test:e2e:full-live:exceptions:codex
npm run test:e2e:full-live:exceptions:recovery
npm run test:e2e:full-live:exceptions
```

The aggregate command runs the three layer commands and reports combined metrics.

The aggregate command must be implemented through a Node runner that spawns package scripts with argv arrays. It must not use shell-chain package scripts such as `cmd1 && cmd2`.

When `NORTHSTAR_FULL_LIVE_EXCEPTIONS` is absent, each command must clear-skip with a compact actionable message. When enabled, missing required configuration must fail with an actionable error.

Required configuration:

```text
NORTHSTAR_FULL_LIVE_EXCEPTIONS=1
GITHUB_TOKEN
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox
```

Codex SDK credentials and provider settings must come from environment variables or the local credential store. Secrets must not be written to repository files, SQLite history payloads, TAP diagnostics, GitHub issue/PR bodies, comments, or captured worker responses.

## Architecture

Add a test-only package under `tests/e2e-full-live-exceptions/`.

```text
tests/e2e-full-live-exceptions/
  index.test.ts
  env.ts
  metrics.ts
  github-exceptions.test.ts
  codex-exceptions.test.ts
  recovery-exceptions.test.ts
  harness.ts
  github-faults.ts
  codex-faults.ts
  cleanup.ts
```

The suite should reuse the shape of the existing full live helpers, while keeping exception behavior explicit:

- GitHub sandbox helpers create issues, branches, PRs, comments, merges, and branch cleanup attempts.
- Codex worker helpers start true Codex SDK sessions for selected cases and use fault runners for expensive or unstable failures.
- Runtime helpers seed issue snapshots, acquire owner leases, submit child artifacts, record retryable failures, quarantine issues, resume issues, and submit release facts.
- Fault helpers deterministically inject GitHub API failures, Codex timeouts, malformed artifacts, empty responses, merge conflict responses, and cleanup failures.
- Metrics helpers track FLX requirement coverage, EX mapping coverage, scenario counts, live artifact URLs, secret scans, and duration.

The state machine remains production code. Test harnesses may drive runtime events explicitly when the current daemon cannot yet autonomously complete the live exception flow.

## Requirement Coverage Model

Full live exception coverage uses new `FLX` requirements and maps them back to existing offline `EX` requirements.

The primary denominator is 18 FLX requirements. The suite passes only when at least 16 are covered:

```text
full_live_exception_requirements_total=18
full_live_exception_requirements_covered>=16
full_live_exception_requirement_coverage_percent>=88
```

The secondary denominator is the 14 existing offline EX requirements. The suite passes only when at least 12 existing EX requirements are represented by live evidence:

```text
full_live_exception_ex_mappings_total>=14
full_live_exception_ex_mappings_covered>=12
full_live_exception_ex_mapping_percent>=85
```

Coverage counts only when a live or fault-injected scenario executes and asserts durable behavior. Merely constructing a helper or metric does not count.

## Scenario Matrix

| ID | Group | Requirement | Recovery Level | EX Mapping |
| --- | --- | --- | --- | --- |
| FLX-01 | GitHub boundary | GitHub label, body, comment, or projection failure records retryable history and does not mutate lifecycle directly. | Auditable retryable | EX-12 |
| FLX-02 | GitHub boundary | Project sync with missing `NORTHSTAR_LIVE_GITHUB_PROJECT_ID` fails the live project case clearly. | Auditable configuration failure | EX-12 |
| FLX-03 | GitHub boundary | Issue close failure records retryable cleanup failure. | Auditable retryable | EX-13 |
| FLX-04 | GitHub boundary | PR create failure records retryable pre-release or release preparation failure. | Auditable retryable | EX-13 |
| FLX-05 | GitHub boundary | A real merge conflict is produced by two live PRs touching the same fixture path. | Auditable conflict | EX-13 |
| FLX-06 | GitHub boundary | Merge conflict recovery creates a new non-conflicting branch and PR, merges it, and reaches `completed`. | Completed | EX-13, EX-14 |
| FLX-07 | Codex agent | A true Codex prompt-driven verifier failure is recorded as a verification failure. | Auditable failure | EX-10, EX-11 |
| FLX-08 | Codex agent | Verifier failure recovery reruns verification and reaches release. | Completed | EX-10 |
| FLX-09 | Codex agent | Codex malformed artifact is rejected and auditable. | Auditable rejection | EX-09 |
| FLX-10 | Codex agent | Codex timeout fault records retryable child failure. | Auditable retryable | EX-07 |
| FLX-11 | Codex agent | Codex empty response fault records retryable or blocked child result. | Auditable retryable | EX-07 |
| FLX-12 | Codex agent | Codex implementation failure recovery covers retryable and terminal child outcomes, reruns child, creates a valid PR, and reaches completion. | Completed | EX-07, EX-08, EX-10 |
| FLX-13 | Runtime recovery | Active live issue with missing or expired owner lease is quarantined. | Quarantined | EX-01, EX-02 |
| FLX-14 | Runtime recovery | Quarantined live issue rejects unsafe resume attempts and resumes with a new or host-confirmed valid owner lease. | Resumed | EX-03, EX-04, EX-05, EX-06 |
| FLX-15 | Runtime recovery | Release success without confirmed merge is rejected. | Auditable rejection | EX-13 |
| FLX-16 | Runtime recovery | Confirmed merge plus local cleanup failure remains `completed`. | Completed | EX-14 |
| FLX-17 | Runtime recovery | Failed branch cleanup is retryable and does not reverse completion. | Auditable retryable | EX-13, EX-14 |
| FLX-18 | Safety | No secrets appear in live issue body, PR body, SQLite history, TAP diagnostics, worker responses, or cleanup comments. | Safety gate | EX-12, EX-13 |

Core completed cases are `FLX-06`, `FLX-08`, `FLX-12`, and `FLX-16`. Each must create or recover a real PR, merge into sandbox `main`, record confirmed merge evidence, and transition the runtime issue to `completed`.

Other cases may pass with retryable, quarantined, failed, rejected, or resumed evidence when the durable history and lifecycle assertions prove the behavior.

## Quantitative Acceptance Metrics

The aggregate suite must print one compact TAP diagnostic line and assert these thresholds:

| Metric | Required Value |
| --- | --- |
| `full_live_exception_requirements_total` | `18` |
| `full_live_exception_requirements_covered` | `>= 16` |
| `full_live_exception_requirement_coverage_percent` | `>= 88` |
| `full_live_exception_ex_mappings_total` | `>= 14` |
| `full_live_exception_ex_mappings_covered` | `>= 12` |
| `full_live_exception_ex_mapping_percent` | `>= 85` |
| `full_live_exception_scenarios_passed` | equals total scenarios |
| `full_live_exception_live_github_cases` | `>= 6` |
| `full_live_exception_live_codex_cases` | `>= 3` |
| `full_live_exception_fault_injection_cases` | `>= 4` |
| `full_live_exception_recovery_completed_cases` | `>= 4` |
| `full_live_exception_prs_created` | `>= 4` |
| `full_live_exception_prs_merged` | `>= 4` |
| `full_live_exception_real_merge_conflicts` | `1` |
| `full_live_exception_retryable_failures` | `>= 5` |
| `full_live_exception_quarantined_cases` | `>= 1` |
| `full_live_exception_resume_successes` | `>= 1` |
| `full_live_exception_terminal_failures` | `>= 1` |
| `full_live_exception_cleanup_failures_recorded` | `>= 1` |
| `full_live_exception_secret_leaks` | `0` |
| `full_live_exception_unclosed_failed_issues` | `0` |
| `full_live_exception_failed_branch_cleanup_attempts` | `>= 1` |
| `full_live_exception_duration_seconds` | `<= 2400` |

Layer commands should also print layer-specific summaries so failures can be debugged without rerunning the aggregate suite.

## Data Flow

Each scenario follows the same durable flow:

1. Create a live sandbox issue with a `northstar-exception-smoke-*` prefix.
2. Seed or intake a runtime issue snapshot from the live issue packet.
3. Acquire the owner lease for the active role.
4. Start the live or fault-injected GitHub/Codex/release action.
5. Record failure as compact runtime history, projection history, child artifact history, repair action, or effect result.
6. Assert lifecycle semantics:
   - Retryable child, projection, and cleanup failures do not directly fail lifecycle.
   - Terminal child or verifier failures may transition to `failed`.
   - Unsafe active issues with invalid lease become `quarantined`.
   - Release success without confirmed merge is rejected.
7. Execute the configured recovery path when the scenario requires it.
8. Assert final durable outcome: `completed`, `quarantined`, `failed`, rejected, retryable, or resumed as specified by the FLX requirement.
9. Attempt branch cleanup for failed branches.
10. Close all created live issues, preserving issue/PR/merge audit records.

## Error Handling And Safety

Live GitHub and Codex errors must never be swallowed. They must become either:

- a compact redacted retryable history row,
- a compact redacted test failure with issue/PR URLs,
- a quarantine or failed lifecycle transition when the state machine defines that behavior, or
- an explicit actionable configuration failure.

Secret safety is a hard gate. The suite must scan:

- TAP diagnostics,
- metric summaries,
- SQLite history payloads,
- GitHub issue bodies,
- GitHub PR bodies,
- GitHub comments created by the suite,
- Codex worker responses,
- cleanup messages.

Any secret-shaped value fails `FLX-18`.

The suite preserves audit traces:

- Closed issues remain.
- Merged PRs and merge commits remain.
- Conflict PRs may remain closed or unmerged as trace evidence.
- Failed branches are cleanup candidates. Cleanup failures are recorded as retryable cleanup failures and must not reverse a completed lifecycle.

## TDD And Verification

Implementation must use TDD:

1. Add command shell, env contract, metrics contract, and clear-skip behavior.
2. Add FLX/EX coverage matrix tests.
3. Implement GitHub exception layer.
4. Implement Codex exception layer.
5. Implement recovery exception layer.
6. Add aggregate command and summary.
7. Run final verification.

Fresh verification gate:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
npm run test:e2e:full-live:exceptions
NORTHSTAR_FULL_LIVE_EXCEPTIONS=1 GITHUB_TOKEN="$GITHUB_TOKEN" NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:full-live:exceptions
node --run northstar -- --help
node --run northstar -- --version
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
git status --short
```

For the forbidden `rg` scans, no matches is the passing result.

## Deferred Work

- OpenCode full live exception E2E.
- Daemon-driven full live exception execution without harness-injected runtime events.
- Long-duration live soak testing.
- Production service packaging and OS service failure recovery.
- Retention policy for old sandbox smoke traces.
