# Northstar Full Live Exception E2E Coverage Matrix

| ID | Requirement | EX Mapping | Test File | Implementation File |
| --- | --- | --- | --- | --- |
| FLX-01 | GitHub projection failure is retryable and lifecycle-neutral. | EX-12 | `tests/e2e-full-live-exceptions/github-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts`, `tests/e2e-full-live-exceptions/github-faults.ts` |
| FLX-02 | Missing GitHub Project v2 env fails project live case clearly. | EX-12 | `tests/e2e-full-live-exceptions/github-exceptions.test.ts` | `tests/e2e-full-live-exceptions/env.ts`, `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-03 | Issue close failure records retryable cleanup failure. | EX-13 | `tests/e2e-full-live-exceptions/github-exceptions.test.ts` | `tests/e2e-full-live-exceptions/cleanup.ts`, `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-04 | PR create failure records retryable pre-release failure. | EX-13 | `tests/e2e-full-live-exceptions/github-exceptions.test.ts` | `tests/e2e-full-live-exceptions/github-faults.ts`, `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-05 | Real merge conflict is produced by two live PRs touching one path. | EX-13 | `tests/e2e-full-live-exceptions/github-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-06 | Merge conflict recovery reaches completed with a new non-conflicting PR. | EX-13, EX-14 | `tests/e2e-full-live-exceptions/github-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-07 | True Codex verifier failure is recorded. | EX-10, EX-11 | `tests/e2e-full-live-exceptions/codex-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts`, `tests/e2e-full-live-exceptions/codex-faults.ts` |
| FLX-08 | Verifier failure recovery reruns verification and reaches release. | EX-10 | `tests/e2e-full-live-exceptions/codex-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-09 | Codex malformed artifact is rejected and auditable. | EX-09 | `tests/e2e-full-live-exceptions/codex-exceptions.test.ts` | `tests/e2e-full-live-exceptions/codex-faults.ts`, `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-10 | Codex timeout fault records retryable child failure. | EX-07 | `tests/e2e-full-live-exceptions/codex-exceptions.test.ts` | `tests/e2e-full-live-exceptions/codex-faults.ts`, `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-11 | Codex empty response fault records retryable or blocked child result. | EX-07 | `tests/e2e-full-live-exceptions/codex-exceptions.test.ts` | `tests/e2e-full-live-exceptions/codex-faults.ts`, `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-12 | Codex implementation recovery covers retryable and terminal child outcomes, reruns child, creates PR, and completes. | EX-07, EX-08, EX-10 | `tests/e2e-full-live-exceptions/codex-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-13 | Active live issue with missing or expired owner lease is quarantined. | EX-01, EX-02 | `tests/e2e-full-live-exceptions/recovery-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-14 | Quarantined live issue rejects unsafe resume and accepts new or host-confirmed lease. | EX-03, EX-04, EX-05, EX-06 | `tests/e2e-full-live-exceptions/recovery-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-15 | Release success without confirmed merge is rejected. | EX-13 | `tests/e2e-full-live-exceptions/recovery-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-16 | Confirmed merge plus local cleanup failure remains completed. | EX-14 | `tests/e2e-full-live-exceptions/recovery-exceptions.test.ts` | `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-17 | Failed branch cleanup is retryable and does not reverse completion. | EX-13, EX-14 | `tests/e2e-full-live-exceptions/recovery-exceptions.test.ts` | `tests/e2e-full-live-exceptions/cleanup.ts`, `tests/e2e-full-live-exceptions/harness.ts` |
| FLX-18 | No secrets appear in live issue body, PR body, SQLite history, TAP diagnostics, worker responses, or cleanup comments. | EX-12, EX-13 | `tests/e2e-full-live-exceptions/full-live-exception-units.test.ts`, `tests/e2e-full-live-exceptions/recovery-exceptions.test.ts` | `tests/e2e-full-live-exceptions/metrics.ts`, `tests/e2e-full-live-exceptions/cleanup.ts` |

## Quantified Gates

- `full_live_exception_requirements_total=18`
- `full_live_exception_requirements_covered>=16`
- `full_live_exception_requirement_coverage_percent>=88`
- `full_live_exception_ex_mappings_total>=14`
- `full_live_exception_ex_mappings_covered>=12`
- `full_live_exception_ex_mapping_percent>=85`
- `full_live_exception_secret_leaks=0`
