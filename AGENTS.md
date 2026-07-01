# AGENTS.md

This file guides Codex and other coding agents working in this repository.

## What Southstar Is

Southstar (`@southstar/runtime`) is a Postgres-backed, workflow-driven runtime for long-running multi-agent work. It owns workflow planning, canonical workflow manifests, task scheduling, Tork execution, session recovery, artifacts, memory, operator read models, and recovery actions.

Southstar is not just the old Northstar issue-to-PR control plane. The current active architecture is `src/v2/` plus the Next.js web app in `web/`.

## Runtime And Tooling

- Node `>=22.22.2` is required.
- The package is ESM (`"type": "module"`).
- TypeScript is run directly through `tsx` for scripts and tests; there is no compiled `dist/` build for the runtime.
- Runtime persistence is Postgres under the `southstar` schema. SQLite references are legacy or test-only unless a specific file says otherwise.
- The active web application is `web/`. The root Next app is retired; do not start or debug the UI from the repository root as a Next app.
- `@earendil-works/pi-coding-agent` is an optional dependency for Pi-backed planning/agent behavior. Tests should continue to work with fakes unless they explicitly require live integrations.

## Common Commands

```bash
npm install
npm test
npm run test:v2
npm run test:postgres

npm run southstar:start
npm run southstar:status
npm run southstar:stop

npm run southstar -- db:init --database-url postgres://postgres:postgres@127.0.0.1:55432/southstar
npm run southstar -- run-goal --goal "..."
```

Web app commands:

```bash
npm --prefix web install
npm --prefix web run dev
npm --prefix web run build
```

`npm run southstar:start` starts the managed local stack:

- Docker Postgres container `southstar-postgres`, using `SOUTHSTAR_DATABASE_URL` or the default `postgres://postgres:postgres@127.0.0.1:55432/southstar`.
- Tork on `http://127.0.0.1:8000`.
- Southstar runtime server on `http://127.0.0.1:3100`.
- Next.js web UI on `http://127.0.0.1:30141`.

The web lifecycle prefers `SOUTHSTAR_WEB_APP_DIR` when set, then `~/apps/southstar/web`, then `./web`. In this repo the intended app is `web/`.

Do not run `test:e2e:*`, `test:live`, or host/GitHub/Tork live scripts as routine verification unless the task explicitly calls for real infrastructure and credentials.

## Architecture

Southstar v2 has four main layers:

1. **CLI and lifecycle**: `src/v2/cli.ts`, `src/v2/server/infra-lifecycle.ts`, `runtime-server-lifecycle.ts`, and `web-server-lifecycle.ts` start and stop the local stack.
2. **Runtime server**: `src/v2/server/http-server.ts` and `src/v2/server/routes.ts` expose `/api/v2/*` endpoints for planning, runs, tasks, execution callbacks, runtime health, UI models, operator commands, and recovery flows.
3. **Control-plane storage and services**: `src/v2/db/schema.ts`, `stores/`, `work-items/`, `scheduler/`, `executor/`, `session/`, `memory/`, `exceptions/`, `artifacts/`, `context/`, and `evolution/` persist and advance runtime state.
4. **Web UI**: `web/app` and `web/components` render chat, workflow planning, and operator views. Web API routes proxy or adapt browser requests to the runtime server.

Important directories:

- `src/v2/db/` - Postgres schema initialization and schema validation.
- `src/v2/stores/` - Postgres workflow run/task/history/resource writes.
- `src/v2/manifests/` - `SouthstarWorkflowManifest` types, validation, and revision utilities.
- `src/v2/orchestration/` - prompt-to-workflow orchestration and library-constrained workflow composition.
- `src/v2/design-library/` - reusable workflow templates, recipes, validators, and library objects.
- `src/v2/executor/` - Tork provider, callbacks, bindings, reconciliation, and provider recovery actions.
- `src/v2/hands/` - hand providers that materialize workflow tasks into Tork/Pi-agent executions.
- `src/v2/session/` and `src/v2/session-recovery/` - durable session history, checkpoints, and recovery controller.
- `src/v2/memory/` and `src/v2/context/` - context packets, memory deltas, memory search, and task envelopes.
- `src/v2/exceptions/` - runtime exceptions, recovery decisions, approval services, and decision application.
- `src/v2/read-models/` and `src/v2/ui-api/` - browser/operator-facing projections.
- `web/` - the active Next.js UI.

## Current Program Design Architecture

The current source of truth is the code under `src/v2/`. Some older design docs still mention SQLite or Northstar issue lifecycles; treat those as historical context unless the current code or tests still exercise them.

### 1. Lifecycle And Process Model

`src/v2/cli.ts` is the user-facing command parser. The `start` command composes three lifecycle managers:

- `server/infra-lifecycle.ts` starts managed Postgres and Tork.
- `server/runtime-server-lifecycle.ts` launches `src/v2/cli.ts serve` as the runtime API process.
- `server/web-server-lifecycle.ts` launches the active Next.js app.

`serve` builds the runtime process by opening Postgres, creating the Tork executor provider, creating Pi planner/brain providers, wiring hand providers, and registering runtime loops.

### 2. Runtime API Boundary

`server/http-server.ts` owns HTTP server setup. `server/routes.ts` is the main `/api/v2/*` router and delegates to focused route modules:

- `ui-routes.ts` for UI page/read models.
- `run-lifecycle-routes.ts` for run pause/resume/cancel/commands.
- `session-routes.ts` for session events, checkpoints, and lineage.
- `memory-routes.ts` for memory deltas/search/invalidation.
- `execution-routes.ts` for executor job inspection/actions.
- `task-command-routes.ts` for retry/fork/reset/rollback/revision commands.
- `evolution-routes.ts` for learning/evolution control-center surfaces.
- `chat-routes.ts` for runtime-backed chat surfaces.

Keep route handlers thin. Business rules belong in `orchestration/`, `scheduler/`, `executor/`, `exceptions/`, `memory/`, `context/`, `stores/`, or `ui-api/`.

### 3. Workflow Composition Layer

Workflow creation is library-constrained:

- `orchestration/requirement-analyzer.ts` derives structured requirements.
- `orchestration/candidate-resolver.ts` finds approved library candidates.
- `orchestration/llm-composer.ts` asks the configured composer to produce a composition.
- `orchestration/composition-validator.ts` and `composition-repair-loop.ts` validate and repair composition output.
- `orchestration/composition-compiler.ts` compiles composition into a `SouthstarWorkflowManifest`.
- `manifests/validate.ts` validates the canonical manifest.
- `ui-api/postgres-run-api.ts` persists planner drafts and creates runs.

Generated manifests are not execution truth until validated and persisted.

### 4. Workflow Run Materialization

There are two creation paths:

- Planner drafts: `/api/v2/planner/drafts` -> `createPostgresPlannerDraft` -> `createPostgresRunFromDraft`.
- Work item intake: `/api/v2/work-items/intake` -> `/api/v2/work-items/materialize-run` -> `work-items/run-materialization.ts`.

Both paths converge on Postgres records:

- `workflow_runs` stores run status, current manifest, execution projection, snapshots, runtime context, and metrics.
- `workflow_tasks` stores each DAG node/task snapshot.
- `workflow_history` records append-only audit events.
- `runtime_resources` stores typed runtime resources such as planner drafts, context packets, task envelopes, executor bindings, approvals, recovery decisions, and memory artifacts.

### 5. Scheduling, Context, Brain, And Hand

`server/run-execution-controller.ts` moves a run into `scheduling`. Runtime loops then call scheduler services.

`scheduler/runnable-task-scheduler.ts` is the central task dispatcher:

1. Load the run manifest and task rows.
2. Skip non-pending tasks.
3. Check dependency artifacts.
4. Claim runnable tasks within manifest parallelism limits.
5. Build managed context using `context/managed-context-assembler.ts`.
6. Create session checkpoints through the session store.
7. Persist brain and hand bindings.
8. Enforce pre-execution tool proxy policy.
9. Submit work through the configured hand provider.

The brain provider decides intent; the hand provider provisions actual execution. This separation is load-bearing for recovery and provider replacement.

### 6. Tork Execution And Callback

`executor/tork-provider.ts` materializes hand/task execution into Tork jobs. `hands/tork-hand-provider.ts` maps workflow tasks to Tork-compatible task inputs.

The execution loop is:

```text
scheduler
  -> hand provider
  -> Tork job
  -> southstar-agent-runner
  -> /api/v2/executor/heartbeat
  -> /api/v2/tork/callback
  -> executor/postgres-tork-callback.ts
  -> history/resources/task snapshots
```

Callbacks do not bypass persistence. They append history, update task/run snapshots, write resources/artifacts, and feed completion/recovery gates.

### 7. Recovery And Operator Control

Exceptions and recoveries are first-class runtime resources:

- `exceptions/runtime-exception-controller.ts` records runtime exceptions.
- `exceptions/postgres-runtime-exceptions.ts` reads and writes exception resources.
- `exceptions/recovery-approval-service.ts` handles operator approval.
- `exceptions/recovery-decision-applier.ts` applies approved recovery actions.
- `executor/postgres-reconciler.ts` reconciles executor bindings with provider observations.

Operator UI should call runtime command routes rather than mutating data directly.

### 8. Read Models And UI API

The browser should not reconstruct workflow truth from raw tables. Use read models:

- `read-models/postgres-core.ts` for run/task/resource/history basics.
- `read-models/postgres-run-inspection.ts` for run inspection and runtime exceptions.
- `read-models/operator-*` for operator surfaces.
- `ui-api/postgres-task-envelope.ts` for task envelopes.
- `ui-api/read-models.ts` and `ui-api/page-models/` for page-level models.

Read models are projections. If projection output conflicts with persisted history/snapshots, investigate the projection before changing lifecycle truth.

## Data Flow

### Goal To Workflow Run

1. The browser calls `web/app/api/workflow/*`.
2. Web proxy helpers in `web/lib/workflow/v2-api.ts` call the runtime server at `SOUTHSTAR_V2_API_BASE_URL` or `SOUTHSTAR_SERVER_URL`.
3. Runtime routes call planner/orchestration services.
4. A canonical `SouthstarWorkflowManifest` is validated by `src/v2/manifests/validate.ts`.
5. A workflow run is persisted to `southstar.workflow_runs`, with tasks in `southstar.workflow_tasks` and append-only events in `southstar.workflow_history`.

### Run Execution

1. Scheduler/runtime services identify runnable tasks.
2. `executor/` creates executor bindings and submits work to Tork.
3. Tork runs `southstar-agent-runner` for individual tasks.
4. The runner calls back to `/api/v2/tork/callback` and sends heartbeat data to `/api/v2/executor/heartbeat`.
5. Callback handlers append history, update task/run snapshots, write artifacts/resources, and trigger completion gates.

### Operator And UI Read Models

1. Runtime state is stored in Postgres as normalized snapshots plus append-only history.
2. Read models in `src/v2/read-models/` and `src/v2/ui-api/` project that state into browser-friendly shapes.
3. `web/components/operator/*`, workflow canvas components, and resource viewers render those projections.

## Postgres Schema

The runtime schema is defined in `src/v2/db/schema.ts`.

Core tables:

- `southstar.work_items` - intake items and materialized run refs.
- `southstar.workflow_runs` - run-level snapshot and current manifest.
- `southstar.workflow_tasks` - task/node snapshots and executor/session refs.
- `southstar.workflow_history` - append-only runtime events.
- `southstar.runtime_resources` - context packets, executor bindings, memory deltas, approvals, recovery decisions, and other typed resources.
- `southstar.artifact_blobs` and `southstar.secure_blobs` - binary artifacts and encrypted secret payloads.
- `southstar.library_objects`, `library_edges`, `library_history`, `library_similarity_index` - design/workflow library state.
- `southstar.learning_nodes` and `learning_edges` - evolution and learning graph projections.

When deleting test workflow data, prefer deleting by `workflow_runs.id` and also remove run-scoped `runtime_resources` and `learning_nodes` before deleting runs. `workflow_tasks`, `workflow_history`, and `artifact_blobs` cascade from `workflow_runs`; `runtime_resources.run_id` uses `on delete set null`.

## Runtime Invariants

- `workflow_history` is append-only audit truth for runtime events.
- `workflow_runs.workflow_manifest_json` is the current canonical workflow manifest for a run.
- `workflow_tasks` is the task-level snapshot. Do not rely on one global `current_task_id`; workflows can be DAGs and may run tasks in parallel.
- External effects must be represented by persisted state/history before downstream code assumes them.
- Projection failures should not destroy lifecycle truth. UI/operator state is a projection over Postgres data.
- Secrets must not be written to history, logs, inspect output, prompts, or ordinary resources. Use secure blob/vault abstractions for secret material.
- Represent external commands as argv arrays inside runtime/platform code. Avoid shell-chained command strings except in lifecycle launcher code that already centralizes that behavior.

## Web App Notes

- `web/app/page.tsx` imports `AppShell` from `web/components/AppShell.tsx`. This is intentional: `AppShell` is the active integrated shell for chat, workflow, and operator modes.
- If Next reports `Module not found: Can't resolve '@/components/AppShell'`, first confirm the command is running from `web/` with `web/tsconfig.json` and `web/node_modules`, not from the retired root Next context.
- `web/package.json` still exposes the binary name `pi-web` for compatibility, but the app has Southstar-specific workflow and operator surfaces.

## Testing Guidance

- Use focused tests when changing one subsystem, for example `npm run test:postgres` for Postgres store behavior.
- Use `npm test` as the broad local gate.
- Use `npm --prefix web run build` when changing web routing, imports, or production-only behavior.
- Do not run real e2e or live host tests unless the user explicitly asks for those integrations.
