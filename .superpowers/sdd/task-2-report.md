# Task 2 report: atomic Library graph reconcile

Base commit: `f42cf10` (`fix: stabilize library closure diagnostics`)

## Implemented

- Added `listFileBackedLibraryObjectsForUpdate`, `deactivateOutgoingLibraryEdges`, and deterministic `appendLibraryHistoryEvent` graph-store helpers.
- Added object-first/edge-second `syncLibraryFileRecordsToGraphPg`. Reconcile input is synchronized without synthesizing placeholder objects; non-executable files are persisted as blocked/draft/deprecated and have no active edges.
- Added canonical snapshot hashing, typed `LibraryReconcileResult`, `LibraryReadiness`, `LibraryReconcileError`, and `LibraryNotReadyError` APIs.
- Added one advisory-transaction-locked `reconcileLibraryFilesPg` write path, including deprecation of removed file-backed objects, history events, snapshot/readiness runtime resources, idempotency, and rollback on fatal discovery diagnostics.
- Added five real-Postgres tests covering closed approved snapshots/idempotency, rollback, removal deprecation, immutable frozen-run refs, and concurrent advisory-lock serialization; registered the test module in `tests/v2/index.test.ts`.

## Verification

### TDD red

Command:

```text
npx tsx --test tests/v2/library-reconcile-postgres.test.ts
```

Observed failure (expected before implementation):

```text
SyntaxError: The requested module '../../src/v2/design-library/files/library-reconcile-service.ts' does not provide an export named 'LibraryReconcileError'
not ok 1 - tests/v2/library-reconcile-postgres.test.ts
exit=1
```

### Focused green gate

Command:

```text
npx tsx --test tests/v2/library-reconcile-service.test.ts tests/v2/library-reconcile-postgres.test.ts tests/v2/library-file-store.test.ts
```

Observed output:

```text
1..25
# tests 25
# pass 25
# fail 0
# cancelled 0
# duration_ms 6540.914158
```

The 5 new Postgres tests passed, and the existing 20 reconcile/file-store tests passed; legacy single-file tests now assert unresolved-reference failure and no placeholder synthesis.

### Type and whitespace checks

Commands:

```text
npx tsc --noEmit --pretty false
git diff --check
```

Both exited `0` with no output.

### Full v2 suite

Command:

```text
npm run test:v2
```

The suite reached the Library tests (new reconcile tests passed as TAP tests 206–210 in the run), but existing unrelated tests failed before suite completion:

```text
not ok - confirmation composes the exact package hash and schedules once
error: EACCES: permission denied, scandir '/tmp/snap-private-tmp'

not ok - stale confirmation fails before composer invocation
error: EACCES: permission denied, scandir '/tmp/snap-private-tmp'

not ok - POST /api/v2/planner/drafts/:draftId/confirm-goal-design returns the confirmed run result
error: EACCES: permission denied, scandir '/tmp/snap-private-tmp'

not ok - POST /api/v2/planner/drafts/:draftId/confirm-goal-design streams the same result envelope
error: EACCES: permission denied, scandir '/tmp/snap-private-tmp'

not ok - POST /api/v2/planner/drafts/:draftId/confirm-goal-design maps stale hash to 409
error: EACCES: permission denied, scandir '/tmp/snap-private-tmp'

not ok - accepts library chat messages and streams deterministic SSE events
error: library import analysis requires an LLM provider

not ok - library prompt import creates an import draft without writing files
error: expected HTTP 200, received 400
```

These failures are outside the Task 2 files and were present in the shared dirty worktree/runtime environment.

## Follow-up review fixes (after `a48bad9`)

- Added `insertRuntimeResourceIfAbsentPg`, which uses `on conflict do nothing` and then reads the durable row. Reconcile now uses it for immutable `library_sync_snapshot` resources while retaining the upsert path for mutable current readiness.
- Removed all placeholder and canonical-domain synthesis from `syncLibraryFileRecordToGraph` and `syncNewLibraryFileRecordsToGraph`. Legacy sync now fails with an unresolved-reference diagnostic before writing graph rows; canonical-domain edges require a parsed domain object to have been synced first.
- Batch sync validates reference prefixes/existence only for executable approved records. Non-executable records can carry missing or unknown refs, are persisted with their requested non-executable status/reason, and receive no active edges.
- Updated legacy file-store tests to provide real referenced graph objects, require missing-reference failure/no object, and exercise parsed domain-file provenance. Added Postgres regressions for immutable snapshots/current readiness and non-executable unknown refs.

### Follow-up red

Before the fixes, the new regressions failed as expected:

```text
not ok 6 - snapshot resources are immutable while current readiness follows the latest reconcile
Expected first sourceRoot, received second sourceRoot (snapshot payload was overwritten)

not ok 7 - non-executable files with unknown references persist without graph placeholders
error: unsupported referenced object key prefix: mystery.missing
1..7
# tests 7
# pass 5
# fail 2
```

### Follow-up green gate

Commands:

```text
npx tsx --test tests/v2/library-reconcile-service.test.ts tests/v2/library-reconcile-postgres.test.ts tests/v2/library-file-store.test.ts tests/v2/library-graph-store.test.ts
npx tsc --noEmit --pretty false
git diff --check
```

Observed output:

```text
1..30
# tests 30
# pass 30
# fail 0
# cancelled 0
# duration_ms 7163.208451

tsc exit=0
diff check exit=0

The requested focused reconcile/file-store command was also run after the final edits:

```text
npx tsx --test tests/v2/library-reconcile-service.test.ts tests/v2/library-reconcile-postgres.test.ts tests/v2/library-file-store.test.ts
```

```text
1..27
# tests 27
# pass 27
# fail 0
# cancelled 0
# duration_ms 7019.821413
focused_exit=0
tsc_exit=0
diffcheck_exit=0
```

## Report correction

The original focused-gate sentence above was stale after `0cbffa7`: legacy single-file sync no longer preserves placeholder behavior. It now requires referenced graph objects and fails unresolved references without writing source or placeholder rows. No code or tests changed in this documentation-only correction.

---

# Goal Requirement Interpreter implementation report

Status: COMPLETE

## Scope

Implemented the LLM Requirement Interpretation and Revision boundary. The LLM now produces only semantic Requirement Draft content. The host owns identifiers, criterion ids, lifecycle status, revision lineage, canonical hashes, and operation targets.

## Changes

- Added `GoalRequirementDraftInterpreter` and `createLlmGoalRequirementDraftInterpreter()`.
- Added strict semantic output parsing for the complete requirement schema, including observable behaviors, business rules, acceptance criteria/evidence intent, expected outcome artifacts, verification intent, assumptions, open questions, risk tags, and interaction contract references.
- Added strict revision parsing for either a semantic replacement draft or a semantic host-normalized operation (`update`, `create`, `supersede`, `restore`, `split`, `merge`). LLM responses cannot provide ids, status, revisions, parent revisions, hashes, or workflow/library fields.
- Added one bounded repair attempt for interpretation and revision responses; the second invalid response fails closed with an `invalid Goal Requirement ...` error.
- Added stream delta forwarding only after a response passes host validation and finalization.
- Added `goalRequirementInterpreter` to `RuntimeServerContext` while retaining the existing Goal Contract interpreter for legacy routes.
- Clarified Goal Contract semantic-vs-host-owned interpretation types.

## TDD evidence

The focused test initially failed because `createLlmGoalRequirementDraftInterpreter` was not exported. After implementation, focused tests cover:

- strict requirement output and absence of workflow fields in the prompt;
- rejection of host-owned fields in revisions;
- one and only one bounded repair attempt;
- host lineage preservation for semantic revisions;
- host-selected target normalization for update operations;
- existing requirement draft lifecycle and hash invariants.

## Verification

- `npx tsc --noEmit --pretty false` — PASS
- `npx tsx tests/v2/goal-requirement-draft.test.ts` — PASS (13 tests)
- `npx tsx tests/v2/goal-design.test.ts` — PASS (6 tests)
- `git diff --check` — PASS

## Concerns

- Revision `merge` operations require multiple host-selected ids. The current public revision interface exposes one optional `selectedRequirementId`, so semantic replacement drafts should be used for merge-like edits until a plural selection UI is introduced.
- The interpreter is intentionally not wired into Goal Design routes yet; Task 3/6 owns persisted phases and route selection. The runtime context field is available for that integration.

---

# Task 2 follow-up review fixes

Status: COMPLETE

Review fixes implemented in the follow-up commit:

- Revision `onDelta` callbacks are now forwarded only after host selection, semantic parsing, operation application, finalization, and lineage validation succeed. `needs_input` and failed target/merge paths emit no semantic deltas.
- Semantic replacement drafts require explicit host mapping through `selectedRequirementIds` (one id per edited requirement; the singular field remains a one-requirement convenience). Requirement ids are preserved by this explicit mapping rather than statement/index matching; unknown or stale ids return structured `needs_input`.
- Merge operations now use plural host-selected ids and execute through the existing host `merge` revision operation. Missing/insufficient merge selections return structured `needs_input` before applying or streaming anything.
- Added regression coverage for valid stream forwarding, stale selection, valid/invalid merge selection, and multi-requirement statement changes with deterministic host id preservation.

Follow-up verification:

- `npx tsc --noEmit --pretty false` — PASS
- `npx tsx tests/v2/goal-requirement-draft.test.ts` — PASS (18 tests)
- `npx tsx tests/v2/goal-design.test.ts` — PASS (6 tests)
- `git diff --check` — PASS

After the clarification regression was added, the focused requirement draft command was rerun:

- `npx tsc --noEmit --pretty false` — PASS
- `npx tsx tests/v2/goal-requirement-draft.test.ts` — PASS (18 tests)
- `git diff --check` — PASS
