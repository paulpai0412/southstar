# Northstar Domain Driver Registry Design

Date: 2026-05-30

## Goal

Make production orchestration workflow-general by introducing a reusable `DomainDriverRegistry`.

The registry lets Northstar select a domain-specific driver from workflow metadata instead of hard-wiring software-development behavior into the production orchestrator or E2E harness. The first real production driver remains software development, while content creation and office automation are recognized as future domains with explicit deferred behavior.

## Current Context

Northstar already has:

- A pure runtime state machine in `src/runtime/state-machine.ts`.
- A shared production orchestrator in `src/orchestrator/cycle.ts`.
- A generic `DomainDriver` interface and deterministic `FakeDomainDriver` in `src/orchestrator/domain-driver.ts`.
- Workflow fixtures for software development, content creation, and office automation.
- A production-live E2E test that proves GitHub + OpenCode + Codex can complete two real issue-to-release flows.

The remaining gap is that the production-live software-development shape still lives inside `tests/e2e-production-live/production-live.test.ts` as test-local classes:

- `LiveSoftwareDevDomainDriver`
- `QueuedLiveHostAdapter`
- `LiveWorker`

Those classes should become production boundaries so CLI/watch can call them outside the E2E gate.

## Architecture

Add a workflow-general domain-driver layer:

```text
src/orchestrator/
  domain-driver.ts
  domain-registry.ts
  production-factory.ts
  software-dev-driver.ts
```

### `domain-driver.ts`

Keep `DomainDriver` as the orchestrator-facing contract, but evolve inputs so they are workflow-general:

- `issueId`
- issue number/title/body/source URL
- workflow id/domain
- stage name
- role name
- role definition
- runtime context

The interface must not expose software-development-only fields such as `prNumber` as generic requirements. Software-development-specific details live in `software-dev-driver.ts`.

### `domain-registry.ts`

Define a `DomainDriverRegistry` with:

- `register(domain, factory)`
- `resolve({ workflow, config, dependencies })`
- stable error codes:
  - `DOMAIN_DRIVER_UNKNOWN`
  - `DOMAIN_DRIVER_NOT_IMPLEMENTED`
  - `DOMAIN_DRIVER_CONFIG_INVALID`

Resolution rules:

- `workflow.domain === "software_development"` resolves to `SoftwareDevDomainDriver`.
- `workflow.id === "issue_to_pr_release"` also resolves to software development as a compatibility fallback.
- `workflow.domain === "content_creation"` is recognized but deferred.
- `workflow.domain === "office_automation"` is recognized but deferred.
- Unknown domains fail fast with `DOMAIN_DRIVER_UNKNOWN`.

Deferred domains must not silently use software-dev behavior.

### `software-dev-driver.ts`

Implement the first production `DomainDriver`:

- Prepare local issue worktree and branch outside the consumer root worktree.
- Build SDK worker prompts from workflow role `prompt_template` plus issue title/body and branch/worktree context.
- Run OpenCode or Codex through SDK-first host/worker boundaries.
- Detect changed files in the issue worktree.
- Commit and push via argv-array git operations.
- Create or reuse a GitHub PR.
- Merge the PR during release and require confirmed merge before returning success.
- Close the GitHub issue after confirmed completion.

Branch reuse is required: if the worker or a previous attempt already created the branch, the driver must reuse/read it instead of failing on "reference already exists".

The implementation must add `prompt_template` to the normalized workflow role type if it is not already exposed as a typed field. Workflows may omit `prompt_template`; in that case the software-dev driver uses a deterministic default template that includes issue title, issue body, stage name, role name, worktree path, branch, and expected artifact fields.

### Workflow metadata

The `issue_to_pr_release` workflow should explicitly declare `domain: software_development`. The registry still supports `workflow.id === "issue_to_pr_release"` as a compatibility fallback so existing fixtures and user configs fail softly during migration.

### `production-factory.ts`

Create the production object graph used by both manual CLI and `northstar watch`:

```text
config + workflow
  -> HostAdapter
  -> DomainDriverRegistry
  -> resolved DomainDriver
  -> ProductionOrchestrator
```

Manual CLI and watch must call this factory. They must not instantiate fake drivers in production paths.

## Data Flow

1. CLI/watch loads `.northstar.yaml` and workflow YAML.
2. `ProductionOrchestratorFactory` creates the store, host adapter, registry, and resolved domain driver.
3. `DomainDriverRegistry.resolve()` picks the driver from workflow domain/id.
4. `startIssue()` resolves the first workflow stage and role, then calls `domain.prepareStage(context)`.
5. The software-dev driver prepares worktree/branch and runs the implementation worker with a prompt assembled from workflow role config and issue data.
6. The orchestrator starts the root session and child run, then records owner lease and child-run history through the pure state machine.
7. `reconcileIssue()` calls the software-dev driver to finalize the stage: commit/push, create/reuse PR, and prepare verifier work.
8. Verification uses the workflow verification role prompt and records evidence through the state machine.
9. `releaseIssue()` calls the software-dev driver to merge the PR and close the issue.
10. Confirmed merge facts transition the runtime lifecycle to `completed`.

`runtime.auto_release: true` means watch may automatically release verified software-development issues. Manual `northstar release` performs release directly without an extra confirmation prompt.

## Error Handling

Registry errors:

- Missing or unknown domain fails before orchestration begins.
- Deferred domains fail clearly with `DOMAIN_DRIVER_NOT_IMPLEMENTED`.
- Invalid driver configuration fails with `DOMAIN_DRIVER_CONFIG_INVALID`.

Software-development retryable errors:

- Worktree create/reuse failure.
- Dirty or ambiguous worktree state.
- No changed files when a worker claims success.
- Commit/push failure.
- Branch already exists but cannot be read.
- PR create/reuse failure.
- Merge blocked or not confirmed.

Retryable errors become compact history/effect facts and must not directly mutate lifecycle to `failed`.

Terminal errors:

- Malformed worker artifact is rejected and audited.
- Verifier terminal failure follows the workflow transition to `failed`.
- Release success without confirmed merge is rejected.
- Completed lifecycle must not be reversed by cleanup or local sync failures.

## Testing Strategy

Unit and offline tests:

- `tests/orchestrator/domain-registry.test.ts`
  - registers and resolves software development
  - recognizes deferred content creation and office automation
  - rejects unknown domains with stable error code
- `tests/orchestrator/production-factory.test.ts`
  - proves manual CLI and watch use the same factory and registry
  - proves production paths do not instantiate `FakeDomainDriver`
- `tests/orchestrator/software-dev-driver.test.ts`
  - worktree/branch/commit/push/PR/merge sequencing
  - branch already exists reuse
  - prompt includes workflow `prompt_template` and issue body
  - all process commands are argv arrays
  - retryable driver failures are represented as retryable results

Production-live E2E:

- `tests/e2e-production-live/production-live.test.ts` imports the production registry/factory/driver.
- The test no longer owns private `LiveSoftwareDevDomainDriver` or `QueuedLiveHostAdapter` classes.
- It still runs two live flows:
  - one OpenCode-backed production software-dev flow
  - one Codex-backed production software-dev flow

Final verification:

- `npm test`
- `npm run test:e2e`
- `npm run test:e2e:daemon`
- `npm run test:e2e:exceptions`
- `npm run test:coverage`
- `npm run test:e2e:production-live` without live flag must clear-skip
- `GITHUB_TOKEN="$(gh auth token)" NORTHSTAR_PRODUCTION_LIVE=1 NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:production-live`
- source scans for shell chains, direct runtime env reads, autodev/Python dependencies, and state-machine impurity
- `git status --short`

## Quantified Acceptance

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

## Deferred Work

This design intentionally defers real content creation and office automation drivers. The registry must reserve and validate their domains, but their production behavior should be implemented in later goals with separate specs and E2E cases.
