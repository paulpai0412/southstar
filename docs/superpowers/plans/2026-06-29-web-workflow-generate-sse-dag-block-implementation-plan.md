# Web Workflow React Flow DAG And True Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/home/timmypai/apps/southstar/web` Workflow mode show the real backend LLM DAG generation stream and render the resulting DAG with React Flow.

**Architecture:** Add streaming as a backend runtime capability first, then proxy it through the 30141 web API and consume it in the Workflow tab. Replace the custom message-block DAG renderer with the shared `SouthstarWorkflowCanvas` React Flow component, and fix dependency-derived levels so serial and parallel DAGs render correctly.

**Tech Stack:** Node runtime server, Next.js web API routes, React 19, `@xyflow/react`, ELK layout, TypeScript, Node `--test` via `tsx`, Playwright for final rendered QA.

---

## Scope And Target

All UI product code changes are under `/home/timmypai/apps/southstar/web`. Shared React Flow canvas code under `/home/timmypai/apps/southstar/components/southstar/workflow-canvas` may be reused but should not be duplicated. Backend runtime code lives under `/home/timmypai/apps/southstar/src/v2`. Do not edit the removed root `app/` entry except to preserve its existing deletion state.

## Task 1: Backend Planner Client True Streaming

**Files:**
- Modify: `src/v2/planner/types.ts`
- Modify: `src/v2/planner/pi-planner.ts`
- Test: `tests/v2/pi-planner-streaming.test.ts`

- [ ] Write a failing test that creates a fake Pi SDK session, emits assistant message snapshots `"{"`, `"{\"schemaVersion\""`, then `agent_end`, and asserts `generateStream` returns final text while `onDelta` receives only the incremental suffixes.
- [ ] Run `node_modules/.bin/tsx tests/v2/pi-planner-streaming.test.ts` and confirm it fails because `generateStream` is missing.
- [ ] Extend `PiPlannerClient` with optional `generateStream(prompt, handlers)` and implement it in `createPiSdkPlannerClient` by diffing successive assistant text snapshots.
- [ ] Keep `generate(prompt)` delegating to the same collection path without an `onDelta` handler.
- [ ] Run the focused test and confirm it passes.

## Task 2: Composer And Planner Progress Hooks

**Files:**
- Modify: `src/v2/orchestration/llm-composer.ts`
- Modify: `src/v2/orchestration/composition-repair-loop.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Test: `tests/v2/llm-workflow-composer.test.ts`
- Test: `tests/v2/postgres-run-api.test.ts`

- [ ] Write failing tests proving `LlmWorkflowComposer` calls a streaming text client when provided and relays deltas.
- [ ] Write failing tests proving `createPostgresPlannerDraft` progress hook emits candidate resolving, composer attempt start/completion, validation completion, and persist completion.
- [ ] Add `generateTextStream` to `LlmTextClient` and use it when present.
- [ ] Add `onProgress` to `runCompositionRepairLoop` and `createPostgresPlannerDraft`, emitting concrete lifecycle stages from the real code path.
- [ ] Run focused tests and confirm they pass.

## Task 3: Runtime Planner Draft SSE Endpoint

**Files:**
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/planner-draft-stream-route.test.ts`

- [ ] Write a failing route test that posts to `/api/v2/planner/drafts/stream` with `composerMode: "llm"`, uses a streaming fake planner client, and reads SSE frames.
- [ ] Assert the stream includes at least one real `message.delta`, planner stage events, `draft`, `orchestration`, and `done`.
- [ ] Add the route and SSE encoder. Build the LLM composer with a client that calls `context.plannerClient.generateStream` when available and emits `planner.stream.degraded` when it is not.
- [ ] Run the focused route test and confirm it passes.

## Task 4: Web API Proxy Streaming

**Files:**
- Modify: `web/app/api/workflow/generate/route.ts`
- Modify: `web/lib/workflow/generate-stream.ts`
- Test: `tests/unit/workflow-library.test.ts`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

- [ ] Write failing tests for web generate route proxying backend `planner.stage` and `message.delta`, then converting backend `orchestration` to frontend `dag`.
- [ ] Extend `generateWorkflowDagStream` to parse `planner.stage`, `draft`, and existing event types.
- [ ] Change `web/app/api/workflow/generate/route.ts` to call `/api/v2/planner/drafts/stream`, parse the backend SSE stream, forward process events, and emit `dag` when orchestration arrives.
- [ ] Run focused web tests and confirm they pass.

## Task 5: React Flow DAG Message Block

**Files:**
- Modify: `web/components/WorkflowDagBlock.tsx`
- Modify: `web/lib/workflow/v2-library-adapter.ts`
- Test: `tests/unit/workflow-library.test.ts`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

- [ ] Write failing tests proving parallel task summaries share dependency-derived levels.
- [ ] Write failing static/render tests proving `WorkflowDagBlock` imports `SouthstarWorkflowCanvas`, preserves `workflow-dag-scroll`, and maps node selection back to `WorkflowDagNode`.
- [ ] Implement topological level calculation in `buildWorkflowDagFromPlannerDraft`.
- [ ] Replace the custom SVG/card layout with `SouthstarWorkflowCanvas` inside the existing block shell and lifecycle controls.
- [ ] Run focused tests and confirm they pass.

## Task 6: Frontend Workflow Streaming UX

**Files:**
- Modify: `web/hooks/useAgentSession.ts`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

- [ ] Add tests/static assertions that Workflow mode renders stage text, token deltas, final DAG block, and still preserves normal chat/slash-command behavior.
- [ ] Update the Workflow-mode branch to display stage messages as they arrive and append final assistant content with streamed text plus React Flow DAG.
- [ ] Run focused web tests and confirm they pass.

## Task 7: Full Verification

**Commands:**
- `node_modules/.bin/tsx tests/v2/pi-planner-streaming.test.ts`
- `node_modules/.bin/tsx tests/v2/llm-workflow-composer.test.ts`
- `node_modules/.bin/tsx tests/v2/planner-draft-stream-route.test.ts`
- `node_modules/.bin/tsx tests/unit/workflow-library.test.ts`
- `node_modules/.bin/tsx tests/web/southstar-workflow-canvas-ui.test.tsx`
- `node_modules/.bin/tsc -p web/tsconfig.json --noEmit`

**Rendered QA:**
- Restart `npm run southstar:start`.
- Use Playwright against `http://127.0.0.1:30141/`.
- Click Workflow tab.
- Submit a serial workflow prompt and capture screenshot.
- Submit a parallel workflow prompt and capture screenshot showing parallel branches.
- Verify the assistant message shows real backend stage events and LLM deltas before the DAG appears.
