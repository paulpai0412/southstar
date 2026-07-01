# Southstar Web

Southstar Web is the browser UI for the Southstar runtime. It combines pi-web style chat/session browsing with Southstar workflow planning and operator monitoring.

The active app lives in this `web/` directory. The repository root Next app is retired.

## Quick Start

From this directory:

```bash
npm install
npm run dev
```

From the repository root:

```bash
npm --prefix web install
npm --prefix web run dev
```

Open `http://127.0.0.1:30141`.

For the full local stack, run this from the repository root:

```bash
npm run southstar:start
```

That starts Postgres, Tork, the Southstar runtime server, and this web app.

## Features

- **Chat**: browse local Pi sessions, continue conversations, fork from previous messages, inspect project files, and manage models/skills.
- **Workflow**: generate Southstar workflow drafts, inspect DAGs, edit task profiles, validate manifests, and launch runs.
- **Operator**: monitor workflow runs, inspect task progress, view artifacts/history, and apply recovery actions.
- **Sidecar workspace**: open files, runtime resources, task details, and workflow artifacts alongside the main view.

## Runtime Connection

The web app calls the Southstar runtime server through local Next.js route handlers.

Default runtime server:

```text
http://127.0.0.1:3100
```

Relevant variables:

- `SOUTHSTAR_SERVER_URL`
- `SOUTHSTAR_V2_API_BASE_URL`
- `NEXT_PUBLIC_SOUTHSTAR_SERVER_URL`

The full-stack launcher exports these automatically when it starts the web server.

## App Structure

```text
app/
  page.tsx                         # imports components/AppShell
  api/
    agent/                         # Pi AgentSession commands and SSE
    auth/                          # OAuth/API key status and login helpers
    files/                         # scoped file reads/previews
    models*/                       # model config and model testing
    sessions/                      # Pi session reads, context, rename/delete/export
    skills/                        # skill listing/search/install
    workflow/                      # Southstar workflow API proxies
    operator/                      # Southstar operator API proxies

components/
  AppShell.tsx                     # integrated chat/workflow/operator shell
  AppModeRail.tsx                  # mode switcher
  SessionSidebar.tsx               # chat/session/project navigation
  WorkflowSidebar.tsx              # workflow library/planner/run navigation
  ChatWindow.tsx                   # Pi chat UI and SSE reconnect
  WorkflowDagBlock.tsx             # workflow DAG block renderer
  WorkflowLaunchPreview.tsx        # launch preview
  WorkflowResourceViewer.tsx       # runtime resources and artifacts
  operator/                        # operator dashboard components
  workflow-canvas/                 # DAG canvas layout and nodes

lib/
  workflow/                        # runtime proxy helpers and workflow types
  operator/                        # operator read-model shaping
  rpc-manager.ts                   # Pi AgentSession lifecycle
  session-reader.ts                # read-only Pi session parsing
  file-access.ts                   # file access boundary
  markdown.ts                      # Markdown/Mermaid/KaTeX config
```

## Current UI Design Architecture

`app/page.tsx` renders `components/AppShell.tsx`. `AppShell` is intentionally the top-level integration point because chat, workflow, and operator modes share project cwd, sidecar state, selected resources, and top-level panels.

### Shell State

`AppShell` coordinates:

- Active mode: chat, workflow, operator.
- Selected chat session and restored `?session=` URL state.
- Workflow selected template/session state.
- Operator selected run/task/incident state.
- Sidecar tabs and mode: hidden, floating, pinned, expanded.
- Models, skills, and MCP configuration modals.
- Top bar panels for branches and session stats.

### Component Boundaries

Chat components own Pi session interaction and message rendering. Workflow components own manifest/draft/DAG presentation. Operator components own monitoring and recovery presentation. Shared file/resource viewing goes through the sidecar.

```text
AppShell
  +-- AppModeRail
  +-- SessionSidebar + ChatWindow
  +-- WorkflowSidebar + workflow canvas/profile/resource views
  +-- OperatorSidebar + OperatorWorkspace
  +-- SidecarShell + FileViewer/WorkflowResourceViewer/OperatorTaskTabs
```

### API Boundary

React components should call local route handlers under `app/api`. Those handlers proxy to the runtime server or read local Pi files as needed.

```text
React component
  -> Next route handler
  -> lib workflow/operator/session helper
  -> runtime server or local Pi session files
  -> React component
```

Do not call Postgres from browser components. Do not duplicate runtime URL construction in components.

## Data Flow

### Workflow UI

```text
Browser
  -> app/api/workflow/*
  -> Southstar runtime /api/v2/*
  -> Postgres workflow_runs/workflow_tasks/workflow_history/runtime_resources
  -> runtime UI/read-model response
  -> workflow components
```

Workflow routes are thin proxy/adapters. The durable truth lives in the runtime server and Postgres.

### Operator UI

```text
Browser
  -> app/api/operator/*
  -> runtime operator/read-model endpoints
  -> components/operator/*
```

The operator UI renders projected state: health, runs, attention items, incidents, artifacts, history, and available commands.

### Chat UI

```text
Browser
  -> app/api/sessions/*          # read-only session browsing
  -> ~/.pi/agent/sessions/*.jsonl

Browser
  -> app/api/agent/[id]          # active chat commands
  -> lib/rpc-manager.ts
  -> Pi AgentSession
```

Session browsing does not create an agent session. Sending a message creates or reuses an in-process `AgentSessionWrapper`.

## Development

```bash
npm run dev
npm run build
npm run lint
```

Use `npm run build` after changing imports, Next config, production route behavior, or dependency declarations.

If you see:

```text
Module not found: Can't resolve '@/components/AppShell'
```

first check that Next is running from this `web/` directory. `@/*` is mapped to `./*` in `web/tsconfig.json`, and `components/AppShell.tsx` is the intended app shell.

## Notes

- `package.json` still exposes the `pi-web` binary name for compatibility.
- The app still supports Pi session browsing and chat, but Southstar workflow/operator surfaces are first-class.
- Keep browser-facing routes free of secrets and raw token values.
- Prefer shared logic in `lib/` over duplicating request shaping inside route handlers.
