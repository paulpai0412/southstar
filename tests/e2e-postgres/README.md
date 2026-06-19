# Postgres/Tork/Pi Real E2E Cases

This directory is the canonical real E2E surface for the new Southstar v2 Postgres/async runtime.

## Rules

- Run **one case at a time**. Do not aggregate real workflow cases into one long suite.
- Do **not** mix with legacy SQLite E2E. Legacy scenarios live in `tests/e2e-legacy-sqlite/`.
- Do **not** add UI/browser flows here. Future UI flows will be redesigned separately.
- No fake/mock/smoke/test-only shortcuts in real cases.
- Cases must fail closed when required real infra is missing.
- Prefer lifecycle evidence from Postgres tables/read-models over console output.

## Required environment

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
TORK_BASE_URL=http://127.0.0.1:8000
PI_HARNESS_ENDPOINT=http://127.0.0.1:<pi-harness> # or Pi SDK available
PI_PLANNER_ENDPOINT=http://127.0.0.1:<pi-planner> # optional if Pi SDK available
SOUTHSTAR_CALLBACK_HOST=172.17.0.1               # host reachable from Tork worker containers
```

## Implemented case order

Run these individually:

```bash
npm run test:e2e:postgres:00   # infra preflight
npm run test:e2e:postgres:01   # db:init/schema contract
npm run test:e2e:postgres:02   # planner/run/read-model/envelope API contract
npm run test:e2e:postgres:03   # normal software run through Tork/Pi callbacks
npm run test:e2e:postgres:04   # artifact failure + recovery dispatch
npm run test:e2e:postgres:08   # evolution sandbox baseline/candidate through Tork/Pi
```

`npm run test:e2e:postgres` intentionally runs only the static manifest/boundary checks. It does not run all real cases.

## Target case matrix

| Case | Status | Purpose | Evidence |
| --- | --- | --- | --- |
| 00 infra preflight | implemented | Verify real Postgres, Tork, Pi planner/harness reachability | schema metadata, endpoint probes |
| 01 db schema init | implemented | Verify `db:init`, schema metadata, simplified table model | `southstar.schema_metadata`, no dedicated forbidden tables |
| 02 runtime API contract | implemented | Verify planner draft, run creation, task envelope, run inspection | Postgres rows + `/api/v2/read-models/...` |
| 03 normal software run | implemented | Real software task through planner -> Tork -> Pi -> callback -> completed artifact | `workflow_history`, accepted artifact, completed task/run |
| 04 artifact repair/recovery | implemented | Failed callback evidence triggers repair/recovery execution and successful retry | `repair.requested`, `recovery.execution_submitted`, recovered executor binding/task |
| 05 session recovery | planned | Failed/stuck session checkpoints and dispatches recovery execution | checkpoint resource, recovery binding, new executor job |
| 06 executor reconcile | planned | Lost/drifted executor state is reconciled without corrupting lifecycle | binding status, reconcile history, operator finding |
| 07 evolution learning | planned | Completed/failed runs synthesize cards, wiki backlinks, delta proposals | `learning_nodes`, `learning_edges`, card/delta resources |
| 08 evolution sandbox | implemented | Baseline/candidate sandbox jobs execute through Tork/Pi and evaluate decision | sandbox run contexts, callback history, decision resource |
| 09 regression rollback | planned | Promoted asset regression triggers rollback/alert according to risk | asset versions, regression alert, rollback lineage |

## Adding a new case

1. Add `tests/e2e-postgres/cases/NN-description.test.ts`.
2. Add a package script `test:e2e:postgres:NN`.
3. Update this README and `postgres-real-matrix-static.test.ts`.
4. Keep the case independent: create its own Postgres database and clean it up.
5. Assert real lifecycle/read-model evidence, not just successful HTTP responses.
