# Southstar

Southstar is a Postgres-backed runtime and web UI for long-running multi-agent workflows. It turns a goal into a canonical workflow manifest, persists workflow/task/session state, dispatches tasks through Tork, records artifacts and recovery events, and exposes browser/operator read models.

The current active system is `src/v2/` plus the Next.js app in `web/`.

## Quick Start

```bash
npm install
npm run southstar:start
```

Then open:

- Runtime API: `http://127.0.0.1:3100`
- Web UI: `http://127.0.0.1:30141`
- Tork: `http://127.0.0.1:8000`
- Tork Web Admin: `http://127.0.0.1:8100`
- Postgres: `postgres://postgres:postgres@127.0.0.1:55432/southstar`

Check status:

```bash
npm run southstar:status
```

Stop the local stack:

```bash
npm run southstar:stop
```

## What Starts Locally

`npm run southstar:start` starts:

1. Docker Postgres container `southstar-postgres`.
2. Tork standalone runtime on port `8000`.
3. Tork Web Admin container `southstar-tork-web` on port `8100`.
4. Southstar runtime server on port `3100`.
5. Southstar web UI on port `30141`.

The runtime reads configuration from environment variables:

- `SOUTHSTAR_DATABASE_URL` or `SOUTHSTAR_DB`
- `TORK_BASE_URL`
- `TORK_WEB_URL`
- `SOUTHSTAR_SERVER_URL`
- `SOUTHSTAR_CONTAINER_CALLBACK_BASE_URL`
- `SOUTHSTAR_REQUIRE_DOCKER`
- `PI_PLANNER_ENDPOINT`
- `SOUTHSTAR_PI_PLANNER_TIMEOUT_MS` for local Pi SDK planner/composer calls; default `600000`
- `CODEX_CLI_PATH`
- `SOUTHSTAR_WEB_APP_DIR` for the web app directory

Defaults are suitable for the managed local Docker stack.

## Architecture

```text
Browser
  |
  v
web/ Next.js app
  |
  | /api/workflow/*, /api/operator/* proxy/adapt requests
  v
Southstar runtime server (src/v2/server)
  |
  +--> planner/orchestration/design library
  +--> Postgres control-plane tables
  +--> scheduler/executor/recovery services
  |
  v
Tork
  |
  v
southstar-agent-runner task process
  |
  | callback + heartbeat
  v
Southstar runtime server
```

The web UI has four main surfaces:

- **Chat**: browse and continue Pi agent sessions, inspect files, and manage models/skills.
- **Workflow**: generate, validate, revise, and launch Southstar workflow manifests.
- **Library**: author local agent, skill, tool, MCP, generated profile, and workflow template files; import external library content through draft review; sync validated content to the Postgres design library graph; inspect graph relationships by domain/kind/status.
- **Operator**: monitor workflow runs, inspect tasks/artifacts/history, and apply recovery actions.

## Current Design Architecture

The latest code is organized around a durable Postgres control plane, a runtime API process, Tork-backed execution, and a Next.js web shell.

### Runtime Process

`src/v2/cli.ts` exposes `start`, `serve`, `run-goal`, `plan`, `run`, `status`, and inspection commands. `start` launches the managed local stack; `serve` creates the runtime API server.

At runtime startup:

1. `openSouthstarDb` validates the Postgres schema.
2. `createRuntimeServerLifecycle` builds the API server.
3. `TorkExecutorProvider` is configured for task execution.
4. Pi planner/brain providers are configured.
5. `createTorkHandProvider` is registered as the managed hand provider.
6. Runtime loops are registered for scheduling, reconciliation, recovery, memory/session work, and operator-facing background progress.

### Planner And Workflow Composition

Southstar uses a canonical `SouthstarWorkflowManifest` as run truth. The planner path is:

```text
goal prompt
  -> requirement analysis
  -> approved library candidate resolution
  -> workflow composition
  -> composition validation/repair
  -> manifest compilation
  -> manifest validation
  -> planner draft
  -> workflow run
```

The active composer mode is `llm`. The runtime no longer exposes a production
deterministic fixture composer or `llm-with-fixture-fallback` mode. Tests that
need deterministic plans use tests-only fixtures under `tests/v2/fixtures/` and
seed explicit graph primitives; production workflow generation must use the
Postgres library graph and LLM-generated node agent profiles.

Each composed DAG task carries a typed `nodePromptSpec`. This is the worker-facing
prompt contract for that node: `nodeType` (`plan`, `implement`, `verify`,
`repair`, `review`, `summary`, or `general`), requirements, boundaries,
deliverable documents, expected outputs, test cases, acceptance criteria, and
type-specific checks. The compiler stores it under task `promptInputs`, and
managed context renders it into the TaskEnvelope prompt and `context-packet.json`.

Relevant code:

- `src/v2/orchestration/*`
- `src/v2/design-library/*`
- `src/v2/manifests/*`
- `src/v2/ui-api/postgres-run-api.ts`

### Run And Task Execution

Run creation persists a run, tasks, history, and resources in Postgres. Execution then proceeds through scheduler and hand providers:

```text
workflow_runs(status=created)
  -> run.scheduling_started
  -> runnable task scheduler
  -> managed context packet + task envelope
  -> brain binding + hand binding
  -> Tork hand execution
  -> southstar-agent-runner
  -> heartbeat/callback
  -> artifact_ref + artifact_blob
  -> downstream node priorArtifacts
  -> history/resources/task snapshots
  -> completion or recovery gate
```

Task callbacks persist artifact refs and JSON artifact bodies. Direct downstream
tasks receive accepted upstream artifact content through managed context
`priorArtifacts`, so verifier, repair, review, and summary nodes can inspect
producer output rather than relying on summaries only.

Relevant code:

- `src/v2/server/run-execution-controller.ts`
- `src/v2/scheduler/runnable-task-scheduler.ts`
- `src/v2/context/managed-context-assembler.ts`
- `src/v2/session/postgres-session-store.ts`
- `src/v2/hands/tork-hand-provider.ts`
- `src/v2/executor/postgres-tork-callback.ts`
- `src/v2/evaluators/completion-gate.ts`

### Recovery And Operations

Southstar treats exceptions, approvals, and recovery decisions as durable runtime resources. Operator actions are routed through runtime command endpoints and applied by recovery services, not by direct UI table mutation.

Relevant code:

- `src/v2/exceptions/*`
- `src/v2/executor/postgres-reconciler.ts`
- `src/v2/server/task-command-routes.ts`
- `src/v2/server/run-lifecycle-routes.ts`
- `src/v2/read-models/operator-*`

### Web Shell

`web/app/page.tsx` renders `components/AppShell.tsx`. `AppShell` is the current integrated shell for:

- Chat/session browsing.
- Workflow planning and run launch.
- Operator monitoring and recovery.
- Sidecar file/resource/task inspection.

Web API routes proxy browser requests to the runtime server and keep browser components decoupled from runtime internals.

### Library Tab And Local Library Files

Southstar Library content is authored under `library/` as editable files and synced to the Postgres design library graph through the Library tab/API. Agents and skills use Markdown with YAML frontmatter; tools, MCP grants, generated profiles, and saved workflow templates use YAML. Runtime workflow generation reads the validated Postgres graph, not raw files.

The current Library flow is:

```text
local library file -> parse -> validate -> sync -> southstar.library_objects / library_edges
library chat/import -> import draft -> approve -> file write -> graph sync
workflow generate -> approved primitive candidates -> generated node profile -> validation -> planner draft
workflow DAG save -> generated profiles/template -> libraryVersionRefs -> graph sync
```

`web/components/library/*` renders the Library workspace: a compact domain/kind sidebar, center chat/SSE surface, graph message blocks, and a right file viewer/editor. The graph block calls `/api/v2/library/graph` with `scope`, `kind`, `status`, `objectKey`, and `depth` filters and renders the result as an in-app React/SVG chart.

Import commands create `library_import_draft` resources first. Approval writes proposed files under the configured library root and syncs those files into draft graph rows. Approval is explicit; LLM or prompt import output is never treated as approved graph truth by itself.

Workflow generation can compose per-node profiles from approved graph primitives. Saved workflow DAGs write generated profile YAML plus a workflow template YAML. The saved template records `libraryVersionRefs` from the selected graph objects' `headVersionId` values so later reuse can be audited against the exact agent/skill/tool/MCP versions used at save time.

## Data Flow

### Goal To Run

1. The browser sends a workflow request to `web/app/api/workflow/*`.
2. Web route helpers call the runtime server configured by `SOUTHSTAR_V2_API_BASE_URL` or `SOUTHSTAR_SERVER_URL`.
3. Runtime planner/orchestration code builds a `SouthstarWorkflowManifest`.
4. Manifest validation checks task DAGs, harnesses, evaluators, artifact schemas, and execution projections.
5. The runtime inserts a run into `southstar.workflow_runs`, tasks into `southstar.workflow_tasks`, and events into `southstar.workflow_history`.

### Task Execution

1. Scheduler services find runnable tasks.
2. Executor services create bindings and submit work to Tork.
3. Tork runs `southstar-agent-runner`.
4. The runner reports heartbeat and callback events to the runtime server.
5. Runtime callbacks append history, update snapshots, store resources/artifacts, and evaluate completion or recovery gates.

### Operator Read Models

1. Runtime truth stays in Postgres snapshots plus append-only history.
2. `src/v2/read-models/` and `src/v2/ui-api/` create browser-friendly projections.
3. `web/components/operator/*` and workflow canvas components render those projections.

## Postgres Tables

The schema lives in `src/v2/db/schema.ts`.

Core runtime tables:

- `southstar.work_items`
- `southstar.workflow_runs`
- `southstar.workflow_tasks`
- `southstar.workflow_history`
- `southstar.runtime_resources`
- `southstar.artifact_blobs`
- `southstar.secure_blobs`

Library/evolution tables:

- `southstar.library_objects`
- `southstar.library_edges`
- `southstar.library_history`
- `southstar.library_similarity_index`
- `southstar.learning_nodes`
- `southstar.learning_edges`

## Resetting Workflow Test Data

For a clean local workflow retest, delete unfinished/abnormal run-scoped data. Keep library/schema data intact.

Example shape:

```sql
begin;
create temp table cleanup_runs on commit drop as
  select id from southstar.workflow_runs where status <> 'completed';

delete from southstar.learning_nodes where run_id in (select id from cleanup_runs);
delete from southstar.runtime_resources where run_id in (select id from cleanup_runs);
delete from southstar.workflow_runs where id in (select id from cleanup_runs);
commit;
```

`workflow_tasks`, `workflow_history`, and `artifact_blobs` cascade from `workflow_runs`. `runtime_resources` should be deleted first because its `run_id` foreign key is `on delete set null`.

## Development

Runtime:

```bash
npm test
npm run test:v2
npm run test:postgres
```

Web:

```bash
npm --prefix web install
npm --prefix web run dev
npm --prefix web run build
```

The root Next app is retired. Run and debug the browser UI from `web/`.

Avoid routine live/e2e scripts unless explicitly testing real Tork, Docker, host agents, or external credentials.
