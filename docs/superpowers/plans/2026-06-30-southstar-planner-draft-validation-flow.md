# Southstar Planner Draft Validation Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workflow UI and backend treat prompt-generated planner DAGs as persisted drafts, require true validation after profile edits, and preserve profile overrides across draft revision.

**Architecture:** Keep `planner_draft` as the persisted source of truth. Profile edits mutate the same draft and mark it `needs_validation`; a new validation action refreshes draft status and summary; run creation remains blocked unless the draft is `validated`. Revision still creates a new draft but copies matching task-level overrides from the source draft and requires validation before running.

**Tech Stack:** TypeScript, Next.js App Router proxy routes, Southstar v2 Postgres runtime resources, Node `node:test`.

---

### Task 1: Backend Draft Status and Validation

**Files:**
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/server/routes.ts`
- Create: `web/app/api/workflow/planner-drafts/[draftId]/validate/route.ts`
- Test: `tests/v2/postgres-run-api.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that patch `implement-feature`, assert the draft status becomes `needs_validation`, assert `createPostgresRunFromDraft()` rejects it, call `validatePostgresPlannerDraft()`, and assert status returns to `validated`.

- [ ] **Step 2: Run test to verify failure**

Run: `npx tsx tests/v2/postgres-run-api.test.ts`

Expected: FAIL because `validatePostgresPlannerDraft` does not exist and profile override still returns `validated`.

- [ ] **Step 3: Implement status marking**

Update `patchPostgresPlannerDraftTaskProfileOverride()` so it writes the same draft with status `needs_validation` and refreshed summary status/task summaries.

- [ ] **Step 4: Implement validation action**

Add `validatePostgresPlannerDraft(db, { draftId })`. It reads the draft workflow, runs `validateWorkflowManifest()`, also validates `materializeWorkflowTaskProfileOverrides(workflow)`, updates `runtime_resources`, and returns `PostgresPlannerDraftResult`.

- [ ] **Step 5: Add API route**

Add backend route `POST /api/v2/planner/drafts/:draftId/validate` and Next proxy route `/api/workflow/planner-drafts/:draftId/validate`.

- [ ] **Step 6: Verify**

Run: `npx tsx tests/v2/postgres-run-api.test.ts`

Expected: new focused tests pass. Existing tests that assumed run-after-edit without validation should be updated to call validate first.

### Task 2: Preserve Overrides During Revise

**Files:**
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Test: `tests/v2/postgres-run-api.test.ts`

- [ ] **Step 1: Write failing test**

Add a test that creates a draft, patches `implement-feature` with `profileOverride`, revises the draft, and asserts the revised draft has the same override on `implement-feature` and status `needs_validation`.

- [ ] **Step 2: Run test to verify failure**

Run: `npx tsx tests/v2/postgres-run-api.test.ts`

Expected: FAIL because revised drafts currently regenerate without copying overrides.

- [ ] **Step 3: Implement deterministic copy**

After `revisePostgresPlannerDraft()` creates the revised draft, copy source task overrides by exact task id. If any override is copied, mark revised draft `needs_validation`.

- [ ] **Step 4: Verify**

Run: `npx tsx tests/v2/postgres-run-api.test.ts`

Expected: revise preservation test passes.

### Task 3: Frontend Lifecycle Alignment

**Files:**
- Modify: `web/lib/workflow/types.ts`
- Modify: `web/lib/workflow/v2-library-adapter.ts`
- Modify: `web/lib/workflow/generate-stream.ts`
- Modify: `web/lib/workflow/lifecycle.ts`
- Modify: `web/hooks/useWorkflowLifecycle.ts`
- Modify: `web/components/WorkflowDagBlock.tsx`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

- [ ] **Step 1: Write failing tests**

Add UI tests showing a generated DAG with `draftId` does not show an active `Draft` action, `Validate` uses POST validate, and `Run` is disabled when status/readiness is `needs_validation`.

- [ ] **Step 2: Run test to verify failure**

Run: `npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: FAIL because lifecycle still starts as `file_draft` and Validate uses GET orchestration.

- [ ] **Step 3: Carry draft status on DAG**

Add optional `draftStatus` to `WorkflowDag`, set it in `buildWorkflowDagFromPlannerDraft()`, and preserve it in stream handling.

- [ ] **Step 4: Initialize lifecycle from DAG**

Change `useWorkflowLifecycle()` to initialize from `dag.draftId` and `dag.draftStatus`. Hide or disable Draft when a backend draft exists.

- [ ] **Step 5: Wire real validation**

Change frontend validate to `POST /api/workflow/planner-drafts/:draftId/validate`. After profile override save, refresh the workflow UI or mark local state as `needs_validation`.

- [ ] **Step 6: Verify**

Run: `npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: UI lifecycle tests pass.

### Task 4: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused backend tests**

Run:
`npx tsx tests/v2/postgres-run-api.test.ts`
`npx tsx tests/v2/workflow-composition-validator.test.ts`

- [ ] **Step 2: Run focused frontend tests**

Run:
`npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

- [ ] **Step 3: Restart Southstar**

Run:
`npm run southstar:stop`
`npm run southstar:start`
`npm run southstar:status`

Expected: web on `http://127.0.0.1:30141`, runtime on `http://127.0.0.1:3100`, Postgres and Tork running.
