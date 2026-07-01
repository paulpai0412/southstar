# AGENTS.md

This file guides coding agents working in the Southstar web app.

## What This App Is

`web/` is the active Next.js UI for Southstar. It started from pi-web, but now combines:

- Pi session browsing and chat.
- Southstar workflow planning and launch.
- Operator monitoring, task inspection, recovery, and artifacts.

The root repository Next app is retired. Do not run Next.js from the repository root when debugging the UI. Use this directory.

## Commands

```bash
npm install
npm run dev
npm run build
npm run lint
```

From the repository root:

```bash
npm --prefix web run dev
npm --prefix web run build
```

The local dev server listens on `http://127.0.0.1:30141`.

`npm run southstar:start` from the repository root also starts this web app as part of the full local stack.

## Runtime Configuration

The web app talks to the Southstar runtime server through route handlers in `app/api/*`.

Important environment variables:

- `SOUTHSTAR_SERVER_URL`
- `SOUTHSTAR_V2_API_BASE_URL`
- `NEXT_PUBLIC_SOUTHSTAR_SERVER_URL`

The default runtime server URL is `http://127.0.0.1:3100`.

## App Entry

- `app/page.tsx` imports `AppShell` from `components/AppShell.tsx`.
- This is intentional. `AppShell` is the integrated shell for chat, workflow, and operator modes.
- If Next reports `Module not found: Can't resolve '@/components/AppShell'`, confirm the command is running from `web/` with this `tsconfig.json`. That error usually means the wrong project root or dependency tree is being used.

## UI Structure

Main shell:

- `components/AppShell.tsx` - URL state, mode state, top panels, sidebars, sidecar tabs, chat/workflow/operator composition.
- `components/AppModeRail.tsx` - chat/workflow/operator mode switcher.
- `components/SidecarShell.tsx` - floating/pinned/expanded sidecar for files, resources, and task detail.

Chat:

- `components/SessionSidebar.tsx` - project/session navigation and file explorer entry.
- `components/ChatWindow.tsx` - session messages, SSE reconnect, fork/branch behavior, session stats.
- `components/ChatInput.tsx` - prompt input, model/tools/thinking/compact controls.
- `components/MessageView.tsx`, `MarkdownBody.tsx`, `ChatMinimap.tsx`, `BranchNavigator.tsx`.

Workflow:

- `components/WorkflowSidebar.tsx` - workflow library, planner drafts, and run launch entry points.
- `components/WorkflowDagBlock.tsx` and `components/workflow-canvas/*` - workflow DAG visualization.
- `components/WorkflowLaunchPreview.tsx` - launch preview and approval.
- `components/WorkflowNodeProfile*` - task/profile recommendations and overrides.
- `components/WorkflowResourceViewer.tsx` - runtime resources, artifacts, and envelopes.

Operator:

- `components/operator/OperatorWorkspace.tsx` - top-level operator surface.
- `OperatorHealthStrip`, `OperatorStateBoard`, `OperatorWorkflowProgress`, `OperatorIncidentPanel`, `OperatorTaskTabs`, `OperatorActionsPanel`, `OperatorArtifactsPanel`, `OperatorHistoryPanel`, `OperatorLiveStream`.

## Current Web Design Architecture

The web app is a single-shell application. `AppShell` owns global UI state and delegates to focused surfaces.

### AppShell Responsibilities

`AppShell` currently owns:

- The active mode: `chat`, `workflow`, or `operator`.
- URL query state for selected session/run/task.
- The active project cwd and persisted cwd localStorage key.
- Sidebar visibility and sidecar mode/width/tabs.
- Chat branch/session stat panels.
- Workflow selected template/session state.
- Operator selected run/task/incident state.
- Top-level modal state for models, skills, and MCP configuration.

Because `AppShell` coordinates cross-mode state, do not split it casually. Extract leaf components only when a boundary is stable and props are clear.

### Runtime API Proxy Pattern

Browser components should call local Next routes, not the runtime server directly. Route handlers then call `lib/workflow/v2-api.ts` or related helpers.

```text
component
  -> /api/workflow/* or /api/operator/*
  -> web route handler
  -> lib/workflow/v2-api.ts
  -> Southstar runtime /api/v2/*
  -> Postgres/read model
```

This keeps CORS, runtime URL selection, and envelope handling out of React components.

### Operator Projection Pattern

Operator UI renders projected read models:

- `useOperatorOverview` fetches overview state.
- `lib/operator/incidents.ts` derives incident/priority views.
- `lib/operator/taskDag.ts` converts runtime UI models into workflow canvas data.
- `components/operator/*` render the resulting state.

Do not make operator components query raw Postgres or infer lifecycle state from logs.

### Workflow Draft Pattern

Workflow UI talks to planner draft and run endpoints:

- Draft creation/revision streams through `app/api/workflow/planner-drafts/stream` and `revise/stream`.
- Draft validation and run creation are proxied through `app/api/workflow/planner-drafts/*`.
- Workflow library and candidate data comes from runtime agent-library endpoints.
- DAG rendering uses `components/workflow-canvas/*`.

React components should treat runtime responses as API contracts, not mutate manifest shape ad hoc.

## API Routes

Pi/chat routes:

- `app/api/sessions/*` reads local Pi session files.
- `app/api/agent/*` creates/drives in-process Pi `AgentSession` wrappers and SSE.
- `app/api/models*`, `app/api/auth/*`, and `app/api/skills/*` expose model/auth/skill management.
- `app/api/files/[...path]` reads files within allowed project/session scopes.

Southstar routes:

- `app/api/workflow/*` proxies workflow planning, drafts, validation, runs, resources, and UI models to the runtime server.
- `app/api/operator/*` proxies operator overview, commands, task debug, and stream endpoints.

Shared helpers:

- `lib/workflow/v2-api.ts` - runtime server URL construction and JSON proxy helpers.
- `lib/workflow/*` - workflow library adapters, validation helpers, and generated model types.
- `lib/operator/*` - operator read-model shaping, incidents, task DAG projections.
- `lib/rpc-manager.ts` - Pi `AgentSessionWrapper` lifecycle.
- `lib/session-reader.ts` - read-only parsing of Pi `.jsonl` session files.

## Data Flow

### Workflow Planning And Launch

1. Browser UI calls `app/api/workflow/*`.
2. Web route handlers proxy to `/api/v2/*` on the Southstar runtime server.
3. Runtime services return planner drafts, validated workflow manifests, run records, and UI models.
4. UI components render workflow DAGs, library objects, launch previews, run status, and resources.

### Operator Monitoring

1. Browser calls `app/api/operator/overview` and related routes.
2. Web proxies to runtime UI/read-model endpoints.
3. Operator components render health, priority lanes, task progress, incidents, artifacts, history, and recovery actions.

### Chat And Session Browsing

1. Session browsing reads local `.jsonl` files via `lib/session-reader.ts`; this does not create an agent session.
2. Sending a chat message calls `app/api/agent/[id]`, which uses `lib/rpc-manager.ts` to create or reuse an in-process Pi `AgentSession`.
3. Streaming uses `app/api/agent/[id]/events`.

## Development Notes

- Keep `@/*` imports rooted at this `web/` directory. The `paths` mapping in `tsconfig.json` is `"@/*": ["./*"]`.
- Do not move `AppShell` out of `components/` without updating `app/page.tsx` and all root assumptions.
- Avoid writing secrets to browser-visible responses, local logs, session exports, or runtime history.
- Keep route handlers thin. Put reusable shaping/proxy logic under `lib/`.
- When changing UI imports, production-only routing, or Next config, run `npm run build`.
- When changing runtime API assumptions, also verify the runtime server endpoint or read model that feeds the UI.
