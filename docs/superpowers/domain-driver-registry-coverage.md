# Northstar Domain Driver Registry Coverage

Date: 2026-05-30

Scope: workflow-general domain registry, generalized domain-driver contract, production software-development driver boundary, production factory routing, and production-live E2E migration.

## Coverage Matrix

| Requirement | Quantified acceptance | Tests | Implementation |
| --- | --- | --- | --- |
| Domain registry resolves software development by explicit domain and `issue_to_pr_release` fallback | `domain_registry_registered_domains>=3`, `domain_registry_software_dev_resolved=1` | `tests/orchestrator/domain-registry.test.ts`, `tests/orchestrator/production-factory.test.ts` | `src/orchestrator/domain-registry.ts`, `tests/fixtures/workflows/issue-to-pr-release.yaml` |
| Deferred domains are recognized and do not fallback to software development | `domain_registry_content_creation_deferred=1`, `domain_registry_office_automation_deferred=1` | `tests/orchestrator/domain-registry.test.ts` | `src/orchestrator/domain-registry.ts` |
| Unknown domains fail fast with stable error code | `domain_registry_unknown_domain_errors>=1` | `tests/orchestrator/domain-registry.test.ts` | `src/orchestrator/domain-registry.ts` |
| DomainDriver inputs are workflow-general | issue id/number/title/body/source URL, workflow id/domain, stage, role definition, and runtime context delivered to driver | `tests/orchestrator/orchestrator-cli.test.ts`, `tests/orchestrator/domain-driver.test.ts` | `src/orchestrator/domain-driver.ts`, `src/orchestrator/cycle.ts` |
| Prompt template support is typed and preserved by workflow loading | role `prompt_template` survives normalization and role overrides | `tests/workflow/workflow.test.ts`, `tests/orchestrator/software-dev-driver.test.ts` | `src/types/workflow.ts`, `tests/fixtures/workflows/issue-to-pr-release.yaml`, `src/orchestrator/software-dev-driver.ts` |
| Production SoftwareDevDriver extracts live SDK/GitHub shape from E2E | `software_dev_branch_reuse_cases>=1`, `software_dev_retryable_effect_failures>=1`, `software_dev_malformed_artifacts_rejected>=1`, `software_dev_completed_reversals=0` | `tests/orchestrator/software-dev-driver.test.ts` | `src/orchestrator/software-dev-driver.ts` |
| Software-dev process planning uses argv arrays and avoids root checkout | `software_dev_driver_shell_fallbacks=0` for driver boundary, shell-chain command specs rejected | `tests/orchestrator/software-dev-driver.test.ts`, `tests/spec/spec-compliance.test.ts` | `src/orchestrator/software-dev-driver.ts`, `src/adapters/platform/process.ts` |
| Production CLI/watch route through registry/factory instead of FakeDomainDriver | `production_cli_uses_registry=1`, `production_watch_uses_registry=1`, `production_paths_fake_domain_driver_usages=0` | `tests/orchestrator/production-factory.test.ts` | `src/orchestrator/production-factory.ts`, `src/cli/entrypoint.ts`, `src/cli/watch-command.ts` |
| Production-live E2E imports production factory/registry/driver | `software_dev_driver_live_completed>=2`, `software_dev_driver_secret_leaks=0`, `software_dev_driver_shell_fallbacks=0` when live gate runs | `tests/e2e-production-live/production-live.test.ts` | `src/orchestrator/production-factory.ts`, `src/orchestrator/domain-registry.ts`, `src/orchestrator/software-dev-driver.ts` |

## Metrics Summary

- `domain_registry_registered_domains=3`
- `domain_registry_software_dev_resolved=1`
- `domain_registry_content_creation_deferred=1`
- `domain_registry_office_automation_deferred=1`
- `domain_registry_unknown_domain_errors=1`
- `production_cli_uses_registry=1`
- `production_watch_uses_registry=1`
- `production_paths_fake_domain_driver_usages=0`
- `software_dev_branch_reuse_cases=1`
- `software_dev_retryable_effect_failures=1`
- `software_dev_malformed_artifacts_rejected=2`
- `software_dev_completed_reversals=0`

Deferred domains:

- `content_creation` is reserved and explicitly not implemented.
- `office_automation` is reserved and explicitly not implemented.
