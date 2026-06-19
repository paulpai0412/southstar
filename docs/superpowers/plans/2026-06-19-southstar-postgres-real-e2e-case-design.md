# Southstar Postgres Real E2E Case Design

Date: 2026-06-19
Scope: Postgres/Tork/Pi real E2E only. UI/browser flows are intentionally excluded because the UI will be redesigned separately.

## Design principles

1. **One case per command**
   - Real E2E cases must not be aggregated into one long test file.
   - `npm run test:e2e:postgres` runs only static/manifest checks.
   - Real cases run via `npm run test:e2e:postgres:NN`.

2. **No legacy mixing**
   - New canonical real E2E lives under `tests/e2e-postgres/cases/`.
   - Legacy SQLite E2E lives under `tests/e2e-legacy-sqlite/`.
   - No case may import `stores/sqlite`, `ui-api/local-api`, old `e2e-legacy-sqlite`, or UI/browser helpers.

3. **No UI flows in this suite**
   - No Playwright/browser tests.
   - No app-shell assertions.
   - No UI page contracts.
   - UI E2E will be redesigned separately after runtime semantics stabilize.

4. **Real infra, fail closed**
   - Missing Postgres/Tork/Pi infra is a failure, not a skip.
   - No fake/mock/smoke/test-only paths.
   - Cases must assert durable evidence in Postgres and/or canonical read-models.

5. **Progression from foundation to lifecycle**
   - Basic infra first.
   - Then normal runtime flow.
   - Then abnormal/recovery flow.
   - Then session-specific behavior.
   - Then evolution learning/promotion/regression.

## Implemented case commands

```bash
npm run test:e2e:postgres      # static manifest/boundary only
npm run test:e2e:postgres:00   # infra preflight
npm run test:e2e:postgres:01   # db schema init
npm run test:e2e:postgres:02   # runtime API contract
npm run test:e2e:postgres:03   # normal software run
npm run test:e2e:postgres:08   # evolution sandbox baseline/candidate
```

## Case matrix

### 00 — Infra preflight

File: `tests/e2e-postgres/cases/00-infra-preflight.test.ts`

Purpose:

- Verify real Postgres admin URL can create/drop an isolated DB.
- Verify Southstar schema can initialize/open.
- Verify Tork endpoint is reachable.
- Verify Pi planner/harness endpoint or SDK availability.

Evidence:

- `southstar.schema_metadata` row exists.
- Tork `/jobs` probe succeeds.
- Pi planner/harness probe succeeds or SDK import succeeds.

### 01 — DB schema init

File: `tests/e2e-postgres/cases/01-db-schema-init.test.ts`

Purpose:

- Verify `southstar db:init` creates schema.
- Verify runtime refuses uninitialized DB.
- Verify simplified schema invariants.

Evidence:

- `southstar.workflow_runs`, `learning_nodes`, `learning_edges` exist.
- forbidden dedicated tables like `asset_versions` do not exist.

### 02 — Runtime API contract

File: `tests/e2e-postgres/cases/02-runtime-api-contract.test.ts`

Purpose:

- Verify planner draft creation through server API.
- Verify run creation through server API.
- Verify task envelope and read-model APIs use Postgres state.

Evidence:

- `/api/v2/planner/drafts`
- `/api/v2/runs`
- `/api/v2/read-models/run-inspection/:runId`
- `/api/v2/runs/:runId/tasks/:taskId/envelope`
- `southstar.workflow_runs` contains manifest/runtime context.

### 03 — Normal software run

File: `tests/e2e-postgres/cases/03-normal-software-run.test.ts`

Status: implemented

Purpose:

- Execute a small real software-development workflow through Planner -> Postgres run -> materialized task envelopes -> Tork -> Pi harness -> callback.
- Assert artifact/evidence acceptance and completed lifecycle.

Evidence:

- executor bindings are created for all tasks.
- Tork job completes.
- `executor.callback_received` history exists for all tasks.
- all task statuses become `completed` and run status becomes `passed`.
- accepted artifact resources contain command/test evidence.

### 04 — Artifact repair/recovery

Status: planned

Purpose:

- Force a partial/malformed artifact in a real worker run.
- Verify root/session artifact gate requests repair.
- Verify retry produces accepted artifact.

Evidence target:

- `repair.requested` history event.
- failed evaluator result for first artifact.
- accepted artifact after repair.
- no raw transcript stored.

### 05 — Session recovery

Status: planned

Purpose:

- Simulate failed/stuck session after durable checkpoint.
- Dispatch recovery execution through Postgres recovery dispatcher and Tork.

Evidence target:

- session checkpoint resource.
- recovery decision/operation history.
- new executor binding/job.
- rebuilt task envelope includes checkpoint/failure context.

### 06 — Executor reconcile

Status: planned

Purpose:

- Introduce executor binding drift/orphan state.
- Verify reconcile classifies and records finding without corrupting lifecycle.

Evidence target:

- reconcile history event.
- binding status update.
- operator finding resource if human action is required.

### 07 — Evolution learning

Status: planned

Purpose:

- After completed/failed runtime flows, synthesize knowledge cards, wiki links, and deltas.

Evidence target:

- `learning_nodes` card/delta nodes.
- `learning_edges` evidence/wiki/runtime usage edges.
- card status respects approval policy.
- delta proposal contains evidence subgraph hash.

### 08 — Evolution sandbox baseline/candidate

File: `tests/e2e-postgres/cases/08-evolution-sandbox-baseline-candidate.test.ts`

Purpose:

- Execute baseline and candidate sandbox runs through Postgres/Tork/Pi.
- Record evaluator output and decision.

Evidence:

- baseline/candidate run contexts have `runMode=sandbox`.
- both variants receive executor callbacks.
- sandbox decision is persisted and passed/failed by policy.

### 09 — Regression rollback

Status: planned

Purpose:

- Promote an asset, record regression observations, run regression monitor, and verify rollback/alert behavior.

Evidence target:

- promoted asset version.
- regression alert or rollback resource.
- lineage from regressed asset to rollback target.

## Execution order

The intended progression is:

```text
00 -> 01 -> 02 -> 03 -> 04 -> 05 -> 06 -> 07 -> 08 -> 09
```

Do not implement 07+ before 03-06 have stable lifecycle evidence, except where isolated evolution APIs already have unit/integration coverage.

## Acceptance for adding each future case

A new real case is accepted only when:

- it has an individual `test:e2e:postgres:NN` script;
- it creates/cleans its own isolated Postgres DB;
- it does not import legacy SQLite/local API/UI/browser helpers;
- it asserts durable Postgres/read-model evidence;
- static manifest test includes the case;
- it is documented in `tests/e2e-postgres/README.md` and this design file.
