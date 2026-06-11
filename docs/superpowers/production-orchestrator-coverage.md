# Northstar Production Orchestrator Coverage

Date: 2026-05-30

Scope: production orchestrator, manual CLI command path, watch command integration, dependency scheduling, workflow generality, recovery metrics, and the separated production-live E2E gate.

## Coverage Matrix

| Area | Quantified acceptance | Tests | Implementation |
| --- | --- | --- | --- |
| Manual CLI | `manual_cli_completed_issues>=1`, `manual_cli_prs_merged>=1`, `manual_cli_inspect_fields_present>=8`, `manual_cli_secret_leaks=0`, `manual_cli_shell_fallbacks=0` | `tests/orchestrator/orchestrator-cli.test.ts`, `tests/cli/manual-orchestrator-cli.test.ts` | `src/orchestrator/cycle.ts`, `src/orchestrator/issue-flow.ts`, `src/orchestrator/inspect.ts`, `src/cli/entrypoint.ts` |
| Watch daemon | `watch_cycles_completed>=1` per cycle, active issue and recent history reconstruction exposed in cycle output | `tests/orchestrator/watch-orchestrator.test.ts`, `tests/e2e-daemon/daemon-e2e.test.ts` | `src/orchestrator/cycle.ts`, `src/cli/watch-command.ts` |
| Dependency scheduling | `scheduler_dependency_order_violations=0`, cycle and missing dependency detection | `tests/orchestrator/dependencies.test.ts`, `tests/orchestrator/scheduler.test.ts` | `src/orchestrator/dependencies.ts`, `src/orchestrator/scheduler.ts` |
| Workflow generality | `workflow_generality_hardcoded_role_chain_matches=0`, `workflow_generality_hardcoded_release_merge_matches=0`; content workflow first stage starts as `writer` | `tests/orchestrator/workflow-generality.test.ts` | `src/orchestrator/cycle.ts`, `src/orchestrator/host-dispatch.ts`, `src/runtime/state-machine.ts` |
| Stage root dispatch | stage-root host binding records root session, lease, role, child run, and role overrides | `tests/orchestrator/host-dispatch.test.ts` | `src/orchestrator/host-dispatch.ts`, `src/orchestrator/issue-flow.ts` |
| Recovery metrics | `orchestrator_quarantined_detected>=1`, `orchestrator_resume_attempts>=1`, `orchestrator_retryable_effects_recorded>=1`, `orchestrator_terminal_failures_recorded>=1`, `orchestrator_completed_reversals=0` | `tests/orchestrator/error-recovery.test.ts` | `src/orchestrator/metrics.ts` |
| Production live | `production_live_completed>=3`, `production_live_opencode_runs_completed>=1`, `production_live_codex_runs_completed>=1`, `production_live_pi_runs_completed>=1`, `production_live_secret_leaks=0`, `production_live_shell_fallbacks=0`; live gate covers OpenCode/Codex/Pi, is isolated from `npm test`, and clear-skips without `NORTHSTAR_PRODUCTION_LIVE=1` | `tests/e2e-production-live/production-live.test.ts` | `src/orchestrator/cycle.ts`, `src/orchestrator/domain-driver.ts`, `src/orchestrator/domain-registry.ts`, `src/orchestrator/production-factory.ts`, `src/orchestrator/software-dev-driver.ts`, `src/adapters/host/pi-worker.ts` |
| Pi host capability path | `runtime.host_adapter: pi`, role-level host overrides, role metadata propagation, and optional capability reports are covered by unit tests. MCP is represented as capability vocabulary only and has no first-implementation application path. | `tests/config/load-config.test.ts`, `tests/adapters/host-worker-factory.test.ts`, `tests/adapters/sdk-workers.test.ts`, `tests/orchestrator/production-dependencies.test.ts` | `src/adapters/host/capabilities.ts`, `src/adapters/host/pi-worker.ts`, `src/orchestrator/production-dependencies.ts` |
| Domain driver registry | `domain_registry_registered_domains>=3`, deferred domains fail with `DOMAIN_DRIVER_NOT_IMPLEMENTED`, unknown domains fail with `DOMAIN_DRIVER_UNKNOWN` | `tests/orchestrator/domain-registry.test.ts` | `src/orchestrator/domain-registry.ts` |
| Production factory | `production_cli_uses_registry=1`, `production_watch_uses_registry=1`, `production_paths_fake_domain_driver_usages=0` | `tests/orchestrator/production-factory.test.ts` | `src/orchestrator/production-factory.ts`, `src/cli/entrypoint.ts`, `src/cli/watch-command.ts` |

## Requirement Coverage

`production_orchestrator_requirement_coverage_percent=91`

Mapped requirements:

- Manual CLI supports `intake`, `start`, `reconcile`, `release`, and `inspect` through the shared production orchestrator.
- Watch uses the same orchestrator runner rather than a separate orchestration implementation.
- Dependency scheduling parses dependencies and enforces dependency-before-dependent ordering.
- Runtime state-machine remains pure and does not depend on filesystem, SQLite, GitHub, host SDK, or shell.
- Stage dispatch resolves roles from workflow stages and supports non-software workflows.
- Release lease role is derived from the workflow release stage rather than a fixed role name.
- Recovery metrics quantify quarantine, resume, retryable effects, terminal failures, and completed reversal guards.
- Production-live E2E is separated from offline tests and never runs from `npm test`.
- Production-live E2E clear-skips without live flags and uses the production registry/factory/software-development driver when live flags are present.
- Source scans verify no hard-coded `issue_worker -> pr_verifier -> release_worker` chain and no explicit release-equals-GitHub-merge coupling in orchestrator source.

Deferred requirement:

- Real `content_creation` and `office_automation` domain drivers remain deferred; the registry reserves both domains and fails explicitly until those drivers are implemented.
