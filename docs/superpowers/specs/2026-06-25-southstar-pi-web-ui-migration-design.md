# Southstar Pi-Web UI Migration Design

Date: 2026-06-25

## Goal

Migrate the full `~/apps/pi-web` frontend into Southstar as the single Next.js app shell, keep the existing `pi-web` visual style, and reshape the workspace tabs around Southstar runtime concepts:

```text
Chat | Workflow | Operator
```

The UI must not become a new Southstar product style. It should keep the compact IDE-like `pi-web` shell, sidebar, top tab bar, right file viewer, light/dark CSS variables, small typography, thin borders, dense panels, and existing chat ergonomics.

## Non-Goals

- Do not redesign the visual system from scratch.
- Do not keep Northstar issue lifecycle columns as the main Operator model.
- Do not let the browser manually mutate workflow task, edge, role, or agent-profile definitions in the first version.
- Do not duplicate runtime state in frontend-only state machines.
- Do not make the DAG a static list; it is the main visual surface.

## Current Context

Southstar already has v2 runtime APIs, read models, workflow draft creation, dynamic workflow materialization, task envelopes, managed agent runtime, executor reconciliation, runtime exceptions, recovery decisions, and SSE event streaming.

`pi-web` already provides the frontend shell shape to preserve:

- project/session sidebar
- chat workspace
- top workspace tabs
- right file viewer with tabs
- model and skill controls
- light/dark theme variables
- Northstar workspace view registry pattern

The migration should take `pi-web` as the UI base and replace the Northstar workspace view with Southstar-owned `Workflow` and `Operator` views.

## Information Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│ sidebar │ Chat | Workflow | Operator                         file    │
│         ├──────────────────────────────────────────────────── viewer  │
│         │ selected workspace view                                    │
└─────────┴────────────────────────────────────────────────────────────┘
```

### Chat

The `Chat` tab keeps the original `pi-web` chat panel behavior:

- freeform agent conversation
- existing session sidebar
- existing `ChatWindow`, `ChatInput`, minimap, branch navigation, model controls, skill controls, and file viewer
- no Southstar workflow orchestration responsibility

### Workflow

The `Workflow` tab is a prompt-to-workflow workbench. It turns a goal prompt into a reviewable workflow DAG, agent definitions, agent profiles, role assignments, skill/MCP/tool grants, artifact contracts, validation issues, and repair attempts.

### Operator

The `Operator` tab is a runtime control tower. It shows all active runs and all operator-attention items, then projects the selected run onto the same workflow DAG visual language with runtime state overlays and intervention commands.

## Workflow Tab Design

`Workflow` is the workflow-definition and pre-run review surface.

```text
Workflow
┌──────────────────────┬──────────────────────────────────────┬──────────────────────┐
│ Goal + Agent Library  │ Workflow DAG Canvas                  │ Definition Inspector │
│                      │                                      │                      │
│ goal prompt           │ [analyze] -> [implement] -> [verify] │ selected task        │
│ domain pack           │                └-> [review]          │ role definition      │
│ repo/cwd context      │                                      │ agent profile        │
│ role/profile hints    │ node badges: role/profile/skills     │ skills/MCP/tools     │
│ skills                │ edge badges: dependency gate         │ artifact contract    │
│ MCP/tools             │                                      │ validation/repair    │
│ vault policy          │                                      │                      │
│                      │                                      │ [Revise] [Run]       │
└──────────────────────┴──────────────────────────────────────┴──────────────────────┘
```

### Goal And Context Panel

The left panel combines the goal prompt and the Agent Library context. It uses the `pi-web` input and panel style, not the current Southstar product-shell style.

Inputs:

- goal prompt
- selected cwd/repo context
- domain pack
- orchestration mode
- composer mode
- role/profile hints
- skill hints
- model hints
- MCP/tool/vault hints

Only essential settings are visible by default. Advanced hints are collapsible.

### Agent Library

Agent Library is a first-class Workflow tab section. It is the capability surface available to the planner and reviewer.

Agent Library includes:

- role definitions
- agent profiles
- skill catalog
- MCP server and grant catalog
- tool policy and allowed tools
- vault lease policy
- artifact contracts
- evaluator pipelines
- context and memory policy

UI behavior:

- The left panel shows available library context for the selected domain.
- DAG nodes show compact badges for selected role, profile, skill count, tool grants, and MCP grants.
- The Definition Inspector shows the selected task's actual materialized library refs.
- `Library alternatives` can open as a drawer to show selected refs, alternatives, and selection reasons.
- Users revise library choices through revision prompts instead of directly mutating the manifest.

### Workflow Draft Canvas

The center canvas is the primary visual surface. It renders the whole workflow DAG, not a table or vertical list.

Draft-mode node information:

- task id and task label
- role ref
- agent profile ref
- artifact kind
- skill count
- MCP/tool grant count
- validation status
- repair status

Draft-mode edge information:

- dependency direction
- dependency gate
- fan-out/fan-in shape
- blocked validation state when applicable

### Definition Inspector

The right panel explains the selected DAG node.

It shows:

- task summary
- role definition
- agent profile
- selected skills
- MCP grants
- tool grants
- vault policy
- artifact contract
- evaluator pipeline
- context policy
- validation issues
- repair attempts
- planner trace references

The inspector can submit a revision prompt, but it does not manually edit graph internals in the first version.

### Workflow Run Handoff

`Run Workflow` creates a run from the draft and opens the Operator tab with the new `runId` selected.

The same DAG appears in Operator mode, but the overlay changes from definition state to runtime state.

## Workflow Canvas Technology

Use `@xyflow/react` for the interactive graph renderer and `elkjs` for automatic DAG layout.

Rationale:

- Southstar needs an interactive graph with pan, zoom, node selection, custom node cards, custom arrows, minimap, controls, and fit-to-selection.
- Workflow nodes must be React components so they can show role/profile/skill/tool badges and runtime status without custom pixel drawing.
- DAG layout must handle fan-out, fan-in, multi-dependency workflows, and readable arrow routing.
- Frontend should render semantic graph models, not own workflow source-of-truth state.

Do not hand-roll a raw `<canvas>` graph for the first implementation. The requirement is an inspectable workflow control surface, not low-level drawing.

### Component Layout

```text
components/southstar/workflow-canvas/
  SouthstarWorkflowCanvas.tsx
  WorkflowTaskNode.tsx
  WorkflowDependencyEdge.tsx
  layout.ts
  colors.ts
  types.ts
```

### Canvas Data Contract

The backend returns semantic graph data. The frontend computes pixel positions with `elkjs` and persists only viewport and selection.

```ts
type WorkflowCanvasModel = {
  graphId: string;
  mode: "draft" | "runtime";
  nodes: Array<{
    id: string;
    label: string;
    kind: "task";
    status: string;
    roleRef?: string;
    agentProfileRef?: string;
    artifactKind?: string;
    badges: Array<{ tone: string; label: string }>;
    attention?: {
      severity: "info" | "warning" | "error" | "blocked";
      reason: string;
    };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    status: "pending" | "ready" | "active" | "blocked" | "satisfied";
  }>;
  selectedNodeId?: string;
};
```

### Color Management

Canvas colors live in `colors.ts`, using `pi-web` CSS variables as the base.

```text
pending/created       gray
queued/scheduling     amber
running               blue
completed/passed      green
paused                muted amber
blocked/exception     red
approval needed       purple/amber badge
failed/cancelled      red/dim
```

Edges:

```text
gray solid       dependency exists
green solid      dependency satisfied
amber dashed     waiting on upstream
red solid        blocked by failed/exception dependency
blue animated    active path
```

This adds state colors without changing the `pi-web` shell style.

## Operator Tab Design

Operator uses an exception-first interaction model while still showing all active runs.

```text
Operator
┌────────────────────────────────────────────────────────────────────────────┐
│ Active Runs: run-42 running | run-43 scheduling | run-39 paused | health   │
├──────────────────────┬───────────────────────────────┬─────────────────────┤
│ Attention Queue       │ Workflow Runtime Canvas        │ Intervention Panel  │
│                      │                               │                     │
│ Critical             │ selected run DAG                │ selected item       │
│ - exception          │ [plan ✓] -> [build !] -> [qa]  │ commands/evidence   │
│ - approval           │                               │                     │
│ Warning              │ node = task runtime state       │ event stream        │
│ - heartbeat stale    │ badge = exception/approval      │ recovery decisions  │
│                      │ edge = dependency readiness     │ task envelope       │
│ Info / Watch         │                               │                     │
│ - active normal run  │                               │                     │
└──────────────────────┴───────────────────────────────┴─────────────────────┘
```

### Active Runs

The top run strip shows all non-terminal runs:

- created
- scheduling
- running
- paused
- blocked

Clicking a run changes the selected run and refreshes the runtime canvas.

### Attention Queue

The attention queue shows all items that require or may soon require operator attention:

- runtime exceptions
- approval requests
- recovery decisions
- stale executor heartbeat
- queue timeout
- callback missing
- blocked dependency
- failed task
- paused run
- normal active run as low-priority watch item

Sort order:

```text
blocked/error > approval pending > stale/warning > paused > normal watch
```

Clicking an item selects its run, focuses the related DAG node, and opens the appropriate intervention panel.

### Workflow Runtime Canvas

Operator uses the same `SouthstarWorkflowCanvas` in runtime mode.

Runtime overlays:

- task status
- accepted artifact state
- dependency readiness
- executor status
- exception badge
- approval badge
- recovery-decision badge
- active path animation

### Intervention Panel

The right panel shows contextual detail and commands.

Panel modes:

- run detail
- task detail
- exception detail
- executor detail
- approval detail
- recovery decision detail

Commands are rendered from API affordances whenever possible. The frontend should not encode state transitions beyond display logic.

Risky commands require confirmation and reason input.

## API Contract

### Workflow APIs

```text
POST /api/v2/planner/drafts
GET  /api/v2/planner/drafts/:draftId/orchestration
POST /api/v2/planner/drafts/:draftId/revise
POST /api/v2/planner/drafts/:draftId/runs
GET  /api/v2/runs/:runId/tasks/:taskId/envelope
```

Workflow read model:

```text
GET /api/v2/ui/workflow?draftId=&runId=
  -> activeDraft
  -> canvasModel
  -> selectedDefinition
  -> agentLibrarySummary
  -> validationIssues
  -> repairAttempts
  -> commands
```

### Agent Library APIs

```text
GET /api/v2/agent-library?domain=software
  -> roles[]
  -> agentProfiles[]
  -> skills[]
  -> mcpServers[]
  -> tools[]
  -> artifactContracts[]
  -> evaluatorPipelines[]

GET /api/v2/agent-library/candidates?draftId=&taskId=
  -> selectedRefs
  -> alternatives
  -> selectionReasons
  -> validationWarnings
```

Planner draft request can include optional library hints:

```ts
type PlannerDraftRequest = {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: "fixture" | "llm" | "llm-with-fixture-fallback";
  domainPackId?: string;
  cwd?: string;
  libraryHints?: {
    roleRefs?: string[];
    agentProfileRefs?: string[];
    skillRefs?: string[];
    mcpGrantRefs?: string[];
    toolRefs?: string[];
    modelHints?: Record<string, string>;
  };
};
```

### Operator APIs

```text
GET /api/v2/ui/operator-overview
  -> activeRuns[]
  -> attentionItems[]
  -> runtimeHealth
  -> defaultSelection

GET /api/v2/read-models/workflow-dag/:runId
GET /api/v2/read-models/run-control/:runId
GET /api/v2/read-models/exceptions/:runId
GET /api/v2/runs/:runId/events?after=...
GET /api/v2/runs/:runId/events/stream
GET /api/v2/runs/:runId/actions
GET /api/v2/runs/:runId/tasks/:taskId/actions
GET /api/v2/runs/:runId/executor-jobs/:jobId/actions
```

Intervention commands:

```text
POST /api/v2/runs/:runId/pause
POST /api/v2/runs/:runId/resume
POST /api/v2/runs/:runId/cancel

POST /api/v2/runs/:runId/tasks/:taskId/retry
POST /api/v2/runs/:runId/tasks/:taskId/fork-session
POST /api/v2/runs/:runId/tasks/:taskId/request-revision

POST /api/v2/runs/:runId/executor-jobs/:jobId/reconcile
POST /api/v2/runs/:runId/executor-jobs/:jobId/cancel

POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval
POST /api/v2/runs/:runId/recovery-decisions/:decisionId/apply
```

## Migration Map

Preserve from `pi-web`:

```text
components/AppShell.tsx
components/SessionSidebar.tsx
components/ChatWindow.tsx
components/ChatInput.tsx
components/FileViewer.tsx
components/TabBar.tsx
components/ModelsConfig.tsx
components/SkillsConfig.tsx
hooks/useTheme.ts
app/globals.css
```

Rename and rewire:

```text
components/northstar/WorkspaceTabs.tsx
  -> components/southstar/workspace/WorkspaceTabs.tsx
  tabs: Chat | Workflow | Operator

components/northstar/workspace-views.tsx
  -> components/southstar/workspace/workspace-views.tsx
  registry views: workflow, operator

components/northstar/NorthstarBoard.tsx
  -> components/southstar/operator/OperatorBoard.tsx
  replace lifecycle columns with active runs, attention queue, runtime canvas

components/northstar/IssueDrawer.tsx
  -> components/southstar/operator/InterventionPanel.tsx
  replace issue detail with run/task/exception/recovery detail

components/northstar/IssueSseModal.tsx
components/northstar/WatchSsePanel.tsx
  -> components/southstar/operator/RunEventStreamPanel.tsx
  connect to /api/v2/runs/:runId/events/stream
```

Reuse Southstar components after restyling to `pi-web` tokens:

```text
components/southstar/workflow/*
components/southstar/operator/*
lib/southstar/api-client.ts
```

The current Southstar product shell should not become the target UI style. It can be mined for data flow and component ideas, but the final app shell is the migrated `pi-web` shell.

## Data Flow

### Workflow Draft Flow

```text
goal prompt
  -> POST /api/v2/planner/drafts
  -> GET /api/v2/planner/drafts/:draftId/orchestration
  -> GET /api/v2/ui/workflow?draftId=...
  -> render draft canvas + definition inspector
  -> optional revision prompt
  -> POST /api/v2/planner/drafts/:draftId/runs
  -> open Operator with runId
```

### Operator Runtime Flow

```text
GET /api/v2/ui/operator-overview
  -> select run or attention item
  -> GET workflow-dag/run-control/exceptions
  -> open /events/stream
  -> render runtime canvas
  -> invoke command affordances
  -> update overview/canvas/panel from API response and SSE
```

## Error Handling

Workflow errors:

- draft invalid: show validation issues in canvas badges and inspector
- LLM/composer failure: show planner error in left panel and keep last valid draft visible
- repair attempts exhausted: show repair trace and disable run command
- agent library unavailable: show degraded library state and explain which refs are missing

Operator errors:

- SSE disconnect: show reconnecting state, keep last snapshot
- command rejected: show command result and disabled reason
- command applied but state not yet updated: show pending command status until next read model/SSE update
- missing run/task: show stale selection recovery and return to overview
- executor observation unavailable: disable reconcile command with reason

## Testing Strategy

Unit and component tests:

- `WorkflowCanvasModel` maps draft tasks to React Flow nodes/edges.
- Runtime read model maps task/exceptions/approvals to node badges and edge states.
- Color mapping covers all run/task/exception statuses.
- Agent Library panel renders roles, profiles, skills, MCP, tools, and selection alternatives.
- Intervention panel renders only enabled API commands and shows disabled reasons.

API contract tests:

- `GET /api/v2/ui/workflow` returns draft canvas, agent library summary, selected definition, validation issues, and repair attempts.
- `GET /api/v2/ui/operator-overview` returns active runs plus all attention item classes.
- Existing runtime command APIs keep idempotent command request semantics.
- Event stream reconnect resumes with `Last-Event-ID` or `after` sequence.

Browser tests:

- app opens with `Chat | Workflow | Operator` tabs in the `pi-web` visual style.
- `Chat` keeps session sidebar, chat panel, and file viewer behavior.
- `Workflow` generates a draft and renders the full DAG canvas with arrows.
- selecting a DAG node opens Definition Inspector with role/profile/skills/tools.
- running a draft opens Operator with the selected run.
- Operator shows active runs and attention queue together.
- selecting an attention item focuses the DAG node and opens Intervention Panel.
- canvas fit-view, pan, zoom, minimap, and selection remain usable on desktop and mobile widths.

Real E2E:

- dynamic workflow materialization produces task envelopes with materialized refs before callback completion.
- Operator can observe scheduling, executor submission, heartbeat, callback completion, exception creation, recovery decision, and run completion through read models and SSE.
- No plaintext secret appears in persisted UI surfaces.

## Acceptance Criteria

- `pi-web` shell and styling are preserved as the Southstar frontend base.
- Top tabs are exactly `Chat | Workflow | Operator`.
- `Workflow` uses an interactive DAG canvas as the primary visual surface.
- DAG canvas shows the full workflow with arrows, status colors, badges, pan/zoom, selection, fit view, and minimap.
- Agent Library is visible in Workflow and includes skills, MCP, tools, profiles, roles, artifact contracts, evaluator pipelines, and policy context.
- Workflow draft editing is prompt-based, not manual graph mutation.
- `Operator` shows both active runs and attention items.
- Operator uses workflow-first runtime projection rather than Northstar lifecycle columns.
- Intervention actions come from Southstar API command affordances.
- Workflow and Operator share the same `SouthstarWorkflowCanvas` component with draft/runtime overlays.
- Browser tests verify the migrated shell and DAG canvas behavior.
