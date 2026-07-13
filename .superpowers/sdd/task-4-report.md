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

## Requirement list and sidecar editor follow-up

Implemented in this worktree as the requirement-review UI/runtime slice. The Workflow chat now renders a typed `goalRequirements` message block, opens the existing Sidecar viewer for requirement editing, and confirms requirements through the host-owned API. Session presentation was not changed.

### Implemented

- Added `GoalRequirementsContent` and `GoalRequirementSelection` browser read-model types.
- Added `GoalRequirementListBlock` with explicit/inferred, blocking, acceptance-criteria, clarification, coverage, and visual-contract indicators.
- Kept confirmation host-authoritative: the browser enables Confirm only when `confirmable === true` and always posts the displayed `goalRequirementDraftHash`.
- Added `GoalRequirementEditor` in the existing Sidecar layout. It submits one structured PATCH with `expectedDraftHash` and preserves the returned revision/hash for subsequent chat edits.
- Added thin Next.js proxies for requirement PATCH and requirement confirmation.
- Added `goal_requirements` SSE forwarding/parsing and phase-aware Workflow chat revision parameters (`draftId`, `expectedDraftHash`, `selectedRequirementId`).
- Added the minimal runtime phase-aware revision branch for `requirements_review`; it invokes the configured requirement interpreter and persists the resulting host-finalized revision. Interpreter semantic summary/non-goal/clarification changes are preserved while the host still owns lineage and hashing.
- Added rendered UI and runtime SSE regression coverage.

### Verification

- `npx tsc --noEmit --pretty false`
- `npm exec tsc -- --noEmit -p web/tsconfig.json --pretty false`
- `npx tsx --test tests/v2/planner-draft-stream-route.test.ts` (3/3)
- `npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx` (49/49)
- `npm --prefix web run build` (webpack compilation and TypeScript completed; static page generation was observed running to completion)
- `git diff --check`

### Scope notes

- No fixture, seed, mock, canned domain data, or session-list presentation was added.
- The editor is intentionally a focused requirement form; semantic validity remains in runtime validators/interpreters rather than client-side checks.
- Confirmation returns the existing validation-resolving pipeline result; evaluator/library resolution remains host-owned and is not fabricated by the browser.

## Task 4 reviewer assessment

### Spec Compliance verdict: FAIL (one critical integration gap)

The component and route seams are present and preserve the existing Workflow chat, AppShell Sidecar, and host-owned hash flow. However, the production event path never supplies the host-projected `confirmable` flag that the browser deliberately requires, so a real Requirement Review cannot be confirmed.

### Strengths

- `GoalRequirementListBlock` is rendered through the existing `MessageView`/`ChatWindow` path and opens the existing AppShell Sidecar (`web/components/MessageView.tsx:565-567`, `web/components/AppShell.tsx:694-705,817-818`).
- The browser posts the displayed `goalRequirementDraftHash` and does not derive a validity decision (`web/components/GoalRequirementListBlock.tsx:36,47-50,132-139`; `web/components/GoalRequirementEditor.tsx:43-47`).
- Revision requests carry `draftId`, `expectedDraftHash`, and the selected requirement into the phase-aware stream (`web/hooks/useAgentSession.ts:920-963`; `src/v2/server/planner-routes.ts:663-675`).
- The tests verify the existing sidecar and that confirming does not call a DAG action (`tests/web/southstar-workflow-canvas-ui.test.tsx:1045-1085`).

### Critical issues

**C1 — Production Requirement Review is permanently unconfirmable.**

`GoalRequirementListBlock` enables confirmation only when `currentBlock.confirmable === true` (`web/components/GoalRequirementListBlock.tsx:34-36,132-140`). The initial host result type and persisted result contain no `confirmable` field (`src/v2/orchestration/goal-design-draft-service.ts:272-281`), and both production SSE paths forward those results without adding it (`src/v2/server/planner-routes.ts:364-367,682-688`). `extractContent` consequently preserves `undefined` (`web/components/GoalRequirementListBlock.tsx:154-162`), leaving the button disabled forever. The only green confirmation test injects `confirmable: true` directly into a browser fixture (`tests/web/southstar-workflow-canvas-ui.test.tsx:1067-1078`), so it does not exercise the real event contract.

Fix by adding a host-computed `confirmable`/blockers projection to the persisted/read-model result and every `goal_requirements` event, then add a route/SSE regression proving the production payload enables the button only from that projection. Do not make the browser infer it from phase, blockers, or coverage.

### Important issues

**I1 — Editing a requirement leaves the list block on the old hash.**

`GoalRequirementEditor` calls `onDraftChange` with the new revision (`web/components/GoalRequirementEditor.tsx:47-52`), but AppShell only updates the Sidecar tab and revision anchor (`web/components/AppShell.tsx:707-716`). The original `GoalRequirementListBlock` keeps its local `currentBlock` at the old draft/hash because it has no draft-change callback (`web/components/GoalRequirementListBlock.tsx:17-33`; `web/components/MessageView.tsx:565-567`). After a save, clicking Confirm sends the stale displayed hash and receives `goal_requirement_draft_stale`; the normal edit → confirm flow is broken. Propagate the host response back to the message block (or make the block consume a shared draft anchor) and add a rendered regression for edit then confirm.

**I2 — The UI reports success when a confirm callback returns no host result.**

The confirm handler sets `confirmState` to `confirmed` after `onConfirmRequirements` even if that callback returns `undefined`, and the fallback path likewise accepts any `2xx` response without requiring a valid result (`web/components/GoalRequirementListBlock.tsx:51-69`). This can display a false confirmation while the host projection is unknown. Require a valid host response containing the next phase/hash (or an explicit host acknowledgement) before entering the confirmed state, with a focused failure test.

### Minor issues

- The browser confirmation test uses a synthetic `confirmable: true` block and does not assert that an actual `goal_requirements` SSE payload with no projection remains disabled; add both positive and negative event-contract coverage.
- `GoalRequirementEditor` imports `GoalRequirementsContent` but does not use it (`web/components/GoalRequirementEditor.tsx:5`); harmless, but clean it while touching the file.

### Task quality assessment

The task implementation is structurally well-scoped and follows the requested UI layout/authority boundaries. It is not ready to merge until C1 is fixed; I1 should be fixed in the same task because it breaks the primary edit-and-confirm interaction. No broad suites were run during this review; `git diff --check 406c1c3..e1b6782` is clean.

## Follow-up resolution

Status: RESOLVED.

- C1: `GoalRequirementReviewResult` now carries host-computed `confirmable` and `validationIssues` for initial, revised, and post-confirm phases. Initial and revision `goal_requirements` SSE payloads include the projection; post-confirm results explicitly report `confirmable: false`. The browser treats missing projections as non-confirmable and never derives readiness.
- I1: Sidecar PATCH responses now carry status/hash/confirmable into the AppShell requirement content override. The existing message block consumes that override, so the next Confirm posts the latest saved hash.
- I2: Confirm requires a response with a valid draft, matching draft hash, phase/status, and host `confirmable` state. Malformed 2xx responses surface an error and never enter the confirmed state.
- Removed the unused `GoalRequirementsContent` editor import.

Follow-up verification:

```text
npx tsc --noEmit --pretty false
exit 0

npm exec tsc -- --noEmit -p web/tsconfig.json --pretty false
exit 0

npx tsx --test tests/v2/planner-draft-stream-route.test.ts
4 tests, 4 pass

npx tsx --test --test-name-pattern='Requirement confirmation is hash-bound and idempotent' tests/v2/postgres-run-api.test.ts
1 test, 1 pass

npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx
51 tests, 51 pass

npm --prefix web run build
webpack compilation, TypeScript, and static page generation completed

git diff --check
exit 0
```
