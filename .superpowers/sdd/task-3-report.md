# Task 3 report — Runtime Startup, Health, And Goal Readiness Guard

Base commit: `8d1d2de` (`docs: correct library reconcile report`)

Implementation commit: `53f5b49` (`feat: require library readiness before goals`)

## Changes

- Added `prepareRuntimeLibraryPg` and made managed runtime startup reconcile the absolute Library root before creating/listening on the runtime server.
- Added classified startup failure persistence/status (`library_not_ready`) and immediate detached-start failure detection.
- Threaded the resolved Library root into the runtime context.
- Added the pre-claim `/api/v2/run-goal` readiness guard with stable JSON 503 output for JSON and SSE callers.
- Added Library readiness to runtime health and made readiness determine health status.
- Added focused lifecycle, run-goal, health, and route tests. Existing unrelated run-goal test setup now seeds a ready readiness resource.

## Verification

```text
$ npx tsc -p tsconfig.json --noEmit --pretty false

Process exited with code 0.
```

```text
$ git diff --check

Process exited with code 0.
```

```text
$ npx tsx --test tests/v2/runtime-server-lifecycle.test.ts
...
1..12
# tests 12
# pass 12
# fail 0
# cancelled 0
```

```text
$ npx tsx --test --test-name-pattern='run-goal returns structured 503|POST /api/v2/run-goal requires the one-prompt|POST /api/v2/run-goal streams' tests/v2/run-goal-service.test.ts
...
1..3
# tests 3
# pass 3
# fail 0
# cancelled 0
```

```text
$ npx tsx --test tests/v2/runtime-loop-routes.test.ts tests/v2/routes.test.ts
...
1..5
# tests 5
# pass 5
# fail 0
# cancelled 0
```

Requested focused command:

```text
$ npx tsx --test tests/v2/runtime-server-lifecycle.test.ts tests/v2/run-goal-service.test.ts tests/v2/routes.test.ts
...
1..46
# tests 46
# pass 41
# fail 5
# cancelled 0
```

The five failures are pre-existing workspace-discovery failures in unrelated run-goal tests. Each has the same error:

```text
Error: EACCES: permission denied, scandir '/tmp/snap-private-tmp'
    at async readdir (node:internal/fs/promises:955:18)
    at async addPath (src/v2/orchestration/goal-workspace-discovery.ts:56:25)
    at async discoverGoalWorkspace (src/v2/orchestration/goal-workspace-discovery.ts:84:3)
```

The new readiness test passed in that run (`run-goal returns structured 503 before claiming a submission when Library is not ready`), as did all lifecycle and route tests. Unrelated pre-existing worktree changes were not staged or committed.

## Follow-up race fix

Follow-up regression: `start()` now removes the prior `runtime-server-start.failure.json` before launching the detached child. A failure written by that new child remains observable by `waitForPidRecord`; only the stale prior record is cleared.

Follow-up red/green verification:

```text
$ npx tsx --test --test-name-pattern='clears a stale Library startup failure' tests/v2/runtime-server-lifecycle.test.ts
...
not ok 1 - start clears a stale Library startup failure before launching a new child
error: 'Southstar runtime Library is not ready: expected exactly one approved goal_design skill, found 0'
```

After the fix:

```text
$ npx tsx --test --test-name-pattern='clears a stale Library startup failure' tests/v2/runtime-server-lifecycle.test.ts
1..1
# tests 1
# pass 1
```

```text
$ npx tsx --test tests/v2/runtime-server-lifecycle.test.ts
1..13
# tests 13
# pass 13
```

```text
$ npx tsc -p tsconfig.json --noEmit --pretty false
Process exited with code.

$ npx tsx --test tests/v2/runtime-loop-routes.test.ts tests/v2/routes.test.ts
1..5
# tests 5
# pass 5

$ npx tsx --test --test-name-pattern='run-goal returns structured 503|POST /api/v2/run-goal requires the one-prompt|POST /api/v2/run-goal streams' tests/v2/run-goal-service.test.ts
1..3
# tests 3
# pass 3
```

Fresh requested focused command after the race fix:

```text
$ npx tsx --test tests/v2/runtime-server-lifecycle.test.ts tests/v2/run-goal-service.test.ts tests/v2/routes.test.ts
1..47
# tests 47
# pass 42
# fail 5
# cancelled 0
```

The same five unrelated pre-existing failures remain: `EACCES: permission denied, scandir '/tmp/snap-private-tmp'` from workspace discovery.

---

# Task 3 report: persisted Requirement Review phases and routes

Status: COMPLETE

## Implemented

- Added the host-owned `GoalDesignPhase` state projection to the existing `planner_draft` runtime resource. No table or second persistence model was introduced.
- Added immutable `goal_requirement_draft_revision` resources with revision/hash idempotency and conflict detection.
- Added `preparePostgresGoalRequirementDraft`, `loadCurrentGoalRequirementDraftPg`, `reviseGoalRequirementPg`, and `confirmGoalRequirementsPg`.
- Requirement confirmation persists a canonical `GoalContractV1` and hash, then transitions the planner draft to `validation_resolving`; it never calls Goal Designer or Composer.
- Requirement revision uses `SELECT ... FOR UPDATE`, expected draft hash checks, immutable parent revisions, and stale invalidation of validation bindings, slice plans, and unmaterialized DAG drafts. Materialized runs are frozen.
- Added `PATCH /api/v2/planner/drafts/:draftId/goal-requirements/:requirementId` and `POST /api/v2/planner/drafts/:draftId/confirm-requirements`, including strict patch parsing and 404/409/422 mapping.
- Added the corresponding runtime client methods and planner receipts/SSE frames for Requirement Review.
- Existing legacy Goal Design flows remain available for callers that explicitly inject a Goal Designer. Production planner route contexts without an injected designer resolve the staged Requirement interpreter.
- Added real Postgres and route regressions for initial phase persistence, confirmation idempotency/hash binding, stale invalidation, and the staged run-goal route.
- Staged goal-submission replay accepts the pre-contract Requirement hash until a canonical Goal Contract exists, while preserving the existing completion-result validation for all later phases.
- Extended the existing planner read model status parser so Requirement phases are readable without a new UI or layout.

## Verification

- `npx tsx tests/v2/goal-requirement-draft.test.ts` — PASS (17 tests)
- `npx tsx --test --test-name-pattern='Goal submission persists requirements|Requirement confirmation is hash|editing a confirmed requirement' tests/v2/postgres-run-api.test.ts` — PASS (3 tests)
- `npx tsx --test --test-name-pattern='staged run-goal route' tests/v2/run-goal-service.test.ts` — PASS (1 test)
- `npx tsc --noEmit --pretty false` — PASS
- `git diff --check` — PASS

Full focused suites were also run. Existing unrelated environment failures remain:

- `tests/v2/postgres-run-api.test.ts`: one pre-existing Library import test fails because its fixture does not provide the approved `goal_design`/`composer_guidance` skills required by current Library readiness rules.
- `tests/v2/run-goal-service.test.ts`: five pre-existing Goal Design tests fail while discovering `/tmp/snap-private-tmp` (`EACCES`); they fail before the changed code path and are unrelated to Requirement phases.

## Concerns / follow-up

- The staged Requirement route is backend-complete. The existing Workflow message block/right viewer still needs the later UI task to call these routes and render Requirement Review.
- Confirmation accepts either an injected canonical-contract metadata provider/Goal interpreter or the existing stored contract. A generic metadata fallback is used only when neither is available; production routes always provide the Goal interpreter so domain/capability vocabulary remains library-derived.
- Validation Resolution/candidate import is intentionally not performed in this task; confirmation stops at `validation_resolving` for the next resolver task.

## Follow-up reviewer fixes

Status: COMPLETE

- Replaced requirement revision persistence's read-then-upsert with atomic insert-if-absent plus compare; a duplicate revision hash is idempotent and a different hash fails with `goal_requirement_revision_conflict` without overwriting the winner.
- Added `goalRequirementDraftId` and `goalRequirementDraftHash` to staged planner payloads, generated planner bundles/request snapshots, run runtime context, and stale-resource matching. Source lineage is verified before generated DAG creation and materialization freeze checks include the source draft.
- Requirement-only planner inspection no longer synthesizes a legacy Goal Contract/hash. Legacy planner drafts keep the compatibility projection, while staged drafts expose only their requirement draft fields until confirmation.
- Goal submission now persists `goalDesignMode` and `templatePolicy` in the staged planner request. Requirement contract confirmation resolves outside the row lock, then locks/rechecks the expected hash before committing.
- Removed the synthetic `domain: "general"` / `intent: "goal_execution"` metadata path. Confirmation fails closed with structured `goal_requirement_contract_metadata_missing` or `goal_requirement_contract_metadata_invalid` errors; caller-supplied metadata is accepted only when its domain/capability/artifact refs are in the approved Library vocabulary.
- PATCH requirement routes reject URL/body requirement-id mismatches with HTTP 409, and retain 404 (missing draft) and 422 (malformed patch/metadata) mappings.

Focused verification after the fixes:

```text
$ npx tsc --noEmit --pretty false
PASS

$ git diff --check
PASS

$ npx tsx --test tests/v2/postgres-run-api.test.ts --test-name-pattern='Goal submission persists requirements_review|Requirement revisions stale|Requirement revision persistence|Requirement confirmation is hash-bound|editing a confirmed requirement|generated planner DAG keeps source requirement lineage'
PASS for all changed regressions (the suite still reports the unrelated Library import readiness failure: missing approved goal_design/composer_guidance skills)

$ npx tsx --test tests/v2/run-goal-service.test.ts --test-name-pattern='staged run-goal route persists requirement review'
PASS for the changed route regression (the suite still reports the unrelated /tmp/snap-private-tmp EACCES failures)

$ npx tsx --test --test-name-pattern='Goal submission persists requirements_review|Requirement revisions stale|Requirement revision persistence|Requirement confirmation is hash-bound|editing a confirmed requirement|generated planner DAG keeps source requirement lineage' tests/v2/postgres-run-api.test.ts
1..6
# pass 6

$ npx tsx --test --test-name-pattern='staged run-goal route persists requirement review' tests/v2/run-goal-service.test.ts
1..1
# pass 1

$ npx tsx tests/v2/goal-requirement-draft.test.ts
1..17
# pass 17
```

The previous generic metadata-fallback concern is superseded: no fallback contract is created when interpreter/approved metadata is unavailable.

## Follow-up reviewer fixes: production composition lineage

- `continueGoalDesignToRunPg` now carries confirmed source requirement id/hash into both single-DAG composition and per-slice execution-set materialization.
- `GoalExecutionSetV1`, each slice run runtime context, and execution-set summaries persist the same source lineage; requirement invalidation also marks execution-set resources stale.
- Planner source lineage is accepted only from a confirmed/validation-ready source draft with a valid stored Goal Contract/hash and matching workspace `cwd`/`projectRef`. Requirement-review and unresolved validation phases fail closed.
- Regression coverage now proves pre-validation rejection, cwd/projectRef mismatch rejection, source lineage on generated DAG and run runtime context, and `goal_requirements_already_materialized` freeze behavior when revising after the generated run exists.

Additional verification:

```text
$ npx tsx --test --test-name-pattern='generated planner DAG keeps source requirement lineage|editing a confirmed requirement' tests/v2/postgres-run-api.test.ts
1..2
# pass 2

$ npx tsx --test --test-name-pattern='staged run-goal route persists requirement review' tests/v2/run-goal-service.test.ts
1..1
# pass 1

$ npx tsc --noEmit --pretty false && git diff --check
PASS
```

## Follow-up reviewer fixes: immutable request snapshot and project lineage

- `createPostgresPlannerDraft` now snapshots the complete planner request before the asynchronous source-lineage gate. Workspace, project reference, source requirement id/hash, library hints, and a deep-cloned composition plan are therefore immutable for the whole orchestration/persistence operation.
- Source requirement validation now parses the persisted draft, validates its schema, recomputes the canonical draft hash, and fails closed on tampered payloads before accepting lineage.
- Optional `projectRef` is carried from browser/API request bodies through `RunGoalRequest`, staged Goal Requirement/Goal Design persistence, confirmation preparation, single-DAG composition, and run results/runtime context. Generated legacy planner request idempotency keys include it as well.
- The non-per-slice confirmed run result now returns `goalRequirementDraftId` and `goalRequirementDraftHash`, with a focused Postgres regression covering confirmation and runtime context.

Verification:

```text
$ npx tsc --noEmit --pretty false && git diff --check
PASS

$ npx tsx --test --test-name-pattern='generated planner DAG keeps source requirement lineage|planner draft snapshots source lineage|staged run-goal route persists requirement review' tests/v2/postgres-run-api.test.ts tests/v2/run-goal-service.test.ts
1..3
# pass 3

$ npx tsx --test --test-name-pattern='confirmed single-DAG run result preserves source requirement lineage' tests/v2/run-goal-service.test.ts
1..1
# pass 1

$ npx tsx --test tests/v2/postgres-run-api.test.ts
1..53
# pass 51, fail 2
```

The two full-suite failures are unrelated existing environment/fixture failures: the auto Library import fixture lacks approved `goal_design`/`composer_guidance` skills, and the isolated `needs_input` route test has no ready Library snapshot. Existing Goal Design tests also retain the known `/tmp/snap-private-tmp` permission failure when run in their broader suite.
