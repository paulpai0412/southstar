# Northstar Domain Driver Registry Implementation Plan

Date: 2026-05-30

Goal: make production orchestration workflow-general through a reusable `DomainDriverRegistry`, extract the live software-development driver shape from E2E into production modules, and route CLI/watch production paths through the shared factory.

## Constraints

- Use TDD for every uncovered behavior: write failing test, confirm RED, implement the smallest change, confirm GREEN.
- Keep `src/runtime/state-machine.ts` pure.
- Keep live tests separate from offline tests; `npm test` must not require network, GitHub token, OpenCode, or Codex credentials.
- Use argv arrays for process commands. Do not introduce shell-chain strings.
- Do not write secrets to repo files, logs, docs, tests, or SQLite history.

## Task 1: Workflow Metadata And Domain Registry

Tests first:

- Add `tests/orchestrator/domain-registry.test.ts`.
- Assert software-development resolution by `workflow.domain`.
- Assert compatibility fallback for `workflow.id === "issue_to_pr_release"`.
- Assert `content_creation` and `office_automation` fail with `DOMAIN_DRIVER_NOT_IMPLEMENTED`.
- Assert unknown domains fail with `DOMAIN_DRIVER_UNKNOWN`.
- Assert registry metrics report at least three registered/recognized domains.

Implementation:

- Add `src/orchestrator/domain-registry.ts`.
- Add explicit `domain: software_development` to issue-to-pr-release workflow fixture while preserving id fallback.
- Ensure deferred domains cannot fall back to software development.

## Task 2: Generalize DomainDriver Contract

Tests first:

- Extend orchestrator tests to call the driver with issue title/body/source URL, workflow id/domain, stage name, role name, role definition, and runtime context.
- Assert generic driver inputs do not require `prNumber` for stage preparation/finalization.
- Assert `FakeDomainDriver` remains deterministic for offline tests.

Implementation:

- Update `src/orchestrator/domain-driver.ts` with workflow-general context types.
- Update `src/orchestrator/cycle.ts` to pass the richer context.
- Preserve existing `PullRequestResult`/`ReleaseResult` as software-development result shapes consumed by the current issue-to-PR flow.

## Task 3: Production SoftwareDevDriver Module

Tests first:

- Add `tests/orchestrator/software-dev-driver.test.ts`.
- Assert prompt rendering includes role `prompt_template`, issue title/body, stage, role, worktree path, branch, and expected artifact fields.
- Assert deterministic default prompt when the workflow omits `prompt_template`.
- Assert branch-exists errors reuse/read the branch.
- Assert malformed/empty worker outputs are rejected and counted.
- Assert retryable service failures return retryable driver errors/results instead of mutating lifecycle.
- Assert generated process command specs are argv arrays and contain no shell-chain strings.

Implementation:

- Add `src/orchestrator/software-dev-driver.ts`.
- Move reusable production boundaries from live E2E:
  - SDK worker interface
  - queued host session bridge
  - software-development driver class
  - prompt builder and output validation
- Keep low-level GitHub/worker implementations injectable so production-live can use real SDK/GitHub clients and offline tests can use deterministic service doubles.

## Task 4: Production Factory And CLI/Watch Routing

Tests first:

- Add/extend `tests/orchestrator/production-factory.test.ts`.
- Assert factory builds a registry and resolves the domain driver.
- Assert manual CLI production path uses the factory/registry.
- Assert watch production path uses the same factory/registry.
- Assert production CLI/watch source no longer instantiates `FakeDomainDriver`.

Implementation:

- Add `src/orchestrator/production-factory.ts`.
- Route `src/cli/entrypoint.ts` and `src/cli/watch-command.ts` through the factory.
- Keep fake drivers only in tests and explicit deterministic offline test wiring.

## Task 5: Production-Live E2E Migration

Tests first:

- Update `tests/e2e-production-live/production-live.test.ts` to import production `SoftwareDevDomainDriver` and `QueuedHostSessionBridge`.
- Remove private test-only `LiveSoftwareDevDomainDriver`, `QueuedLiveHostAdapter`, and duplicated orchestration classes.
- Keep the clear-skip behavior when live env is not configured.

Implementation:

- Wire live OpenCode and Codex workers into the production software-dev driver.
- Preserve real acceptance: GitHub issue, SDK child sessions, branch/PR, merge, completed runtime lifecycle, GitHub issue closed.

## Task 6: Coverage Matrix And Final Verification

Tests/verification:

- Update or create the domain-driver registry coverage matrix with every requirement mapped to tests and implementation files.
- Run all final gates from the goal:
  - `npm test`
  - `npm run test:e2e`
  - `npm run test:e2e:daemon`
  - `npm run test:e2e:exceptions`
  - `npm run test:coverage`
  - `npm run test:e2e:production-live` without live flag
  - live production E2E with `NORTHSTAR_PRODUCTION_LIVE=1`
  - CLI help/version smoke
  - source scans
  - `git status --short`

Acceptance metrics:

- `domain_registry_registered_domains >= 3`
- `domain_registry_software_dev_resolved = 1`
- `domain_registry_content_creation_deferred = 1`
- `domain_registry_office_automation_deferred = 1`
- `domain_registry_unknown_domain_errors >= 1`
- `production_cli_uses_registry = 1`
- `production_watch_uses_registry = 1`
- `production_paths_fake_domain_driver_usages = 0`
- `software_dev_branch_reuse_cases >= 1`
- `software_dev_retryable_effect_failures >= 1`
- `software_dev_malformed_artifacts_rejected >= 1`
- `software_dev_completed_reversals = 0`
- `software_dev_driver_live_completed >= 2`
- `software_dev_driver_secret_leaks = 0`
- `software_dev_driver_shell_fallbacks = 0`
