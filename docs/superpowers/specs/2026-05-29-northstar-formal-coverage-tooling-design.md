# Northstar Formal Coverage Tooling Design

- Date: 2026-05-29
- Status: approved for implementation planning
- Scope: deterministic formal coverage tooling for runtime/control-plane core
- Out of scope: live exception E2E, live GitHub/Codex/OpenCode execution, production CI wiring outside package scripts

## Purpose

Northstar now has deterministic offline E2E, daemon E2E, full-live workflow gates, and exception E2E requirement metrics. The next step is to make coverage a first-class verification gate instead of relying only on individual test suites and hand-read coverage matrices.

This goal adds two formal gates:

1. Code coverage for runtime/control-plane core source.
2. Requirement coverage for documented acceptance and exception matrices.

The coverage gate must answer:

> Do deterministic tests cover at least 85% of the runtime/control-plane core code, and do the documented requirements have explicit test and implementation mappings?

## Coverage Scope

The first code coverage gate applies only to runtime/control-plane core source:

- `src/runtime`
- `src/adapters`
- `src/cli`
- `src/config`
- `src/intake`
- `src/types`

This intentionally excludes live-only test helpers, generated reports, docs, test harnesses, and package metadata. The goal is useful product coverage, not broad line-count theater.

## Code Coverage Gate

Use `c8` as the V8 coverage frontend.

Add package scripts:

```bash
npm run test:coverage:code
npm run test:coverage:requirements
npm run test:coverage
```

`test:coverage:code` should run deterministic tests only. It must not require network access, GitHub tokens, OpenCode/Codex credentials, or live flags.

The initial minimum thresholds are:

| Metric | Minimum |
| --- | --- |
| Lines | `85%` |
| Branches | `85%` |
| Functions | `85%` |
| Statements | `85%` |

The coverage command should produce human-readable terminal output and machine-readable artifacts under a coverage output directory, such as:

```text
coverage/
  lcov.info
  coverage-summary.json
```

Generated coverage artifacts must not be committed unless the repository already has a convention for committing them.

## Requirement Coverage Gate

Add a deterministic requirement coverage checker that reads existing coverage matrix docs and verifies that requirements are explicitly mapped to both tests and implementation files.

Initial inputs:

- `docs/superpowers/runtime-core-coverage.md`
- `docs/superpowers/persistence-engine-coverage.md`
- `docs/superpowers/cli-adapters-coverage.md`
- `docs/superpowers/ac16-ac23-coverage.md`
- `docs/superpowers/full-ac-coverage.md`
- `docs/superpowers/daemon-e2e-coverage.md`
- `docs/superpowers/exception-e2e-coverage.md`
- `docs/superpowers/full-live-workflow-e2e-coverage.md`
- `docs/superpowers/live-e2e-coverage.md`
- `docs/superpowers/live-integrations-packaging-coverage.md`

The checker should produce a compact summary:

```text
requirement_coverage_total=<number>
requirement_coverage_mapped=<number>
requirement_coverage_percent=<number>
requirement_coverage_unmapped=<number>
```

Minimum requirement coverage:

| Metric | Required Value |
| --- | --- |
| `requirement_coverage_percent` | `>=85` |
| `requirement_coverage_unmapped` | `0` for required matrices included in this gate |

For the exception E2E matrix, the checker should confirm that EX-01 through EX-14 are all present and mapped to:

- `tests/e2e-exceptions/exception-e2e.test.ts`
- `tests/e2e-exceptions/harness.ts`
- at least one relevant `src/` implementation file

For the full AC matrix, the checker should confirm AC-01 through AC-23 are present.

## Architecture

Add a small test/tooling boundary rather than embedding coverage logic in runtime code.

Recommended files:

```text
tests/coverage/
  requirement-coverage.test.ts
  requirement-coverage.ts
```

The checker should:

1. Load matrix files from `docs/superpowers`.
2. Parse markdown table rows using conservative line/table parsing.
3. Extract requirement IDs such as `AC-01` and `EX-01`.
4. Verify each row includes at least one `tests/` reference.
5. Verify each row includes at least one `src/` or documented harness implementation reference.
6. Emit compact metrics for TAP diagnostics.

Requirement coverage parsing should stay deterministic and local. It must not call GitHub, shell out to external tools, or read live credentials.

## Error Handling

Code coverage failures should fail with threshold output from `c8`.

Requirement coverage failures should list:

- missing matrix files
- missing requirement IDs
- rows without test mappings
- rows without implementation mappings
- computed coverage percentage

The checker should avoid vague failures. A developer should know which matrix row to fix from the error output.

## Verification Gate

The implementation goal must finish with fresh verification:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
git status --short
```

For forbidden `rg` scans, no matches is the passing result.

## Deferred Work

Live exception E2E remains a separate follow-up goal. It should validate real GitHub/Codex/OpenCode failure and recovery behavior in the sandbox repository with live credentials.

Later coverage improvements may include:

- CI publishing for lcov/html coverage reports.
- Per-directory thresholds after baseline data is stable.
- Mutation testing for critical state-machine transitions.
- Formal trend reporting across commits.

## Success Criteria

The first formal coverage goal is complete when:

- `npm run test:coverage` exists and runs both code and requirement coverage gates.
- Code coverage for runtime/control-plane core meets `>=85%` for lines, branches, functions, and statements.
- Requirement coverage emits compact quantitative metrics.
- Required matrices produce `requirement_coverage_unmapped=0`.
- The gate is deterministic and does not require live credentials or network access.
- Fresh verification passes.
