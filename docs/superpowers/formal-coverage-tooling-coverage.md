# Northstar Formal Coverage Tooling Coverage Matrix

| Requirement | Test File | Implementation File |
| --- | --- | --- |
| Code coverage gate runs c8 over runtime/control-plane core source and emits `coverage-summary.json`. | `tests/coverage/coverage-config.test.ts`, `tests/coverage/code-coverage-runner.test.ts` | `package.json`, `tests/coverage/code-coverage-runner.test.ts` |
| Requirement coverage gate maps documented AC and EX requirements to tests and implementation files. | `tests/coverage/requirement-coverage.test.ts` | `tests/coverage/requirement-coverage.ts`, `docs/superpowers/full-ac-coverage.md`, `docs/superpowers/exception-e2e-coverage.md` |
| Combined coverage gate runs requirement coverage and code coverage without shell-chain package scripts. | `tests/coverage/requirement-coverage.test.ts`, `tests/coverage/coverage-config.test.ts` | `tests/coverage/run-coverage-gates.ts`, `package.json` |
| Coverage reports are generated locally and ignored by git. | `tests/coverage/coverage-config.test.ts` | `.gitignore`, `package.json` |

## Commands

- `npm run test:coverage`
- `npm run test:coverage:code`
- `npm run test:coverage:requirements`

## Quantified Gates

- Code coverage threshold: lines, branches, functions, and statements each `>=85%`.
- Requirement coverage summary includes `requirement_coverage_total`, `requirement_coverage_mapped`, `requirement_coverage_percent`, and `requirement_coverage_unmapped`.
- Required requirement coverage result: `requirement_coverage_unmapped=0`.
