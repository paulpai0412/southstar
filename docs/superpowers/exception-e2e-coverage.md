# Northstar Exception E2E Coverage Matrix

| ID | Requirement | Test File | Harness/Implementation File |
| --- | --- | --- | --- |
| EX-01 | Active issue missing valid owner lease is quarantined. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/repair.ts`, `src/runtime/state-machine.ts` |
| EX-02 | Active issue with expired owner lease is quarantined. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/repair.ts`, `src/runtime/state-machine.ts` |
| EX-03 | Resume quarantined without a lease is rejected. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-04 | Resume quarantined with a new lease succeeds. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-05 | Resume quarantined with host-confirmed live lease succeeds. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-06 | Resume quarantined with unknown host liveness is rejected. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-07 | Retryable child failure stays active. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-08 | Terminal child failure moves issue to failed. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-09 | Invalid child artifact is rejected without lifecycle advance. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/artifacts.ts`, `src/runtime/state-machine.ts` |
| EX-10 | Verification retryable failure returns to implementation. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-11 | Verification terminal failure moves issue to failed. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-12 | Projection failure is retryable and non-mutating. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-13 | Effect failure after DB commit is retryable. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts`, `src/runtime/engine.ts` |
| EX-14 | Confirmed merge plus local sync failure remains completed. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/repair.ts`, `src/runtime/state-machine.ts` |

## Quantified Gate

`npm run test:e2e:exceptions` asserts:

- `exception_e2e_requirements_total=14`
- `exception_e2e_requirements_covered>=12`
- `exception_e2e_requirement_coverage_percent>=85`
- `exception_e2e_scenarios_total>=8`
- `exception_e2e_scenarios_passed=exception_e2e_scenarios_total`
- `exception_e2e_quarantined_cases>=3`
- `exception_e2e_failed_cases>=2`
- `exception_e2e_recovery_cases>=3`
- `exception_e2e_resume_rejections>=2`
- `exception_e2e_retryable_failures>=3`
- `exception_e2e_terminal_failures>=2`
- `exception_e2e_artifact_rejections>=1`
- `exception_e2e_repair_admin_actions>=2`
- `exception_e2e_duplicate_child_runs=0`
- `exception_e2e_secret_leaks=0`
- `exception_e2e_network_calls=0`
- `exception_e2e_live_credential_reads=0`

## Runtime Boundaries

The deterministic suite lives under `tests/e2e-exceptions/`:

- `tests/e2e-exceptions/index.test.ts` wires the isolated command.
- `tests/e2e-exceptions/exception-e2e.test.ts` owns quantified acceptance assertions.
- `tests/e2e-exceptions/harness.ts` creates an offline SQLite-backed issue execution harness.
- `tests/e2e-exceptions/metrics.ts` owns coverage math, summary formatting, and secret scan helpers.

The suite does not require network, GitHub tokens, OpenCode/Codex credentials, or host CLIs.
