# Northstar Offline E2E Test Design

- Date: 2026-05-29
- Status: proposed
- Scope: deterministic offline end-to-end tests for Northstar runtime behavior
- Out of scope: real GitHub network calls, real OpenCode/Codex SDK sessions, live credentials, remote repository mutation

## Purpose

Northstar has unit and smoke coverage for runtime core, store, engine, adapters, CLI packaging, and domain-general workflows. The next validation layer is an offline E2E suite that proves the implemented pieces work together as a complete durable workflow system without relying on network access or credentials.

The offline E2E suite must answer one question with quantitative evidence:

> Can Northstar drive multiple workflow families from seeded work through durable runtime state, child artifacts, verification/delivery gates, audit history, recovery behavior, and terminal completion using only deterministic local dependencies?

## Test Mode

The first E2E phase is offline and deterministic.

- It must not call GitHub, OpenCode, Codex, shell-host CLIs, or any external service.
- It must use SQLite temp databases, local workflow fixtures, fake/injected host adapters, fake projection/effect executors, and local issue packets.
- It must be run as `npm run test:e2e`.
- It must not depend on `GITHUB_TOKEN`, `NORTHSTAR_LIVE_*`, OpenCode credentials, Codex credentials, or network availability.
- It must be separate from `npm test` for the first implementation to keep the unit suite fast. The final verification gate for the E2E goal must run both `npm test` and `npm run test:e2e`.

## Recommended Architecture

Use a small reusable E2E harness rather than writing each scenario directly against low-level runtime functions.

The harness must expose or provide equivalent test-facing helpers for:

- `createOfflineE2EHarness(options)` to create a temp SQLite store, load a workflow fixture, inject fake host/effect/projection adapters, and track summary metrics.
- `seedIssuePacket(packet)` or an equivalent helper to simulate intake through existing store/intake paths.
- `startIssue(issueId)` to claim a lease and start the first background child run.
- `submitChildArtifact(input)` to drive validated child artifacts through the state machine.
- `submitGateResult(input)` for verification/manual gate events.
- `submitReleaseOrDeliveryResult(input)` for confirmed merge or domain delivery completion.
- `restart()` to close/reopen the store and recreate the engine/harness from durable state.
- `summary()` to return quantitative metrics used by test assertions and printed output.

The harness must be test-only code under `tests/e2e/` unless implementation code needs a small production helper that is also useful to CLI/runtime execution.

## E2E Cases

### Case 1: Coding Release Full Cycle

Workflow: `tests/fixtures/workflows/issue-to-pr-release.yaml`

Path:

1. Seed a ready issue through local intake/store.
2. Start issue and acquire owner lease.
3. Start implementation child run.
4. Submit valid `worker_result` artifact.
5. Advance to verification.
6. Submit valid `evidence_packet` pass.
7. Enter `verified`.
8. Acquire or confirm release owner lease.
9. Enter `release_pending`.
10. Submit valid `release_result` with confirmed PR merge.
11. End in `completed`.

Assertions:

- Final lifecycle is `completed`.
- Completion requires confirmed merge evidence.
- At least two child run records exist.
- Child run records include lease/root/session/artifact binding fields.
- History contains owner lease, child artifact, verification, release, and confirmed merge facts.
- A retryable projection failure can be recorded without changing lifecycle.
- A cleanup/local sync failure after `completed` does not reverse completion.

### Case 2: Coding No-Release Full Cycle

Workflow: `tests/fixtures/workflows/issue-to-done.yaml`

Path:

1. Seed a ready issue.
2. Start issue.
3. Submit implementation child artifact.
4. Submit verification gate pass.
5. End directly in `completed` without `release_pending`.

Assertions:

- Final lifecycle is `completed`.
- No release stage is required.
- No hard-coded `issue_worker -> pr_verifier -> release_worker` chain is required to complete.

### Case 3: Content Creation Publish Full Cycle

Workflow: `tests/fixtures/workflows/content-creation-publish.yaml`

Path:

1. Seed content creation work.
2. Drive draft, editorial review, approval, and publish/delivery stages using workflow-defined artifact kinds.
3. Confirm publish delivery effect.
4. End in `completed`.

Assertions:

- Final lifecycle is `completed`.
- Domain stage names, role names, artifact kinds, effect kinds, and projection targets are accepted.
- Core lifecycle states remain fixed; domain-specific lifecycle states are not introduced.
- The scenario does not reference coding-only role names.

### Case 4: Office Report Delivery Full Cycle

Workflow: `tests/fixtures/workflows/office-report-delivery.yaml`

Path:

1. Seed report delivery work.
2. Drive data collection, report assembly, manager review, and email delivery stages using workflow-defined artifacts.
3. Confirm email/document delivery effect.
4. End in `completed`.

Assertions:

- Final lifecycle is `completed`.
- Report/review/email delivery facts are auditable in compact history.
- The scenario proves office automation can use the same runtime lifecycle and event model.

### Case 5: Restart And Recovery

Workflow: `issue_to_pr_release`.

Path:

1. Seed and start an issue.
2. Drive it to an intermediate active state.
3. Close and reopen the SQLite store.
4. Recreate the engine/harness.
5. Continue from durable snapshot/history to `completed`.

Assertions:

- Recovery completes after restart.
- History sequence remains monotonic.
- Active issue state is reconstructed from SQLite, not in-memory process state.
- Watch-loop style cycle can observe durable active work without duplicating child runs.

### Case 6: Invalid Artifact Negative Path

Workflow: `issue_to_pr_release` or a domain workflow.

Path:

1. Start a workflow.
2. Submit an invalid artifact payload for the current stage.
3. Continue with a valid artifact afterward if needed.

Assertions:

- Invalid artifact creates at least one `artifact_rejected` history row.
- Lifecycle does not advance because of the invalid artifact.
- Rejection is compact and auditable.
- No raw logs or secret-shaped values are persisted.

## Quantitative Acceptance Metrics

The E2E suite is accepted only when all of these metrics are met:

| Metric | Required Value |
| --- | --- |
| Successful full-cycle workflows | `4/4` |
| Total E2E scenarios | `>= 6` |
| Scenarios passed | `all` |
| Restart/recovery scenarios | `>= 1` |
| Invalid artifact negative scenarios | `>= 1` |
| Successful workflows ending in `completed` | `4/4` |
| Lifecycle states observed | `>= 8` of 9 core states |
| New domain lifecycle states introduced | `0` |
| Network calls | `0` |
| GitHub/OpenCode/Codex live credential reads | `0` |
| Coding release owner leases | `>= 1` |
| Coding release child run records | `>= 2` |
| Coding release valid child artifacts | `>= 2` |
| Coding release confirmed merge facts | `>= 1` |
| Artifact rejection history rows | `>= 1` |
| Retryable projection failures that do not mutate lifecycle | `>= 1` |
| Retryable effect failures that do not fail lifecycle | `>= 1` |
| Cleanup/local sync failures after completed that preserve completed | `>= 1` |
| Domain full-cycle workflows | `>= 2` |
| Domain workflows containing coding-only role chain | `0` |

## E2E Summary Contract

`npm run test:e2e` must print or expose a compact summary that includes at least these fields:

```text
workflows_completed=4/4
scenarios_passed=6/6
network_calls=0
lifecycle_states_observed=<number>
artifact_rejections=<number>
restart_recovery_completed=1
domain_workflows_completed=2
confirmed_merge_facts=<number>
retryable_projection_failures=<number>
retryable_effect_failures=<number>
post_completion_cleanup_failures_preserved=<number>
```

The implementation must print these fields as one TAP diagnostic summary line. Tests must assert the underlying numbers; the summary is for human and CI readability and must not replace assertions.

## Verification Gate

The E2E implementation goal must finish with fresh verification:

```bash
npm test
npm run test:e2e
node --run northstar -- --help
node --run northstar -- --version
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(&&|\\|\\||;)" src/adapters src/runtime src/cli
git status --short
```

For the three forbidden `rg` scans, no matches is the passing result.

## Deferred Work

Live E2E remains a separate phase. It must build on the offline E2E harness only after deterministic E2E is green.

Deferred live cases include:

- Real GitHub temporary issue/project/label/comment/close flow.
- Real OpenCode SDK session smoke.
- Real Codex SDK session smoke.
- Cross-process daemon supervision under a real watch command.
