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

The 5 new Postgres tests passed, and the existing 20 reconcile/file-store tests passed (including the legacy single-file placeholder behavior, which remains outside the new complete-catalog reconcile path).

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
