# Northstar Full Acceptance Coverage Matrix

| AC | Requirement | Tests | Implementation |
| --- | --- | --- | --- |
| AC-01 | Project bootstrap and old Python runtime exclusion. | `tests/spec/spec-compliance.test.ts` | `package.json`, `src/**` |
| AC-02 | Config loading, schema validation, and env guardrails. | `tests/config/load-config.test.ts` | `src/config/load-config.ts`, `src/config/schema.ts` |
| AC-03 | SQLite store tables, transactions, rollback, and idempotent records. | `tests/runtime/store.test.ts` | `src/runtime/store.ts` |
| AC-04 | Workflow generality without hard-coded release chain. | `tests/workflow/workflow.test.ts` | `src/types/workflow.ts`, `src/runtime/engine.ts` |
| AC-05 | Role overrides and host adapter role payloads. | `tests/workflow/workflow.test.ts`, `tests/adapters/adapters.test.ts` | `src/types/workflow.ts`, `src/adapters/host/*.ts` |
| AC-06 | Owner lease invariants and quarantined resume rules. | `tests/runtime/state-machine.test.ts` | `src/runtime/state-machine.ts` |
| AC-07 | Heartbeat sequencing, timestamps, expiry, and liveness cases. | `tests/runtime/state-machine.test.ts` | `src/runtime/state-machine.ts` |
| AC-08 | Background child runs and artifact-driven advancement. | `tests/runtime/state-machine.test.ts`, `tests/adapters/adapters.test.ts` | `src/runtime/state-machine.ts`, `src/adapters/host/fake.ts` |
| AC-09 | GitHub projection retryable failure semantics. | `tests/adapters/adapters.test.ts`, `tests/runtime/engine-cycle.test.ts` | `src/adapters/github/projector.ts`, `src/adapters/github/remote.ts` |
| AC-10 | Release semantics and retryable sync/cleanup failures. | `tests/runtime/state-machine.test.ts`, `tests/adapters/adapters.test.ts` | `src/runtime/state-machine.ts`, `src/adapters/git/worktrees.ts` |
| AC-11 | Dedicated sync worktree planning and root checkout prevention. | `tests/adapters/adapters.test.ts` | `src/adapters/git/worktrees.ts` |
| AC-12 | Cross-platform paths and argv process specs. | `tests/adapters/adapters.test.ts`, `tests/spec/spec-compliance.test.ts` | `src/adapters/platform/paths.ts`, `src/adapters/platform/process.ts` |
| AC-13 | Runtime repair normalizes stale leases/projections and writes admin history. | `tests/runtime/repair-inspect.test.ts` | `src/runtime/repair.ts` |
| AC-14 | Inspect separates lifecycle, lease, child runs, and projection sync. | `tests/runtime/repair-inspect.test.ts` | `src/runtime/inspect.ts` |
| AC-15 | Test gate and source/test coverage. | `tests/index.test.ts`, `tests/spec/spec-compliance.test.ts` | `tests/**`, `docs/superpowers/*.md` |
| AC-16 | Workflow schema invalid fixtures and stable error codes. | `tests/workflow/workflow-validation.test.ts` | `src/types/workflow.ts`, `src/types/workflow-validation.ts` |
| AC-17 | Artifact schemas and artifact rejection history. | `tests/runtime/artifacts.test.ts`, `tests/runtime/state-machine.test.ts` | `src/runtime/artifacts.ts`, `src/runtime/state-machine.ts` |
| AC-18 | GitHub/local intake and idempotent intake facts. | `tests/intake/intake.test.ts` | `src/intake/*.ts`, `src/runtime/store.ts` |
| AC-19 | Watch loop restart/shutdown/writer behavior. | `tests/runtime/watch.test.ts`, `tests/cli/cli.test.ts` | `src/runtime/watch.ts`, `src/cli/northstar.ts` |
| AC-20 | Security redaction, raw log rejection, fake credential providers. | `tests/runtime/security.test.ts` | `src/runtime/redaction.ts`, `src/runtime/credentials.ts` |
| AC-21 | CLI binary, Node range, version/help, local pack smoke. | `tests/cli/packaging.test.ts` | `package.json`, `src/cli/entrypoint.ts`, `src/cli/northstar.ts` |
| AC-22 | Planning document maps AC-01 through AC-23 to implementation and verification. | `tests/spec/spec-compliance.test.ts` | `docs/superpowers/full-ac-coverage.md`, `docs/superpowers/ac16-ac23-coverage.md` |
| AC-23 | Workflow domain generality for content creation and office automation. | `tests/workflow/domain-workflow.test.ts`, `tests/runtime/state-machine.test.ts` | `src/types/workflow.ts`, `src/runtime/state-machine.ts`, `tests/fixtures/workflows/content-creation-publish.yaml`, `tests/fixtures/workflows/office-report-delivery.yaml` |
