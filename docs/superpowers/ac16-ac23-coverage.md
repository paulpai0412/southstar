# Northstar AC-16 Through AC-23 Coverage Matrix

| AC | Requirement | Tests | Implementation |
| --- | --- | --- | --- |
| AC-16 | Workflow validation rejects invalid fixtures with stable machine-readable error codes. | `tests/workflow/workflow-validation.test.ts`, `tests/fixtures/workflows/invalid/*.yaml` | `src/types/workflow.ts`, `src/types/workflow-validation.ts` |
| AC-17 | Artifact schemas validate worker, evidence, and release payloads and reject invalid/raw-log artifacts with auditable rejection history. | `tests/runtime/artifacts.test.ts`, `tests/runtime/state-machine.test.ts` | `src/runtime/artifacts.ts`, `src/runtime/state-machine.ts` |
| AC-18 | GitHub and local seeded intake normalize issue packets and idempotently upsert issue snapshots with history facts. | `tests/intake/intake.test.ts` | `src/intake/types.ts`, `src/intake/local.ts`, `src/intake/github.ts`, `src/runtime/store.ts` |
| AC-19 | Watch loop reconstructs from durable state each cycle, handles shutdown, and enforces a single writer abstraction. | `tests/runtime/watch.test.ts`, `tests/cli/cli.test.ts` | `src/runtime/watch.ts`, `src/cli/northstar.ts` |
| AC-20 | Runtime redacts token-shaped values, rejects raw logs, and resolves credentials through fake-testable providers. | `tests/runtime/security.test.ts` | `src/runtime/redaction.ts`, `src/runtime/credentials.ts`, `src/adapters/github/remote.ts`, `src/runtime/inspect.ts` |
| AC-21 | Package metadata exposes the CLI binary, Node range, help output, version output, and local pack smoke. | `tests/cli/packaging.test.ts` | `package.json`, `src/cli/entrypoint.ts`, `src/cli/northstar.ts` |
| AC-22 | Planning documents map AC-01 through AC-23 to milestones and verification commands. | `tests/spec/spec-compliance.test.ts` | `docs/superpowers/full-ac-coverage.md`, `docs/superpowers/ac16-ac23-coverage.md` |
| AC-23 | Domain-general workflow fixtures validate content creation and office automation without adding lifecycle states or coding role chains. | `tests/workflow/domain-workflow.test.ts`, `tests/runtime/state-machine.test.ts` | `src/types/workflow.ts`, `src/runtime/state-machine.ts`, `tests/fixtures/workflows/content-creation-publish.yaml`, `tests/fixtures/workflows/office-report-delivery.yaml` |
