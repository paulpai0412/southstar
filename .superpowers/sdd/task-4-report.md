# Task 4 report: unify Library save & sync and import approval

Status: DONE_WITH_CONCERNS

Base commit: `81d096a` (`fix: clear stale library startup failure before start`)

Implementation commit: `1be0a8f` (`feat: unify library save sync and readiness`)

## Implemented

- Library file Save & Sync now reads the selected file for the response, reconciles the complete Library root through `reconcileLibraryFilesPg`, and publishes the resulting readiness snapshot.
- Import approval now uses the shared catalog reconcile transaction, rejects locked existing object keys before upsert, persists the reconcile result and snapshot hash, and returns `synced`, `reconcile`, and `librarySnapshotHash`.
- Added read-only runtime readiness and browser readiness API/types, plus the in-layout readiness banner in the existing Library sidebar.
- Added focused Postgres, route, API, and browser interaction regressions.

## TDD and verification

The required red checks were observed before implementation:

- `npx tsx --test --test-name-pattern='Library file sync' tests/v2/library-chat-routes.test.ts` failed because the route still returned the old single-file graph result.
- `npx tsx --test --test-name-pattern='import approval cannot' tests/v2/library-import-drafts.test.ts` failed because import approval still used the old single-file sync and rejected the missing reference instead of publishing a blocked object in a warning snapshot.

Focused green checks:

```text
npx tsx --test --test-name-pattern='Library file sync' tests/v2/library-chat-routes.test.ts
1 test, 1 pass

npx tsx --test --test-name-pattern='import approval cannot' tests/v2/library-import-drafts.test.ts
1 test, 1 pass

npx tsx --test --test-name-pattern='readiness API helper|readiness diagnostics' tests/web/southstar-library-workspace-interaction.test.tsx
2 tests, 2 pass

npx tsx --test tests/v2/library-reconcile-postgres.test.ts tests/v2/library-reconcile-service.test.ts
13 tests, 13 pass

npx tsx --test tests/web/southstar-library-workspace-interaction.test.tsx
16 tests, 16 pass

npx tsc --noEmit --pretty false
exit 0

git diff --check
exit 0
```

## Reviewer follow-up: rollback race and post-commit progress

Follow-up implementation commit: `6d450fc` (`fix: preserve concurrent library edits on rollback`)

- Overwrite snapshots now retain both original and installed bytes. Rollback restores only when the current file still matches the installed content, preserving a concurrent operator edit; text and Buffer files use content-appropriate comparisons.
- Completion progress callbacks are isolated after commit and cannot trigger filesystem cleanup when an observer throws.
- Added regressions for concurrent overwrite edits and throwing post-commit progress observers.

Verification:

```text
npx tsx --test --test-name-pattern='candidate install restores|candidate install preserves|post-commit progress' tests/v2/library-import-drafts.test.ts
3 tests, 3 pass

npx tsc --noEmit --pretty false
exit 0

git diff --check
exit 0
```

## Concerns

The requested combined legacy command still reports 12 failures (43/55 pass) from pre-Task-4 expectations: old chat tests lack an LLM provider, old approval tests do not seed the required `goal_design`/`composer_guidance` files, and three candidate-install tests still expect removed placeholder/domain synthesis. The new Task-4 tests and the complete-root route path pass; unrelated dirty worktree files were not staged.

## Reviewer follow-up

Follow-up implementation commit: `cbd05a3` (`fix: reconcile candidate installs atomically`)

- Candidate installation now loads the complete catalog and calls `reconcileLibraryCatalogPg` in the same transaction as ontology-edge/resource writes.
- Existing main/supporting files are snapshotted before overwrite and restored on any failure; newly created files retain the existing cleanup path.
- Browser approval result types now include `reconcile` and `librarySnapshotHash`, and the readiness banner includes diagnostic paths.

Follow-up verification:

```text
npx tsx --test --test-name-pattern='candidate install reconciles|candidate install restores' tests/v2/library-import-drafts.test.ts
2 tests, 2 pass

npx tsx --test --test-name-pattern='readiness diagnostics' tests/web/southstar-library-workspace-interaction.test.tsx
1 test, 1 pass

npx tsc --noEmit --pretty false
exit 0

git diff --check
exit 0
```
