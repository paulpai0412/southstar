# Pi-Web Workflow UI API Alignment Design

## Context

This spec extends the current pi-web Workflow mode so the UI matches the existing Southstar v2 workflow lifecycle instead of inventing a separate pi-web-only lifecycle. The previous increment added a file-first workflow library, prompt-to-DAG generation, editable workflow resources, and a transcript DAG block. The next increment must make the UI clearer and make the action buttons honest: a user should understand when changes are only local file drafts, when a Southstar planner draft exists in Postgres, when that draft is validated, when a workflow run has been materialized, and when execution has started.

There are already partial uncommitted UI changes in this workspace for moving the mode switch and making the workflow tree collapsible. This spec treats those changes as implementation progress that still needs to be reviewed, tested, and completed through the implementation plan.

## Current State

Existing pi-web workflow API surface:

- `GET /api/workflow/library`: returns workflow domains, templates, agents, and resource summaries.
- `POST /api/workflow/generate`: streams a generated DAG proposal through SSE.
- `GET /api/workflow/resources/[...path]`: reads a workflow resource from the file library or fixture fallback.
- `PUT /api/workflow/resources/[...path]`: writes workflow resource drafts to files under `.southstar/library/domains`.
- `append_workflow_dag` RPC command: persists a DAG block into a pi session custom message.

Existing Southstar v2 API surface in the parent repo:

- `GET /api/v2/agent-library`: returns the Postgres-backed agent library read model, optionally filtered by domain.
- `GET /api/v2/agent-library/candidates`: returns planner-draft-aware agent candidates for a draft/task.
- `POST /api/v2/run-goal`: creates a planner draft and immediately creates a run from the draft.
- `POST /api/v2/planner/drafts`: creates a Postgres-backed planner draft from `goalPrompt`, `orchestrationMode`, `composerMode`, `domainPackId`, `cwd`, and `libraryHints`.
- `POST /api/v2/planner/drafts/[draftId]/revise`: creates a revised planner draft from a prior draft plus a revision prompt.
- `GET /api/v2/planner/drafts/[draftId]/orchestration`: returns the planner draft orchestration view, including validation status, task summaries, orchestration snapshot, planner trace, and repair attempts.
- `POST /api/v2/planner/drafts/[draftId]/runs`: creates a workflow run from a validated planner draft.
- `POST /api/v2/runs`: creates a workflow run from `{ draftId }`.
- `POST /api/v2/runs/[runId]/execute`: starts scheduling/execution for a materialized run.
- `GET /api/v2/runs/[runId]`: returns run status.
- `GET /api/v2/runs/[runId]/tasks`: returns materialized task rows ordered by `sort_order`.
- `GET /api/v2/runs/[runId]/events`, `/events/stream`, `/exceptions`, `/artifacts`, `/sessions`, `/memory`, `/logs`, `/approvals`: return runtime read models and streams.

Existing Southstar v2 runtime primitives:

- `createPostgresPlannerDraft`: validates/composes the workflow and stores a `planner_draft` resource in `southstar.runtime_resources`.
- `revisePostgresPlannerDraft`: preserves prior planner request fields and creates a revised planner draft.
- `getPostgresPlannerDraftOrchestration`: reads the planner draft orchestration view.
- `createPostgresRunFromDraft`: requires `draft.status === "validated"`, creates `southstar.workflow_runs`, creates `southstar.workflow_tasks`, and writes `run.created` / `task.created` history events.

Missing pi-web integration surface:

- pi-web does not yet expose or consume the parent repo's v2 planner/run API.
- pi-web's current `library` route overlaps with Southstar `/api/v2/agent-library`; it should become a compatibility adapter over the v2 read model when the backend is configured.
- pi-web's current `generate` route overlaps with Southstar `/api/v2/planner/drafts` plus `/orchestration`; it should stop producing a local-only DAG when the backend is configured.
- pi-web's current `resources` route has no equivalent Southstar v2 API for arbitrary raw `.southstar/library/domains/...` file reads/writes. Keep it only as a local file-editing adapter if this requirement remains explicit, or replace it later with a Southstar-owned resource editing API.
- pi-web may keep same-origin thin proxy routes for browser ergonomics, but those routes must preserve Southstar v2 semantics instead of creating a separate workflow API model.

## Product Goals

- Move Chat, Workflow, and Operator into the existing top tab strip area so mode selection lives with session-level controls instead of consuming left sidebar height.
- Keep Export and Branch controls in the top bar, but render them as icon-only controls.
- Remove the System top-bar control from this workflow-oriented layout pass.
- Make Workflow Templates and Agent Library navigable trees with collapsible folders, not permanently expanded lists.
- Render DAG dependencies with arrows so sequential and parallel execution relationships are visible.
- Add workflow action controls that are aligned to real API semantics, not placeholder UI.
- Fix JSON resource viewing so clicking a DAG node or agent profile always shows the complete JSON content in the right file viewer.
- Preserve the pi-web shell, bottom composer, right file tabs, Models/Skills/MCP controls, and Chat mode behavior.

## Lifecycle Model

Workflow definitions move through explicit states that align with Southstar v2:

```text
file_draft -> postgres_planner_draft -> validated_planner_draft -> materialized_run -> executing_run
```

### File Draft

File draft is pi-web-local and file-first only for raw resource editing. Editing a profile, instruction, skill, MCP grant, or policy writes to `.southstar/library/domains/...` through `PUT /api/workflow/resources/[...path]` only when the user has explicitly accepted local file editing as a requirement.

File draft changes are not automatically written to Postgres. This keeps edits reviewable in Git and prevents half-edited definitions from changing active or approved runtime definitions.

If raw resource editing is not required, the right viewer should be read-only and sourced from Southstar v2 read models. Do not add broader pi-web resource APIs without confirmation.

### Postgres Planner Draft

The Draft action creates a Southstar planner draft by calling the existing v2 draft creation contract through a pi-web proxy:

```text
POST /api/workflow/planner-drafts -> POST /api/v2/planner/drafts
```

The Southstar v2 draft API composes and validates a manifest, writes a `planner_draft` runtime resource to Postgres, and returns:

- `draftId`
- `goalPrompt`
- `workflowId`
- `status`
- `validationIssues`
- `taskSummaries`

The returned `status` is the source of truth for whether the draft is validated.

### Validated Planner Draft

The Validate action reads the current planner draft orchestration view:

```text
GET /api/workflow/planner-drafts/[draftId]/orchestration -> GET /api/v2/planner/drafts/[draftId]/orchestration
```

This returns the same draft status plus orchestration details. If `status` is `validated`, the workflow can be materialized into a run. If `status` is `invalid` or validation issues are present, Run remains disabled and the DAG header shows the blocking issues.

### Materialized And Executing Run

The Run action is the user-facing execution command. It first performs a preflight orchestration read to confirm the planner draft is still `validated`, then creates a workflow run from the validated planner draft:

```text
POST /api/workflow/planner-drafts/[draftId]/runs -> POST /api/v2/planner/drafts/[draftId]/runs
```

This maps to `createPostgresRunFromDraft`. That primitive writes to `southstar.workflow_runs` and `southstar.workflow_tasks`. It rejects drafts whose status is not `validated`.

After run materialization succeeds, the same user-facing Run action starts scheduling/execution:

```text
POST /api/workflow/runs/[runId]/execute -> POST /api/v2/runs/[runId]/execute
```

The confirmation text must make both effects explicit:

> Run will validate the planner draft, create workflow run rows, and start execution.

If run creation succeeds but execute fails, pi-web must keep the returned `runId`, show `created but not executing`, and offer a retry execute action in the lifecycle notice or future Operator mode. It must not hide the materialized run from the user.

Operator mode remains out of scope except as a disabled future tab.

## API Design

### `GET /api/workflow/status`

Returns backend capability flags so UI can enable or label actions.

Response:

```json
{
  "capabilities": {
    "validate": true,
    "createDraft": true,
    "createRun": true,
    "execute": true,
    "run": true,
    "postgres": true,
    "v2Backend": true
  }
}
```

### `GET /api/workflow/library`

Compatibility adapter for the current pi-web UI. When `SOUTHSTAR_V2_API_BASE_URL` is configured, this route maps to:

```text
GET /api/workflow/library -> GET /api/v2/agent-library
```

It may reshape the v2 read model into the existing sidebar tree shape, but it must not invent fixture-only agent definitions when the v2 backend is available. Fixture fallback is allowed only for isolated local development and must be labeled as fallback/mock in the response.

### `POST /api/workflow/generate`

Compatibility adapter for the current workflow prompt UI. When `SOUTHSTAR_V2_API_BASE_URL` is configured, this route maps to:

```text
POST /api/workflow/generate -> POST /api/v2/planner/drafts
GET draft orchestration       -> GET /api/v2/planner/drafts/[draftId]/orchestration
```

The returned DAG block should be derived from the planner draft result and orchestration/task summaries. If streaming SSE is still required, that is a pi-web UI transport detail over v2 results, not a separate planner implementation.

### `GET/PUT /api/workflow/resources/[...path]`

This route has no equivalent Southstar v2 route today. It is allowed only for the explicit local file-editing requirement:

```text
GET/PUT /api/workflow/resources/[...path] -> local .southstar/library/domains file read/write
```

Before expanding this beyond local file editing, add a Southstar-owned API or get user confirmation that a pi-web-local editor API is intended.

### `POST /api/workflow/planner-drafts`

Request:

```json
{
  "cwd": "/abs/project",
  "goalPrompt": "Build the feature workflow",
  "orchestrationMode": "llm-constrained",
  "composerMode": "llm-with-fixture-fallback",
  "domainPackId": "software",
  "libraryHints": {
    "agentProfileRefs": ["software-maker-pi"]
  }
}
```

Response:

```json
{
  "draftId": "draft-wf-composed-abc123",
  "goalPrompt": "Build the feature workflow",
  "workflowId": "wf-composed-abc123",
  "status": "validated",
  "validationIssues": [],
  "taskSummaries": [
    {
      "taskId": "plan",
      "taskName": "Plan",
      "dependsOn": [],
      "agentProfileRef": "software-maker-pi"
    }
  ]
}
```

### `POST /api/workflow/planner-drafts/[draftId]/revise`

Request:

```json
{
  "prompt": "Make the validation task run before implementation",
  "orchestrationMode": "llm-constrained",
  "composerMode": "llm-with-fixture-fallback"
}
```

Response: same shape as `POST /api/workflow/planner-drafts`.

### `GET /api/workflow/planner-drafts/[draftId]/orchestration`

Response:

```json
{
  "draftId": "draft-wf-composed-abc123",
  "goalPrompt": "Build the feature workflow",
  "workflowId": "wf-composed-abc123",
  "status": "validated",
  "validationIssues": [],
  "taskSummaries": [],
  "orchestrationSnapshot": {
    "validation": {
      "ok": true,
      "issues": []
    }
  },
  "plannerTrace": {
    "model": "southstar-library-constrained-llm-with-fixture-fallback-composer"
  },
  "repairAttempts": []
}
```

### `POST /api/workflow/planner-drafts/[draftId]/runs`

Request:

```json
{
  "confirm": true
}
```

Response:

```json
{
  "runId": "wf-composed-abc123-1",
  "taskIds": ["plan", "implement", "validate"],
  "execute": {
    "status": "scheduling",
    "runId": "wf-composed-abc123-1"
  }
}
```

### `POST /api/workflow/runs/[runId]/execute`

Request:

```json
{
  "confirm": true
}
```

Response:

```json
{
  "status": "scheduling",
  "runId": "wf-composed-abc123-1"
}
```

### `GET /api/workflow/runs/[runId]`

Response:

```json
{
  "run": {
    "id": "wf-composed-abc123-1",
    "status": "created"
  }
}
```

### `GET /api/workflow/runs/[runId]/tasks`

Response:

```json
{
  "tasks": [
    {
      "id": "plan",
      "status": "pending",
      "depends_on": []
    }
  ]
}
```

### Backend Unavailable Response

```json
{
  "status": "blocked",
  "error": "Southstar v2 workflow API is not configured"
}
```

This response is used by proxy routes when the parent v2 server base URL or DB-backed runtime is unavailable. pi-web must not pretend a workflow was written to Postgres.

## API Mapping

The pi-web adapter maps same-origin browser routes to the parent v2 API:

```text
GET  /api/workflow/status                              -> local capability check plus v2 health check
GET  /api/workflow/library                             -> GET /api/v2/agent-library when configured
POST /api/workflow/generate                            -> POST /api/v2/planner/drafts plus orchestration when configured
GET  /api/workflow/resources/:path                     -> local file read only when resource editing is enabled
PUT  /api/workflow/resources/:path                     -> local file write only when resource editing is enabled
POST /api/workflow/planner-drafts                     -> POST /api/v2/planner/drafts
POST /api/workflow/planner-drafts/:draftId/revise     -> POST /api/v2/planner/drafts/:draftId/revise
GET  /api/workflow/planner-drafts/:draftId/orchestration -> GET /api/v2/planner/drafts/:draftId/orchestration
POST /api/workflow/planner-drafts/:draftId/runs       -> POST /api/v2/planner/drafts/:draftId/runs
POST /api/workflow/runs                               -> POST /api/v2/runs
POST /api/workflow/runs/:runId/execute                -> POST /api/v2/runs/:runId/execute
GET  /api/workflow/runs/:runId                        -> GET /api/v2/runs/:runId
GET  /api/workflow/runs/:runId/tasks                  -> GET /api/v2/runs/:runId/tasks
```

## UI Design

### Top Bar Mode Tabs

`AppModeRail` becomes a horizontal top-bar control. It sits in the existing top tab/control row, near the sidebar toggle and theme button. It keeps the existing `data-testid` values so E2E tests can still locate `mode-chat`, `mode-workflow`, and `mode-operator`.

Export and Branch remain immediately adjacent top-bar controls, but icon-only:

- Export uses the current download icon and title tooltip.
- Branch uses the current branch icon and title tooltip.
- System is removed from this pass.

Session stats remain right-aligned.

### Workflow Sidebar Tree

Workflow Templates and Agent Library are collapsible sections. Each section contains a tree:

- section header disclosure
- domain folder disclosure
- workflows/agents folder disclosure
- agent folder disclosure
- skills/mcp/policies folder disclosure
- file rows opening the right resource viewer

The initial state is expanded for continuity with the previous UI. Rows must be compact and token-based, matching `FileExplorer` rather than a form-heavy admin panel.

### DAG Diagram

The DAG block remains inline in the transcript and expanded by default.

The expanded body should arrange nodes by `level`. Nodes with the same `level` appear in the same column and represent parallel work. Edges are drawn as SVG arrows from dependency source nodes to target nodes. The current linear fixture will display a straight left-to-right chain, and future parallel DAGs will show multiple nodes in the same level.

Header content:

- DAG label
- template title
- readiness badge
- node count
- action controls

Action controls:

- `Draft`: creates or revises a Southstar planner draft through `POST /api/workflow/planner-drafts` or `/revise`.
- `Validate`: refreshes planner draft orchestration through `GET /api/workflow/planner-drafts/[draftId]/orchestration`.
- `Run`: confirms the action, refreshes orchestration as a preflight, calls `POST /api/workflow/planner-drafts/[draftId]/runs`, then calls `POST /api/workflow/runs/[runId]/execute`; enabled only when a planner draft exists and the latest known status is `validated`.

The user initially asked for Draft / Validate / Run. That three-button model aligns with the existing API because `Draft` is the Postgres planner draft creation boundary and `Run` is the workflow run materialization plus execution-start boundary. A separate `Sync` or `Execute` button is not required in this UI increment because Southstar already uses `planner_draft`, `workflow_runs`, `workflow_tasks`, and `/execute` as separate backend primitives.

### JSON Resource Viewer

The right viewer currently uses `StructuredJsonEditor` for both read-only and editing states. Read-only mode should show complete, formatted JSON in a scrollable `<pre>` so long profiles do not appear truncated. Edit mode keeps the raw textarea and structured fields.

Validation errors still disable Save. Reset still restores the last loaded content.

## Error Handling

- Planner draft API errors should display as inline DAG action notices.
- Validation issues returned by the orchestration view should not throw; they are successful reads with blocking issues.
- v2 backend unavailable should disable Draft, Validate, and Run with a clear blocked message.
- Run without a validated `draftId` should be prevented in the UI and rejected by the API.
- If Run creates rows but execute fails, the UI must show the created `runId` and surface a retry execute action or clear next step.
- JSON parse errors remain local to the resource viewer and prevent file save.

## Testing

Unit tests:

- planner draft proxy forwards request bodies and returns v2 draft responses.
- orchestration proxy returns validation issues without converting them to thrown UI errors.
- run proxy rejects missing `draftId` and propagates v2 rejection when the planner draft is not validated.
- lifecycle helper keeps `runId` when execute fails after successful run creation.
- DAG layout helper assigns same-level nodes to parallel columns and emits arrow edges for dependencies.

E2E tests:

- mode tabs render in the top bar and sidebar no longer contains the old mode rail.
- Export and Branch controls are icon-only.
- workflow template and agent tree folders collapse and expand.
- generated DAG block shows an arrowed diagram and action controls.
- Draft creates a planner draft, Validate refreshes orchestration, and Run performs preflight validate plus create-run plus execute.
- v2 backend unavailable disables lifecycle actions with a clear blocked state.
- JSON profile viewer shows full content in read-only mode and still supports edit/reset/save.

## Out Of Scope

- Building the full Operator runtime board.
- Implementing a new Postgres schema migration. The existing Southstar v2 tables and runtime store are the source of truth.
- Building a new workflow definition-version system separate from `planner_draft`, `workflow_runs`, and `workflow_tasks`.
- Implementing Operator-mode runtime monitoring beyond showing the created/executing run status returned by existing v2 routes.
- Replacing the existing pi-web session model.

## Acceptance Criteria

- The UI no longer implies that Run can execute a local file-only draft.
- The Postgres write boundaries are explicit: Draft creates a `planner_draft`; Run creates `workflow_runs` and `workflow_tasks`, then starts execution.
- A workflow is only runnable after the planner draft status is `validated`, including Run's preflight validation.
- Workflow UI layout changes are covered by Playwright E2E.
- Existing workflow E2E tests continue to pass.
- Existing Chat mode behavior remains intact.
