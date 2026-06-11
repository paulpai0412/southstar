# Northstar Exception E2E Test Design

- Date: 2026-05-29
- Status: approved for implementation planning
- Scope: deterministic offline E2E tests for issue execution exceptions, quarantine, failure, and recovery
- Out of scope: live GitHub/OpenCode/Codex exception workflows, production OS service supervision, and code coverage tooling

## Purpose

Northstar already has happy-path offline E2E, daemon supervision E2E, and full live workflow E2E coverage. The missing validation layer is a deterministic exception E2E suite that proves issue execution remains auditable and recoverable when development-time failures happen.

The suite must answer one question with quantitative evidence:

> Can Northstar quarantine, fail, reject, retry, repair, and resume issue execution safely while preserving durable history and avoiding network or credential dependencies?

## Test Mode

The exception E2E suite is offline and deterministic.

- It must run as `npm run test:e2e:exceptions`.
- It must not call GitHub, OpenCode, Codex, host CLIs, or external services.
- It must not read `GITHUB_TOKEN`, `NORTHSTAR_LIVE_*`, OpenCode credentials, Codex credentials, or any live credential store.
- It must use temporary SQLite databases, local workflow fixtures, existing runtime/state-machine/store/repair APIs, and fake or injected adapters.
- It must be separate from `npm test`, `npm run test:e2e`, `npm run test:e2e:daemon`, and `npm run test:e2e:full-live`.
- `npm run test:e2e:full-live` without live flags must continue to clear-skip and must not be required for exception E2E behavior.

## Recommended Architecture

Add a test-only package under `tests/e2e-exceptions/`.

The suite should include:

- `index.test.ts` as the command entrypoint.
- `exception-e2e.test.ts` for scenario assertions and summary metrics.
- `harness.ts` for SQLite setup, issue seeding, workflow loading, runtime event application, repair execution, restart simulation, and metric collection.
- `metrics.ts` for typed metrics, summary formatting, and requirement coverage calculation.

The harness should build on existing runtime boundaries rather than duplicating logic:

- Use `SqliteControlPlaneStore` for durable snapshots/history.
- Use `applyRuntimeEvents` for pure state-machine transitions.
- Use `repairSnapshot` for repair behavior.
- Use workflow fixtures such as `issue-to-pr-release.yaml` and `issue-to-done.yaml`.
- Use fake host/projection/effect inputs only as deterministic event sources.

## Requirement Coverage Model

Exception E2E coverage is scenario/requirement coverage, not line coverage.

The denominator is 14 exception/recovery requirements. The suite passes only when at least 12 are covered:

```text
exception_e2e_requirements_total=14
exception_e2e_requirements_covered>=12
exception_e2e_requirement_coverage_percent>=85
```

Coverage is counted only when a scenario both executes and asserts the required durable behavior. A helper that merely observes a state is not enough.

## E2E Scenario Matrix

| ID | Requirement | Expected Durable Behavior |
| --- | --- | --- |
| EX-01 | Active issue missing valid owner lease is quarantined. | Lifecycle becomes `quarantined`; history contains an `admin_action`; invariant violation is visible. |
| EX-02 | Active issue with expired owner lease is quarantined. | Lifecycle becomes `quarantined`; repair action records lease expiry context. |
| EX-03 | Resume quarantined without a lease is rejected. | Lifecycle remains `quarantined`; result includes `resume_requires_owner_lease`; no active child is started. |
| EX-04 | Resume quarantined with a new lease succeeds. | Lifecycle becomes `running`; new lease fields are persisted; history includes `issue_resumed`. |
| EX-05 | Resume quarantined with host-confirmed live lease succeeds. | Lifecycle becomes `running`; existing live lease is preserved; history includes `issue_resumed`. |
| EX-06 | Resume quarantined with unknown host liveness is rejected. | Lifecycle remains `quarantined`; rejection is auditable and deterministic. |
| EX-07 | Retryable child failure stays active. | Lifecycle remains on the retryable stage; child run status/history is retryable, not terminal. |
| EX-08 | Terminal child failure moves issue to failed. | Lifecycle becomes `failed`; terminal failure history is compact and auditable. |
| EX-09 | Invalid child artifact is rejected. | Lifecycle does not advance; at least one `artifact_rejected` history row is persisted; payload is compact. |
| EX-10 | Verification retryable failure returns to implementation. | Lifecycle returns to implementation/running; retry can start another worker without duplicate child records. |
| EX-11 | Verification terminal failure moves issue to failed. | Lifecycle becomes `failed`; release is not attempted. |
| EX-12 | Projection failure is retryable and non-mutating. | `projection_failed` and retry effect history are persisted; lifecycle does not change. |
| EX-13 | Effect failure after DB commit is retryable. | Snapshot committed before the effect remains committed; failure is recorded as retryable history, not lifecycle failure. |
| EX-14 | Confirmed merge plus local sync failure remains completed. | Lifecycle remains or is repaired to `completed`; local sync failure remains retryable/auditable. |

## Quantitative Acceptance Metrics

The E2E summary must be printed as one compact TAP diagnostic line and backed by assertions.

| Metric | Required Value |
| --- | --- |
| `exception_e2e_requirements_total` | `14` |
| `exception_e2e_requirements_covered` | `>= 12` |
| `exception_e2e_requirement_coverage_percent` | `>= 85` |
| `exception_e2e_scenarios_total` | `>= 8` |
| `exception_e2e_scenarios_passed` | equals total scenarios |
| `exception_e2e_quarantined_cases` | `>= 3` |
| `exception_e2e_failed_cases` | `>= 2` |
| `exception_e2e_recovery_cases` | `>= 3` |
| `exception_e2e_resume_rejections` | `>= 2` |
| `exception_e2e_retryable_failures` | `>= 3` |
| `exception_e2e_terminal_failures` | `>= 2` |
| `exception_e2e_artifact_rejections` | `>= 1` |
| `exception_e2e_repair_admin_actions` | `>= 2` |
| `exception_e2e_duplicate_child_runs` | `0` |
| `exception_e2e_secret_leaks` | `0` |
| `exception_e2e_network_calls` | `0` |
| `exception_e2e_live_credential_reads` | `0` |

## Summary Contract

`npm run test:e2e:exceptions` must expose a diagnostic summary containing at least:

```text
exception_e2e_requirements_total=14
exception_e2e_requirements_covered=12
exception_e2e_requirement_coverage_percent=85
exception_e2e_scenarios_passed=8/8
exception_e2e_quarantined_cases=3
exception_e2e_failed_cases=2
exception_e2e_recovery_cases=3
exception_e2e_retryable_failures=3
exception_e2e_terminal_failures=2
exception_e2e_artifact_rejections=1
exception_e2e_repair_admin_actions=2
exception_e2e_secret_leaks=0
exception_e2e_network_calls=0
exception_e2e_live_credential_reads=0
```

## Failure And Recovery Semantics

The suite should distinguish recoverable and terminal behavior.

- `quarantined` means the issue is paused because runtime invariants are unsafe. It must require explicit resume conditions.
- `failed` means the workflow reached a terminal failure path. Repair must not silently resurrect it unless there is stronger evidence, such as confirmed merge completion.
- Retryable child, projection, and effect failures must create auditable retry information without directly failing the lifecycle.
- Recovery must be explicit: new lease, host-confirmed live lease, repair action, restart reconstruction, or retryable history consumed by a later cycle.

## Test Data Safety

The exception E2E suite must not persist raw logs or secret-shaped values.

- History payloads must stay compact.
- Token-shaped strings must be redacted or rejected before summary output.
- The test should fail if its summary/history includes token-shaped values.
- The test should fail on any network call.

## Verification Gate

The implementation goal must finish with fresh verification:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:full-live
npm run test:e2e:exceptions
node --run northstar -- --help
node --run northstar -- --version
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
git status --short
```

For the forbidden `rg` scans, no matches is the passing result.

## Deferred Work

Live exception E2E remains separate. Future goals may add:

- Real GitHub issue/PR failure and recovery smoke tests.
- Real Codex SDK child interruption and recovery.
- Real OpenCode SDK exception smoke tests.
- Production daemon/OS service packaging failure recovery.
- Code coverage tooling with line/branch thresholds.
