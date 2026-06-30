# Workflow Streaming Revise DAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render workflow DAG blocks as soon as SSE `dag` events arrive and support streaming LLM revisions from an existing planner draft.

**Architecture:** Keep `/api/workflow/generate` as the 30141 web entrypoint and add an optional revision contract to the same client stream helper. Backend v2 gets a streaming revise route that reuses the existing draft stream response shape, but builds the revised LLM prompt from the base goal, user revision, and bounded prior orchestration context.

**Tech Stack:** Next.js route handlers, WHATWG ReadableStream SSE, Southstar v2 runtime API, node:test, TypeScript.

---

### Task 1: Frontend Streaming DAG Render

**Files:**
- Modify: `web/lib/workflow/generate-stream.ts`
- Modify: `web/hooks/useAgentSession.ts`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

- [ ] **Step 1: Write the failing test**

Add assertions that the stream helper can post to a revise URL when `draftId` is supplied and that workflow mode updates the streaming message with a `workflowDag` block from `onDag`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: FAIL because `generateWorkflowDagStream` has no `draftId` input and `onDag` does not update the streaming message content.

- [ ] **Step 3: Write minimal implementation**

Extend `generateWorkflowDagStream` with optional `draftId`; post to `/api/workflow/planner-drafts/:draftId/revise/stream` when present. In `useAgentSession`, store the generated DAG in streaming content immediately when `onDag` fires.

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: PASS.

### Task 2: Backend Streaming Revision

**Files:**
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `web/app/api/workflow/generate/route.ts`
- Create: `web/app/api/workflow/planner-drafts/[draftId]/revise/stream/route.ts`
- Test: `tests/v2/planner-draft-stream-route.test.ts`
- Test: `tests/unit/workflow-v2-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a v2 route test that creates a draft, calls `/api/v2/planner/drafts/:draftId/revise/stream`, verifies SSE `message.delta`, `draft`, `orchestration`, `done`, and verifies the LLM prompt contains `Prior planner draft context` with task summaries. Add a web proxy test for `/api/workflow/planner-drafts/:draftId/revise/stream`.

- [ ] **Step 2: Run tests to verify they fail**

Run:
`node_modules/.bin/tsx tests/v2/planner-draft-stream-route.test.ts`
`node_modules/.bin/tsx tests/unit/workflow-v2-api.test.ts`

Expected: FAIL because the stream revise routes do not exist and revised prompts lack explicit prior DAG context.

- [ ] **Step 3: Write minimal implementation**

Add `buildPlannerDraftRevisionGoalPrompt` inside `postgres-run-api.ts`, include base goal, revision request, and bounded prior context containing `workflowId`, `status`, `taskSummaries`, `validationIssues`, and `orchestrationSnapshot`. Add `/api/v2/planner/drafts/:draftId/revise/stream` and a web proxy route that forwards/normalizes SSE and converts `orchestration` to `dag`.

- [ ] **Step 4: Run tests to verify they pass**

Run:
`node_modules/.bin/tsx tests/v2/planner-draft-stream-route.test.ts`
`node_modules/.bin/tsx tests/unit/workflow-v2-api.test.ts`

Expected: PASS.

### Task 3: Final Verification

**Files:**
- Verify: `web/tsconfig.json`
- Verify: root TypeScript project

- [ ] **Step 1: Run focused tests**

Run:
`node_modules/.bin/tsx tests/web/southstar-workflow-canvas-ui.test.tsx`
`node_modules/.bin/tsx tests/v2/planner-draft-stream-route.test.ts`
`node_modules/.bin/tsx tests/unit/workflow-v2-api.test.ts`

- [ ] **Step 2: Run type checks**

Run:
`node_modules/.bin/tsc -p web/tsconfig.json --noEmit`
`node_modules/.bin/tsc --noEmit`

- [ ] **Step 3: Inspect diff**

Run: `git diff --stat && git diff --check`

Expected: no whitespace errors and only files from this plan changed.
