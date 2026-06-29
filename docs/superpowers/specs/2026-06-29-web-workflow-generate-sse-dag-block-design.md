# Web Workflow React Flow DAG And True Planner Streaming Design

## Correct Entry

The only supported UI entry is `/home/timmypai/apps/southstar/web` served at `http://127.0.0.1:30141/`. The removed root `app/` and old `southstar-web/` paths are out of scope and must not receive product changes.

## Problem

The Workflow tab can call `web/app/api/workflow/generate/route.ts`, but the current behavior is incomplete:

- The message block DAG renderer is a custom SVG/card layout and can flatten real parallel dependencies when node levels are assigned from task order.
- The web generate route streams only coarse web-side events after the backend planner draft request finishes.
- The backend runtime planner draft API is JSON-only, so the browser cannot see LLM composition deltas, repair attempts, validation stages, or draft persistence as they happen.

## Goals

- Render every workflow DAG message block with the shared React Flow canvas backed by `@xyflow/react` and ELK layout.
- Preserve node click behavior so the right-side inspector/profile editor can continue using the selected workflow node.
- Add a runtime backend SSE endpoint for planner draft generation that emits true LLM text deltas when the active planner client supports streaming.
- Make true streaming the default path for `composerMode: "llm"`. Non-streaming clients must be reported explicitly with `planner.stream.degraded`; they must not produce fake token deltas.
- Proxy backend planner SSE through `web/app/api/workflow/generate/route.ts`, convert orchestration payloads to `WorkflowDag`, and stream all generation stages back to the Workflow tab.
- Show the user the full planner process in the assistant message: request accepted, candidate loading, LLM composition deltas, parse/repair/validation, draft persistence, orchestration loading, final React Flow DAG.
- Support serial and parallel DAGs, including parallel siblings rendered as separate React Flow nodes at the same graph layer.

## Non-Goals

- Do not wrap workflow generation in MCP or another LLM tool layer. The backend already owns LLM DAG generation.
- Do not implement a separate new Workflow page.
- Do not implement the node profile editor in this change; keep the existing node selection callback intact.
- Do not add fake frontend loading text that claims to be LLM token output.

## Backend Streaming Contract

Add `POST /api/v2/planner/drafts/stream` to the runtime server. The request body uses the existing planner draft fields:

```json
{
  "goalPrompt": "Generate a todo webapp workflow DAG",
  "cwd": "/home/timmypai/apps/southstar",
  "orchestrationMode": "llm-constrained",
  "composerMode": "llm"
}
```

The response is `text/event-stream` with these event types:

```text
event: planner.stage
data: {"stage":"request.accepted","message":"Accepted workflow generation request."}

event: planner.stage
data: {"stage":"candidate.resolving","message":"Resolving workflow library candidates."}

event: planner.stage
data: {"stage":"composer.started","attempt":0,"message":"Streaming LLM workflow composition."}

event: message.delta
data: {"text":"{\"schemaVersion\":"}

event: planner.stage
data: {"stage":"composer.completed","attempt":0,"message":"LLM composition returned text."}

event: planner.stage
data: {"stage":"validation.completed","attempt":0,"ok":true,"message":"Workflow composition passed validation."}

event: draft
data: {"draft":{"draftId":"draft-wf-composed-...","status":"validated"}}

event: orchestration
data: {"orchestration":{"draftId":"...","taskSummaries":[...]}}

event: done
data: {}
```

If the selected runtime planner client cannot stream tokens, the endpoint emits:

```text
event: planner.stage
data: {"stage":"planner.stream.degraded","message":"Planner client does not expose true token streaming; using final text only."}
```

Then it may continue with final text generation, but it must not emit synthetic `message.delta` events.

## Backend Implementation

- Extend `PiPlannerClient` with optional `generateStream(prompt, handlers)` while preserving `generate(prompt)` for existing callers.
- Implement true streaming in `createPiSdkPlannerClient` by subscribing to SDK session events, diffing successive assistant text snapshots, emitting only the new delta, and resolving on `agent_end`.
- Add optional `streamText`/delta support to `LlmWorkflowComposer` via its `LlmTextClient`; parse/validation remains unchanged.
- Add progress hooks to `createPostgresPlannerDraft` and `runCompositionRepairLoop` so planner stages are emitted from the real backend lifecycle rather than invented in the web proxy.
- Add `POST /api/v2/planner/drafts/stream` in the runtime route layer. It builds a streaming composer for `llm` mode, calls the existing planner draft creation path, then loads orchestration and emits it before `done`.

## Web Proxy Contract

`POST /api/workflow/generate` remains the browser-facing endpoint. It must:

- Send `goalPrompt`, `cwd`, `orchestrationMode: "llm-constrained"`, and `composerMode: "llm"` to `/api/v2/planner/drafts/stream`.
- Parse backend SSE frames incrementally.
- Forward `message`, `message.delta`, `planner.stage`, `draft`, `error`, and `done`.
- Convert backend `orchestration` into frontend `WorkflowDag` and emit a frontend `dag` event.
- Close only after backend `done` or backend stream completion.

## Frontend Design

- `web/lib/workflow/generate-stream.ts` parses POST SSE using `fetch` and `ReadableStream`.
- It dispatches `message`, `message.delta`, `planner.stage`, `draft`, `dag`, `error`, and `done`.
- `web/hooks/useAgentSession.ts` intercepts Workflow-mode prompt submits and appends planner text as it streams.
- Stage events are rendered as compact text lines in the assistant streaming message. Token deltas are appended without pretending to be stage labels.
- The final assistant message includes any streamed text and one `workflowDag` content block.

## React Flow DAG Rendering

`web/components/WorkflowDagBlock.tsx` should become a wrapper around the shared React Flow canvas:

- Convert `WorkflowDag` into `WorkflowCanvasModel`.
- Use `SouthstarWorkflowCanvas` for layout, minimap, controls, and edge rendering.
- Set a bounded scroll/surface height so large DAGs remain usable in a chat message block.
- Keep Draft / Validate / Run / Retry lifecycle buttons above the canvas.
- Preserve `data-testid="workflow-dag-block"` and `data-testid="workflow-dag-scroll"`.
- Preserve node selection by mapping React Flow task selection back to the original `WorkflowDagNode`.

## Parallel DAG Correctness

The frontend DAG adapter must compute levels from dependencies, not task array index. For example:

```text
review-spec -> frontend-implement -> integrate
review-spec -> backend-implement  -> integrate
```

`frontend-implement` and `backend-implement` are parallel siblings. React Flow/ELK should render them as separate nodes in the same dependency layer.

## Tests And Verification

Automated tests:

- Pi SDK planner client emits true deltas from real session event snapshots.
- LLM composer uses streaming text client when available and preserves final JSON parsing.
- Runtime `/api/v2/planner/drafts/stream` emits `planner.stage`, real `message.delta`, `draft`, `orchestration`, and `done` in order.
- Web `/api/workflow/generate` proxies backend SSE and converts `orchestration` to `dag`.
- Frontend stream parser handles chunked frames and new event types.
- `WorkflowDagBlock` uses React Flow canvas and preserves scroll/test ids.
- Planner draft adapter computes topological levels for parallel dependencies.

Rendered verification:

- Start `npm run southstar:start`.
- Open `http://127.0.0.1:30141/`.
- Click Workflow tab.
- Submit a serial DAG prompt and confirm streaming text plus React Flow DAG.
- Submit a parallel DAG prompt and confirm visible parallel branches.
- Capture screenshots for both.
